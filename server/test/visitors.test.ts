import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clock } from '../src/clock.js';
import { gateId, locationId, record, setup, userId, verify, type TestEnv } from './helpers.js';

let env: TestEnv;
beforeEach(() => {
  env = setup();
});
afterEach(() => {
  env.db.close();
  clock.set(null);
});

/** Today in establishment time is 2026-10-24 (T0 = 11:30 IST). */
const TODAY = '2026-10-24';

async function hostCreates(overrides: Record<string, unknown> = {}) {
  const host = await env.as('alpha.host');
  const res = await host.post('/visits', {
    locationId: locationId(env.db, 'LOC-A'),
    visitor: { fullName: 'Rhea Test Visitor', company: 'Example Consulting (Demo)', phone: '+91 90000 11111' },
    approvingOfficerId: userId(env.db, 'alpha.officer'),
    purpose: 'Project review',
    destination: 'Admin Block',
    visitDate: TODAY,
    arrivalTime: '11:00',
    departureTime: '15:00',
    ...overrides,
  });
  return { host, res };
}

async function passToken(c: Awaited<ReturnType<TestEnv['as']>>, visitId: number) {
  const p = await c.get(`/visits/${visitId}/pass`);
  expect(p.status).toBe(200);
  return p.body as { token: string; qrSvg: string; status: string };
}

