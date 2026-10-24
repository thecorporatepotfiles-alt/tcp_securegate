import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clock } from '../src/clock.js';
import { openDatabase } from '../src/db/connection.js';
import { migrate } from '../src/db/migrate.js';
import { ensureBaseline, seedDemo } from '../src/seed/demo.js';
import { verifyAuditChain } from '../src/services/audit.js';
import { freshPersonnel, gateId, locationId, record, setup, verify, type TestEnv } from './helpers.js';

let env: TestEnv;
beforeEach(() => {
  env = setup();
});
afterEach(() => {
  try {
    env.db.close();
  } catch {
    /* already closed */
  }
  clock.set(null);
});

const metric = (body: { metrics: { key: string; value: number }[] }, key: string) => body.metrics.find((m) => m.key === key)!.value;

describe('alerts (scenario 20)', () => {
  it('alerts can be acknowledged and resolved without deleting the underlying record', async () => {
    const guard = await env.as('alpha.guard');
    const v = await verify(guard, gateId(env.db, 'A1'), 'PERSONNEL', 'RF-NOTREAL1');
    expect(v.result).toBe('INVALID_CREDENTIAL');
    const alertRow = env.db.prepare('SELECT id FROM alerts WHERE verification_attempt_id = ?').get(v.attemptId) as { id: number };
    const admin = await env.as('alpha.admin');
    const ack = await admin.post(`/alerts/${alertRow.id}/acknowledge`, { note: 'Looking into it' });
    expect(ack.status).toBe(200);
    expect(ack.body.status).toBe('ACKNOWLEDGED');
    expect((await admin.post(`/alerts/${alertRow.id}/resolve`, {})).status).toBe(400);
    const res = await admin.post(`/alerts/${alertRow.id}/resolve`, { note: 'Holder used an old visitor card; briefed.' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('RESOLVED');
    expect(res.body.resolvedBy).toBeTruthy();
    expect(res.body.resolvedAt).toBeTruthy();
    expect(res.body.history.map((h: { action: string }) => h.action)).toEqual(['RAISED', 'ACKNOWLEDGED', 'RESOLVED']);
    expect(env.db.prepare('SELECT 1 FROM verification_attempts WHERE id = ?').get(v.attemptId)).toBeTruthy();
    expect((await admin.post(`/alerts/${alertRow.id}/resolve`, { note: 'again please' })).status).toBe(409);
    // Guards may view and acknowledge but not resolve.
    const g = await env.as('alpha.guard');
    expect((await g.post(`/alerts/${alertRow.id}/resolve`, { note: 'guard resolving' })).status).toBe(403);
  });

  it('alert rules are configurable', async () => {
    const admin = await env.as('admin');
    const settings = await admin.get('/admin/settings');
    const rules = settings.body.find((s: { key: string }) => s.key === 'alerts.rules').value;
    rules.INVALID_CREDENTIAL.enabled = false;
    await admin.put('/admin/settings/alerts.rules', { value: rules });
    const guard = await env.as('alpha.guard');
    const v = await verify(guard, gateId(env.db, 'A1'), 'PERSONNEL', 'RF-NOTREAL2');
    expect(env.db.prepare('SELECT 1 FROM alerts WHERE verification_attempt_id = ?').get(v.attemptId)).toBeUndefined();
  });
});

describe('administrative exceptions & handover (scenario 21)', () => {
  it('exceptions move Open → Under Review → Resolved with a required note and history', async () => {
    const admin = await env.as('alpha.admin');
    const x = await admin.post('/exceptions', {
      locationId: locationId(env.db, 'LOC-A'),
      category: 'RECORD_DISCREPANCY',
      title: 'Register mismatch',
      description: 'Paper tally differs from system count by one.',
      responsibleRole: 'LOCATION_ADMIN',
    });
    expect(x.status).toBe(200);
    expect(x.body.reference).toMatch(/^EX-/);
    expect((await admin.post(`/exceptions/${x.body.id}/status`, { status: 'UNDER_REVIEW', note: 'Checking CCTV log book' })).body.status).toBe('UNDER_REVIEW');
    expect((await admin.post(`/exceptions/${x.body.id}/status`, { status: 'RESOLVED' })).status).toBe(400);
    const r = await admin.post(`/exceptions/${x.body.id}/status`, { status: 'RESOLVED', note: 'Duplicate paper entry identified' });
    expect(r.body.status).toBe('RESOLVED');
    expect(r.body.resolvedBy).toBeTruthy();
    expect(r.body.history).toHaveLength(3);
    expect((await admin.post(`/exceptions/${x.body.id}/status`, { status: 'OPEN' })).status).toBe(422);
  });

  it('shift handover summarises open items and must be acknowledged by the incoming user', async () => {
    const guard = await env.as('alpha.guard');
    const summary = await guard.get('/handover/summary', { locationId: locationId(env.db, 'LOC-A') });
    expect(summary.status).toBe(200);
    expect(summary.body.summary).toHaveProperty('pendingApprovals');
    const guard2Id = (env.db.prepare("SELECT id FROM users WHERE username = 'alpha.guard2'").get() as { id: number }).id;
    const h = await guard.post('/handovers', { locationId: locationId(env.db, 'LOC-A'), shiftLabel: 'Day → Night', handedOverTo: guard2Id, notes: 'Quiet shift' });
    expect(h.status).toBe(200);
    expect((await guard.post(`/handovers/${h.body.id}/acknowledge`)).status).toBe(422);
    const g2 = await env.as('alpha.guard2');
    expect((await g2.post(`/handovers/${h.body.id}/acknowledge`)).status).toBe(200);
  });
});

describe('reports, exports & dashboard consistency (scenario 22)', () => {
  it('dashboard counts match report totals and persisted records', async () => {
    const admin = await env.as('admin');
    const dash = (await admin.get('/dashboard')).body;
    const active = await admin.get('/reports/active-visitors');
    expect(active.body.total).toBe(metric(dash, 'visitorsInside'));
    const failures = await admin.get('/reports/denied-verifications', { from: dash.filters.from, to: dash.filters.to });
    expect(failures.body.total).toBe(metric(dash, 'failedVerifications'));
    const inside = (env.db.prepare("SELECT COUNT(*) AS n FROM presence WHERE subject_type = 'PERSONNEL' AND state = 'INSIDE'").get() as { n: number }).n;
    expect(metric(dash, 'personnelInside')).toBe(inside);
    const presence = await admin.get('/presence', { category: 'PERSONNEL' });
    expect(presence.body.total).toBe(inside);
    const daily = await admin.get('/reports/daily-movement', { from: dash.filters.from, to: dash.filters.to, pageSize: 1 });
    const valid = await admin.get('/events', { from: dash.filters.from, to: dash.filters.to, pageSize: 1 });
    expect(daily.body.total).toBe(valid.body.total);
  });

  it('CSV export returns exactly the filtered rows and is audited', async () => {
    const guard = await env.as('alpha.guard');
    const p = freshPersonnel(env.db, 'LOC-A');
    const v = await verify(guard, gateId(env.db, 'A1'), 'PERSONNEL', p.credential);
    await record(guard, v.attemptId, 'ENTRY');
    const admin = await env.as('alpha.admin');
    const sn = (env.db.prepare('SELECT service_number AS s FROM personnel WHERE id = ?').get(p.personnelId) as { s: string }).s;
    const filters = { from: '2026-10-24', to: '2026-10-24', q: sn };
    const json = await admin.get('/reports/personnel-movement', filters);
    expect(json.body.total).toBeGreaterThan(0);
    const csv = await admin.get('/reports/personnel-movement/export', filters);
    expect(csv.status).toBe(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    const lines = csv.text.replace(/^﻿/, '').trim().split('\r\n');
    expect(lines).toHaveLength(json.body.total + 1);
    expect(lines.slice(1).every((l) => l.includes(sn))).toBe(true);
    expect(env.db.prepare("SELECT 1 FROM audit_events WHERE action = 'report.export'").get()).toBeTruthy();
    // Auditors can export; hosts cannot see reports at all.
    expect((await (await env.as('auditor')).get('/reports/daily-movement/export', filters)).status).toBe(200);
    expect((await (await env.as('alpha.host')).get('/reports/daily-movement')).status).toBe(403);
  });

  it('CSV export neutralises spreadsheet formulas', async () => {
    const admin = await env.as('alpha.admin');
    await admin.post('/exceptions', { locationId: locationId(env.db, 'LOC-A'), category: 'OTHER', title: '=HYPERLINK("http://x")', description: 'formula test' });
    const csv = await admin.get('/reports/admin-exceptions/export', { q: 'HYPERLINK' });
    expect(csv.text).toContain(`"'=HYPERLINK(""http://x"")"`);
  });

  it('report queries enforce location permissions', async () => {
    const alpha = await env.as('alpha.admin');
    const rows = await alpha.get('/reports/location-activity');
    expect(rows.body.items.map((r: { locationName: string }) => r.locationName)).toEqual(['Location Alpha']);
    expect((await alpha.get('/reports/gate-activity', { locationId: locationId(env.db, 'LOC-B') })).status).toBe(403);
  });
});

describe('audit trail (scenario 23)', () => {
  it('important actions appear in an intact, hash-chained audit trail', async () => {
    const guard = await env.as('alpha.guard');
    const p = freshPersonnel(env.db, 'LOC-A');
    const v = await verify(guard, gateId(env.db, 'A1'), 'PERSONNEL', p.credential);
    await record(guard, v.attemptId, 'ENTRY');
    const actions = (env.db.prepare('SELECT DISTINCT action FROM audit_events').all() as { action: string }[]).map((r) => r.action);
    expect(actions).toEqual(expect.arrayContaining(['auth.demo_login', 'gate.verify', 'movement.entry', 'visit.approve', 'credential.block', 'demo.seed']));
    const auditor = await env.as('auditor');
    const chain = await auditor.get('/audit/verify');
    expect(chain.body.ok).toBe(true);
    expect(chain.body.checked).toBeGreaterThan(10);
    const meta = env.db.prepare("SELECT metadata FROM audit_events WHERE action = 'gate.verify' ORDER BY id DESC LIMIT 1").get() as { metadata: string };
    expect(meta.metadata).not.toContain(p.credential);
  });

  it('detects tampering with audit records', () => {
    env.db.exec('DROP TRIGGER audit_events_no_update');
    env.db.prepare("UPDATE audit_events SET action = 'tampered' WHERE id = (SELECT MIN(id) + 3 FROM audit_events)").run();
    const result = verifyAuditChain(env.db);
    expect(result.ok).toBe(false);
    expect(result.brokenAtId).toBeTruthy();
  });

  it('never logs passwords or tokens', async () => {
    const c = env.anon();
    await c.post('/auth/login', { username: 'admin', password: 'Sup3rSecret-Password' });
    const rows = env.db.prepare('SELECT metadata FROM audit_events WHERE metadata IS NOT NULL').all() as { metadata: string }[];
    expect(rows.some((r) => r.metadata.includes('Sup3rSecret'))).toBe(false);
    expect(rows.some((r) => /SG[VTC]1\.[A-Za-z0-9_-]{22}\./.test(r.metadata))).toBe(false);
  });
});

describe('seed, persistence & demo reset (scenarios 24 & 28)', () => {
  it('scenario 28: demo seeding does not create duplicates', () => {
    const counts = () =>
      Object.fromEntries(
        ['personnel', 'credentials', 'visits', 'vehicles', 'deliveries', 'movement_events', 'users', 'locations', 'gates'].map((t) => [t, (env.db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n]),
      );
    const before = counts();
    const again = seedDemo(env.db, env.config);
    expect(again.seeded).toBe(false);
    expect(counts()).toEqual(before);
    // Even if the marker were removed, existing data prevents a second seed.
    env.db.prepare("DELETE FROM app_meta WHERE key = 'demo_seed_version'").run();
    expect(seedDemo(env.db, env.config).seeded).toBe(false);
    expect(counts()).toEqual(before);
  });

  it('scenario 24: database-backed changes survive an application restart', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-test-'));
    const file = path.join(dir, 'persist.db');
    const first = setup({ databaseFile: file });
    const admin = await first.as('alpha.admin');
    const created = await admin.post('/personnel', { serviceNumber: 'TCP-A-PERSIST', fullName: 'Persistent Record', locationId: locationId(first.db, 'LOC-A') });
    expect(created.status).toBe(200);
    first.db.close();
    const db = openDatabase(file);
    migrate(db);
    ensureBaseline(db);
    const row = db.prepare("SELECT full_name FROM personnel WHERE service_number = 'TCP-A-PERSIST'").get() as { full_name: string };
    expect(row.full_name).toBe('Persistent Record');
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('demo reset is restricted to authorized demo administrators', async () => {
    const local = await env.as('alpha.admin');
    expect((await local.post('/admin/demo/reset')).status).toBe(403);
    const admin = await env.as('admin');
    await admin.post('/personnel', { serviceNumber: 'TCP-A-RESETME', fullName: 'Reset Me', locationId: locationId(env.db, 'LOC-A') });
    const res = await admin.post('/admin/demo/reset');
    expect(res.status).toBe(200);
    expect(res.body.reloginRequired).toBe(true);
    expect(env.db.prepare("SELECT 1 FROM personnel WHERE service_number = 'TCP-A-RESETME'").get()).toBeUndefined();
    expect((await admin.get('/auth/me')).status).toBe(401);
    expect(verifyAuditChain(env.db).ok).toBe(true);
  });
});

describe('CSV export file name', () => {
  it('is stamped with the local date in the configured time zone', async () => {
    env.db.close();
    // 01:30 on 25 October in Asia/Kolkata is still 24 October in UTC.
    env = setup({ at: '2026-10-24T20:00:00.000Z' });
    const admin = await env.as('admin');
    const csv = await admin.get('/reports/daily-movement/export', { from: '2026-10-25', to: '2026-10-25' });
    expect(csv.status).toBe(200);
    expect(csv.headers['content-disposition']).toContain('securegate-daily-movement-2026-10-25.csv');
  });
});
