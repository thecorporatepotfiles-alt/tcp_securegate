import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clock } from '../src/clock.js';
import { freshPersonnel, gateId, locationId, record, setup, verify, type TestEnv } from './helpers.js';

let env: TestEnv;
beforeEach(() => {
  env = setup();
});
afterEach(() => {
  env.db.close();
  clock.set(null);
});

const presence = (personnelId: number) =>
  env.db.prepare("SELECT state, location_id FROM presence WHERE subject_type = 'PERSONNEL' AND subject_id = ?").get(personnelId) as
    | { state: string; location_id: number }
    | undefined;

describe('entry–exit recording', () => {
  it('verification alone does not change status; recording does (and exit updates it)', async () => {
    const guard = await env.as('alpha.guard');
    const p = freshPersonnel(env.db, 'LOC-A');
    const before = presence(p.personnelId)?.state ?? 'NONE';
    const v = await verify(guard, gateId(env.db, 'A1'), 'PERSONNEL', p.credential);
    expect(presence(p.personnelId)?.state ?? 'NONE').toBe(before);
    const e = await record(guard, v.attemptId, 'ENTRY');
    expect(e.status).toBe(200);
    expect(e.body.event.reference).toMatch(/^EV-/);
    expect(presence(p.personnelId)?.state).toBe('INSIDE');
    const v2 = await verify(guard, gateId(env.db, 'A1'), 'PERSONNEL', p.credential);
    expect(v2.allowedActions).toEqual(['EXIT']);
    await record(guard, v2.attemptId, 'EXIT');
    expect(presence(p.personnelId)?.state).toBe('OUTSIDE');
  });

  it('scenario 10: duplicate submissions are handled safely', async () => {
    const guard = await env.as('alpha.guard');
    const p = freshPersonnel(env.db, 'LOC-A');
    const v = await verify(guard, gateId(env.db, 'A1'), 'PERSONNEL', p.credential);
    const key = 'ik-duplicate-test-0001';
    const first = await record(guard, v.attemptId, 'ENTRY', { idempotencyKey: key });
    const replay = await record(guard, v.attemptId, 'ENTRY', { idempotencyKey: key });
    expect(replay.status).toBe(200);
    expect(replay.body.duplicate).toBe(true);
    expect(replay.body.event.id).toBe(first.body.event.id);
    const sameAttempt = await record(guard, v.attemptId, 'ENTRY');
    expect(sameAttempt.body.duplicate).toBe(true);
    const count = env.db.prepare("SELECT COUNT(*) AS n FROM movement_events WHERE subject_type = 'PERSONNEL' AND subject_id = ? AND event_type = 'ENTRY' AND recorded_at >= ?").get(p.personnelId, clock.nowIso()) as { n: number };
    expect(count.n).toBe(1);

    // A fresh verification while inside cannot record a second entry.
    const v2 = await verify(guard, gateId(env.db, 'A1'), 'PERSONNEL', p.credential);
    const dupEntry = await record(guard, v2.attemptId, 'ENTRY');
    expect(dupEntry.status).toBe(422);
  });

  it('detects inconsistent state across locations and raises an alert', async () => {
    const alphaGuard = await env.as('alpha.guard');
    const hqGuard = await env.as('hq.guard');
    const alpha = locationId(env.db, 'LOC-A');
    const hq = locationId(env.db, 'HQ');
    const row = env.db
      .prepare(
        `SELECT p.id, c.credential_number AS n FROM personnel p JOIN credentials c ON c.personnel_id = p.id AND c.status = 'ACTIVE'
         JOIN personnel_locations pl ON pl.personnel_id = p.id AND pl.location_id = ?
         WHERE p.primary_location_id = ? AND p.status = 'ACTIVE' AND (p.access_valid_until IS NULL OR p.access_valid_until > '2027-01-01')
         AND NOT EXISTS (SELECT 1 FROM presence pr WHERE pr.subject_type = 'PERSONNEL' AND pr.subject_id = p.id AND pr.state = 'INSIDE') LIMIT 1`,
      )
      .get(hq, alpha) as { id: number; n: string };
    const v = await verify(alphaGuard, gateId(env.db, 'A1'), 'PERSONNEL', row.n);
    await record(alphaGuard, v.attemptId, 'ENTRY');
    const atHq = await verify(hqGuard, gateId(env.db, 'HQ-G1'), 'PERSONNEL', row.n);
    expect(atHq.result).toBe('MANUAL_REVIEW_REQUIRED');
    expect(atHq.allowedActions).toEqual([]);
    expect(atHq.manualReviewEligible).toBe(true);
  });

  it('rejects exits without a recorded entry', async () => {
    const guard = await env.as('alpha.guard');
    const p = freshPersonnel(env.db, 'LOC-A');
    const v = await verify(guard, gateId(env.db, 'A1'), 'PERSONNEL', p.credential);
    const exit = await record(guard, v.attemptId, 'EXIT');
    expect(exit.status).toBe(422);
  });

  it('verifications expire before they can be recorded', async () => {
    const guard = await env.as('alpha.guard');
    const p = freshPersonnel(env.db, 'LOC-A');
    const v = await verify(guard, gateId(env.db, 'A1'), 'PERSONNEL', p.credential);
    clock.advance(10 * 60_000);
    const late = await record(guard, v.attemptId, 'ENTRY');
    expect(late.status).toBe(422);
    expect(late.body.error.code).toBe('VERIFICATION_EXPIRED');
  });

  it('another operator cannot record using someone else’s verification', async () => {
    const guard = await env.as('alpha.guard');
    const guard2 = await env.as('alpha.guard2');
    const p = freshPersonnel(env.db, 'LOC-A');
    const v = await verify(guard, gateId(env.db, 'A1'), 'PERSONNEL', p.credential);
    expect((await record(guard2, v.attemptId, 'ENTRY')).status).toBe(404);
  });

  it('raises a repeated-failure alert', async () => {
    const guard = await env.as('alpha.guard');
    for (let i = 0; i < 3; i++) await verify(guard, gateId(env.db, 'A1'), 'PERSONNEL', 'RF-DEADBEEF');
    const alert = env.db.prepare("SELECT occurrence_count FROM alerts WHERE alert_type = 'REPEATED_FAILED_VERIFICATION' AND status = 'OPEN' ORDER BY id DESC LIMIT 1").get();
    expect(alert).toBeTruthy();
  });
});