describe('visitor request & approval workflow', () => {
  it('scenarios 4–6, 8, 9: request → approval → QR pass → recorded entry → exit', async () => {
    const { host, res } = await hostCreates();
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('EXPECTED');
    const visitId = res.body.id;

    // Approving officer is notified and approves.
    const officer = await env.as('alpha.officer');
    const queue = await officer.get('/visits', { approvalQueue: true });
    expect(queue.body.items.map((v: { id: number }) => v.id)).toContain(visitId);
    const notif = await officer.get('/notifications');
    expect(notif.body.items.some((n: { type: string }) => n.type === 'VISIT_APPROVAL_REQUESTED')).toBe(true);
    const approve = await officer.post(`/visits/${visitId}/approve`, { reason: 'Expected' });
    expect(approve.status).toBe(200);
    expect(approve.body.status).toBe('APPROVED');
    expect(approve.body.approval.decision).toBe('APPROVED');
    expect(approve.body.approval.reviewer).toBeTruthy();
    expect(approve.body.passes).toHaveLength(1);

    // The pass QR contains an opaque token only.
    const pass = await passToken(host, visitId);
    expect(pass.token).toMatch(/^SGV1\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{22}$/);
    expect(pass.token).not.toContain('Rhea');
    expect(pass.qrSvg).toContain('<svg');

    // A successful scan alone does not record entry.
    const guard = await env.as('alpha.guard');
    const v = await verify(guard, gateId(env.db, 'A1'), 'VISITOR', pass.token);
    expect(v.result).toBe('VERIFIED');
    expect(v.allowedActions).toEqual(['ENTRY']);
    expect((await host.get(`/visits/${visitId}`)).body.status).toBe('APPROVED');

    const entry = await record(guard, v.attemptId, 'ENTRY');
    expect(entry.status).toBe(200);
    const afterEntry = await host.get(`/visits/${visitId}`);
    expect(afterEntry.body.status).toBe('INSIDE');
    expect(afterEntry.body.events).toHaveLength(1);
    const hostNotified = await host.get('/notifications');
    expect(hostNotified.body.items.some((n: { type: string }) => n.type === 'VISITOR_ENTERED')).toBe(true);

    const v2 = await verify(guard, gateId(env.db, 'A1'), 'VISITOR', pass.token);
    expect(v2.allowedActions).toEqual(['EXIT']);
    const exit = await record(guard, v2.attemptId, 'EXIT');
    expect(exit.status).toBe(200);
    const afterExit = await host.get(`/visits/${visitId}`);
    expect(afterExit.body.status).toBe('EXITED');
    expect(afterExit.body.passes[0].status).toBe('USED');

    const v3 = await verify(guard, gateId(env.db, 'A1'), 'VISITOR', pass.token);
    expect(v3.result).toBe('ALREADY_USED');
  });

  it('enforces segregation of duties: a requester cannot approve their own request', async () => {
    const host = await env.as('alpha.officer');
    const res = await host.post('/visits', {
      locationId: locationId(env.db, 'LOC-A'),
      visitor: { fullName: 'Self Approval Test' },
      approvingOfficerId: userId(env.db, 'alpha.officer'),
      purpose: 'Test',
      destination: 'Admin Block',
      visitDate: TODAY,
      arrivalTime: '12:00',
      departureTime: '13:00',
    });
    expect(res.status).toBe(400);
  });

  it('only the assigned approving officer can decide, and only once', async () => {
    const { res } = await hostCreates();
    const other = await env.as('bravo.officer');
    expect((await other.post(`/visits/${res.body.id}/approve`, {})).status).toBe(404);
    const officer = await env.as('alpha.officer');
    expect((await officer.post(`/visits/${res.body.id}/approve`, {})).status).toBe(200);
    const again = await officer.post(`/visits/${res.body.id}/approve`, {});
    expect(again.status).toBe(409);
    const reject = await officer.post(`/visits/${res.body.id}/reject`, { reason: 'Changed mind' });
    expect(reject.status).toBe(409);
  });

  it('scenario 5: rejected requests require a reason and never produce a valid pass', async () => {
    const { host, res } = await hostCreates();
    const officer = await env.as('alpha.officer');
    expect((await officer.post(`/visits/${res.body.id}/reject`, {})).status).toBe(400);
    const r = await officer.post(`/visits/${res.body.id}/reject`, { reason: 'Insufficient justification' });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('REJECTED');
    expect(r.body.passes).toHaveLength(0);
    expect((await host.get(`/visits/${res.body.id}/pass`)).status).toBe(404);
    const guard = await env.as('alpha.guard');
    const ref = res.body.reference;
    expect((await verify(guard, gateId(env.db, 'A1'), 'VISITOR', ref)).result).toBe('NOT_APPROVED');
  });

  it('scenario 7: cancelled and expired passes are rejected', async () => {
    const { host, res } = await hostCreates();
    const officer = await env.as('alpha.officer');
    await officer.post(`/visits/${res.body.id}/approve`, {});
    const pass = await passToken(host, res.body.id);
    const cancel = await host.post(`/visits/${res.body.id}/cancel`, { reason: 'Meeting moved' });
    expect(cancel.status).toBe(200);
    expect(cancel.body.passes[0].status).toBe('REVOKED');
    const guard = await env.as('alpha.guard');
    expect((await verify(guard, gateId(env.db, 'A1'), 'VISITOR', pass.token)).result).toBe('CANCELLED_PASS');

    // Expiry: approve another visit, then move past its validity window.
    const second = await hostCreates({ visitor: { fullName: 'Expiry Test Visitor' } });
    await officer.post(`/visits/${second.res.body.id}/approve`, {});
    const pass2 = await passToken(host, second.res.body.id);
    clock.advance(6 * 3_600_000); // 17:30 IST; pass valid until 15:00 + 60 min grace
    const guard2 = await env.as('alpha.guard');
    expect((await verify(guard2, gateId(env.db, 'A1'), 'VISITOR', pass2.token)).result).toBe('EXPIRED_PASS');
    const admin = await env.as('admin');
    await admin.post('/admin/run-checks');
    const expired = await (await env.as('alpha.host')).get(`/visits/${second.res.body.id}`);
    expect(expired.body.status).toBe('EXPIRED');
  });

  it('rejects forged tokens, other locations and passes that are not yet valid', async () => {
    const guard = await env.as('alpha.guard');
    const forged = await verify(guard, gateId(env.db, 'A1'), 'VISITOR', 'SGV1.AAAAAAAAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBBBBBBBB');
    expect(forged.result).toBe('INVALID_PASS');
    const alert = env.db.prepare("SELECT * FROM alerts WHERE alert_type = 'INVALID_QR' ORDER BY id DESC LIMIT 1").get();
    expect(alert).toBeTruthy();

    const { host, res } = await hostCreates({ arrivalTime: '18:00', departureTime: '19:00' });
    const officer = await env.as('alpha.officer');
    await officer.post(`/visits/${res.body.id}/approve`, {});
    const pass = await passToken(host, res.body.id);
    expect((await verify(guard, gateId(env.db, 'A1'), 'VISITOR', pass.token)).result).toBe('NOT_YET_VALID');
    const bravoGuard = await env.as('bravo.guard');
    expect((await verify(bravoGuard, gateId(env.db, 'B1'), 'VISITOR', pass.token)).result).toBe('WRONG_LOCATION');
  });

  it('security verification step gates pass generation when required', async () => {
    const { host, res } = await hostCreates({ requiresSecurityCheck: true });
    const officer = await env.as('alpha.officer');
    const a = await officer.post(`/visits/${res.body.id}/approve`, {});
    expect(a.body.status).toBe('APPROVED');
    expect(a.body.passes).toHaveLength(0);
    const guard = await env.as('alpha.guard');
    expect((await verify(guard, gateId(env.db, 'A1'), 'VISITOR', res.body.reference)).result).toBe('NOT_APPROVED');
    const admin = await env.as('alpha.admin');
    const sc = await admin.post(`/visits/${res.body.id}/security-check`, { note: 'Checked per procedure' });
    expect(sc.status).toBe(200);
    expect(sc.body.passes).toHaveLength(1);
    const pass = await passToken(host, res.body.id);
    expect((await verify(guard, gateId(env.db, 'A1'), 'VISITOR', pass.token)).result).toBe('VERIFIED');
  });

  it('server enforces configured transitions', async () => {
    const admin = await env.as('admin');
    const settings = await admin.get('/admin/settings');
    const transitions = settings.body.find((s: { key: string }) => s.key === 'visit.transitions').value;
    transitions.EXPECTED = transitions.EXPECTED.filter((s: string) => s !== 'CANCELLED');
    expect((await admin.put('/admin/settings/visit.transitions', { value: transitions })).status).toBe(200);
    const { host, res } = await hostCreates();
    const cancel = await host.post(`/visits/${res.body.id}/cancel`, { reason: 'No longer needed' });
    expect(cancel.status).toBe(422);
    expect(cancel.body.error.code).toBe('INVALID_TRANSITION');
  });
});

describe('walk-in visitors, host acknowledgement & waiting list', () => {
  it('scenario 17: walk-in → host notified → acknowledged → approved; waiting list shows pending visitors', async () => {
    const guard = await env.as('alpha.guard');
    const w = await guard.post('/gate/walk-in', {
      gateId: gateId(env.db, 'A1'),
      visitor: { fullName: 'Walk In Person', phone: '+91 90000 22222' },
      hostUserId: userId(env.db, 'alpha.officer'),
      purpose: 'Delivery of documents',
      destination: 'Admin Block',
      departureTime: '16:00',
    });
    expect(w.status).toBe(200);
    expect(w.body.status).toBe('HOST_NOTIFIED');

    const officer = await env.as('alpha.officer');
    const waiting = await officer.get('/visits/waiting-list');
    expect(waiting.body.groups.awaitingHostAcknowledgement.map((v: { id: number }) => v.id)).toContain(w.body.id);
    expect(waiting.body.counts.awaitingAuthorization).toBeGreaterThan(0);

    // Guard cannot enter an unapproved walk-in.
    const v = await verify(guard, gateId(env.db, 'A1'), 'VISITOR', w.body.reference);
    expect(v.result).toBe('NOT_APPROVED');

    const ack = await officer.post(`/visits/${w.body.id}/acknowledge`);
    expect(ack.body.status).toBe('WAITING');
    const ap = await officer.post(`/visits/${w.body.id}/approve`, {});
    expect(ap.body.status).toBe('APPROVED');
    const v2 = await verify(guard, gateId(env.db, 'A1'), 'VISITOR', w.body.reference, 'REFERENCE');
    expect(v2.result).toBe('VERIFIED');
  });

  it('marks overdue visitors and raises an overstay alert', async () => {
    const { res } = await hostCreates({ arrivalTime: '11:00', departureTime: '12:00' });
    const officer = await env.as('alpha.officer');
    await officer.post(`/visits/${res.body.id}/approve`, {});
    const guard = await env.as('alpha.guard');
    const v = await verify(guard, gateId(env.db, 'A1'), 'VISITOR', res.body.reference);
    await record(guard, v.attemptId, 'ENTRY');
    clock.advance(2 * 3_600_000);
    const admin = await env.as('admin');
    const checks = await admin.post('/admin/run-checks');
    expect(checks.body.overdueVisits).toBeGreaterThan(0);
    const visit = await admin.get(`/visits/${res.body.id}`);
    expect(visit.body.status).toBe('OVERDUE');
    expect(env.db.prepare("SELECT 1 FROM alerts WHERE alert_type = 'VISITOR_OVERSTAY' AND related_id = ?").get(res.body.id)).toBeTruthy();
    // Overdue visitors can still exit.
    const guard2 = await env.as('alpha.guard');
    const v2 = await verify(guard2, gateId(env.db, 'A1'), 'VISITOR', res.body.reference);
    expect(v2.allowedActions).toEqual(['EXIT']);
    expect((await record(guard2, v2.attemptId, 'EXIT')).status).toBe(200);
    expect((await admin.get(`/visits/${res.body.id}`)).body.status).toBe('EXITED');
  });

  it('hosts see only their own visits; pass tokens are restricted', async () => {
    const { res } = await hostCreates();
    const otherHost = await env.as('bravo.host');
    expect((await otherHost.get(`/visits/${res.body.id}`)).status).toBe(404);
    const auditor = await env.as('auditor');
    expect((await auditor.get(`/visits/${res.body.id}`)).status).toBe(200);
    const officer = await env.as('alpha.officer');
    await officer.post(`/visits/${res.body.id}/approve`, {});
    expect((await auditor.get(`/visits/${res.body.id}/pass`)).status).toBe(403);
  });
});