describe('manual review workflow', () => {
  it('denied verification cannot be bypassed; an authorized reviewer can approve one movement', async () => {
    const guard = await env.as('alpha.guard');
    const bravo = locationId(env.db, 'LOC-B');
    const cred = env.db
      .prepare(
        `SELECT c.credential_number AS n FROM credentials c JOIN personnel p ON p.id = c.personnel_id
         WHERE c.status = 'ACTIVE' AND p.status = 'ACTIVE' AND p.primary_location_id = ? AND (p.access_valid_until IS NULL OR p.access_valid_until > '2027-01-01')
         AND NOT EXISTS (SELECT 1 FROM personnel_locations pl WHERE pl.personnel_id = p.id AND pl.location_id <> ?)
         AND NOT EXISTS (SELECT 1 FROM presence pr WHERE pr.subject_type = 'PERSONNEL' AND pr.subject_id = p.id AND pr.state = 'INSIDE') LIMIT 1`,
      )
      .get(bravo, bravo) as { n: string };
    const v = await verify(guard, gateId(env.db, 'A1'), 'PERSONNEL', cred.n);
    expect(v.result).toBe('WRONG_LOCATION');
    expect((await record(guard, v.attemptId, 'ENTRY')).status).toBe(422);

    const req = await guard.post('/gate/manual-reviews', { attemptId: v.attemptId, requestedAction: 'ENTRY', note: 'Attending coordination meeting' });
    expect(req.status).toBe(200);
    expect(req.body.status).toBe('PENDING');
    expect((await record(guard, v.attemptId, 'ENTRY')).status).toBe(409);

    const decide = await env.as('alpha.admin');
    const ok = await decide.post(`/manual-reviews/${req.body.id}/decide`, { decision: 'APPROVED', note: 'Confirmed with host by phone' });
    expect(ok.status).toBe(200);
    const rec = await record(guard, v.attemptId, 'ENTRY');
    expect(rec.status).toBe(200);
    expect(rec.body.event.outcome).toBe('RECORDED_AFTER_REVIEW');
    const review = await decide.get(`/manual-reviews/${req.body.id}`);
    expect(review.body.status).toBe('USED');
    expect(env.db.prepare("SELECT 1 FROM audit_events WHERE action = 'gate.manual_review.approve'").get()).toBeTruthy();
  });

  it('blocked credentials are not eligible for manual review and requesters cannot decide their own review', async () => {
    const guard = await env.as('alpha.guard');
    const blocked = env.db.prepare("SELECT credential_number AS n FROM credentials WHERE status = 'BLOCKED' LIMIT 1").get() as { n: string };
    const v = await verify(guard, gateId(env.db, 'A1'), 'PERSONNEL', blocked.n);
    expect(v.manualReviewEligible).toBe(false);
    const req = await guard.post('/gate/manual-reviews', { attemptId: v.attemptId, requestedAction: 'ENTRY', note: 'Holder insists' });
    expect(req.status).toBe(422);

    const admin = await env.as('alpha.admin');
    const pending = (await admin.get('/manual-reviews', { status: 'PENDING' })).body.items[0];
    expect(pending).toBeTruthy();
    // The seeded pending review was requested by alpha.guard; guards lack decide permission entirely.
    expect((await guard.post(`/manual-reviews/${pending.id}/decide`, { decision: 'APPROVED', note: 'Self approval' })).status).toBe(403);
  });
});

describe('authorized corrections preserve history', () => {
  it('voiding an event keeps the original, recomputes status and is audited', async () => {
    const guard = await env.as('alpha.guard');
    const p = freshPersonnel(env.db, 'LOC-A');
    const v = await verify(guard, gateId(env.db, 'A1'), 'PERSONNEL', p.credential);
    const e = await record(guard, v.attemptId, 'ENTRY');
    expect(presence(p.personnelId)?.state).toBe('INSIDE');
    const admin = await env.as('alpha.admin');
    expect((await admin.post(`/events/${e.body.event.id}/void`, {})).status).toBe(400);
    const voided = await admin.post(`/events/${e.body.event.id}/void`, { reason: 'Recorded against wrong person' });
    expect(voided.status).toBe(200);
    expect(voided.body.event.voided).toBe(1);
    const original = env.db.prepare('SELECT * FROM movement_events WHERE id = ?').get(e.body.event.id);
    expect(original).toBeTruthy();
    expect(presence(p.personnelId)?.state ?? 'NONE').not.toBe('INSIDE');
    expect((await admin.post(`/events/${e.body.event.id}/void`, { reason: 'Again' })).status).toBe(409);
    expect(env.db.prepare("SELECT 1 FROM audit_events WHERE action = 'movement.correction.void'").get()).toBeTruthy();
    // Guards cannot correct events.
    expect((await guard.post(`/events/${e.body.event.id}/void`, { reason: 'try' })).status).toBe(403);
  });

  it('a missing exit can be recorded as a marked correction entry', async () => {
    const guard = await env.as('alpha.guard');
    const p = freshPersonnel(env.db, 'LOC-A');
    const v = await verify(guard, gateId(env.db, 'A1'), 'PERSONNEL', p.credential);
    await record(guard, v.attemptId, 'ENTRY');
    const admin = await env.as('alpha.admin');
    const res = await admin.post('/corrections/missing-event', {
      subjectType: 'PERSONNEL',
      subjectId: p.personnelId,
      eventType: 'EXIT',
      gateId: gateId(env.db, 'A1'),
      reportedOccurredAt: new Date(clock.nowMs() - 60_000).toISOString(),
      reason: 'Exit not recorded during power outage (synthetic)',
    });
    expect(res.status).toBe(200);
    expect(res.body.event.outcome).toBe('CORRECTION_ENTRY');
    expect(presence(p.personnelId)?.state).toBe('OUTSIDE');
  });

  it('movement events and audit records are append-only at the database level', () => {
    const anyEvent = env.db.prepare('SELECT id FROM movement_events LIMIT 1').get() as { id: number };
    expect(() => env.db.prepare("UPDATE movement_events SET event_type = 'EXIT' WHERE id = ?").run(anyEvent.id)).toThrow(/append-only/);
    expect(() => env.db.prepare('DELETE FROM movement_events WHERE id = ?').run(anyEvent.id)).toThrow(/append-only/);
    expect(() => env.db.prepare("UPDATE audit_events SET action = 'x'").run()).toThrow(/append-only/);
    expect(() => env.db.prepare('DELETE FROM audit_events').run()).toThrow(/append-only/);
  });

  it('presence always equals the latest valid event (derived, never edited)', () => {
    const mismatches = env.db
      .prepare(
        `SELECT COUNT(*) AS n FROM presence pr JOIN movement_events e ON e.id = (
            SELECT MAX(e2.id) FROM movement_events e2 WHERE e2.subject_type = pr.subject_type AND e2.subject_id = pr.subject_id
              AND NOT EXISTS (SELECT 1 FROM event_corrections c WHERE c.voided_event_id = e2.id))
         WHERE pr.state <> CASE e.event_type WHEN 'ENTRY' THEN 'INSIDE' ELSE 'OUTSIDE' END`,
      )
      .get() as { n: number };
    expect(mismatches.n).toBe(0);
  });
});
