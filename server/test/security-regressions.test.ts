/**
 * Regression tests for issues found in an independent authorization review.
 * Each test reproduces the original probe and asserts the corrected behaviour.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clock } from '../src/clock.js';
import { hashPassword, verifyPassword } from '../src/lib/crypto.js';
import { freshPersonnel, gateId, locationId, record, setup, userId, verify, type TestEnv } from './helpers.js';

let env: TestEnv;
beforeEach(() => {
  env = setup();
});
afterEach(() => {
  env.db.close();
  clock.set(null);
});

describe('location scope is enforced on every write path', () => {
  it('a location administrator cannot authorize personnel for another location', async () => {
    const alpha = await env.as('alpha.admin');
    const create = await alpha.post('/personnel', { serviceNumber: 'TCP-A-SEC1', fullName: 'Scope Test', locationId: locationId(env.db, 'LOC-A'), authorizedLocationIds: [locationId(env.db, 'LOC-B')] });
    expect(create.status).toBe(403);
    const p = freshPersonnel(env.db, 'LOC-A');
    const upd = await alpha.patch(`/personnel/${p.personnelId}`, { authorizedLocationIds: [locationId(env.db, 'LOC-B')] });
    expect(upd.status).toBe(403);
    const bravoGuard = await env.as('bravo.guard');
    expect((await verify(bravoGuard, gateId(env.db, 'B1'), 'PERSONNEL', p.credential)).result).toBe('WRONG_LOCATION');
    // A System Administrator can grant it.
    const admin = await env.as('admin');
    expect((await admin.patch(`/personnel/${p.personnelId}`, { authorizedLocationIds: [locationId(env.db, 'LOC-B')] })).status).toBe(200);
  });

  it('editing keeps authorizations the editor cannot see or change', async () => {
    const admin = await env.as('admin');
    const p = freshPersonnel(env.db, 'LOC-A');
    await admin.patch(`/personnel/${p.personnelId}`, { authorizedLocationIds: [locationId(env.db, 'HQ')] });
    const alpha = await env.as('alpha.admin');
    const upd = await alpha.patch(`/personnel/${p.personnelId}`, { authorizedLocationIds: [] });
    expect(upd.status).toBe(200);
    expect(upd.body.authorizedLocations.map((l: { code: string }) => l.code).sort()).toEqual(['HQ', 'LOC-A']);
  });

  it('missing-movement corrections cannot target records outside the corrector’s locations', async () => {
    const alpha = await env.as('alpha.admin');
    const bravoVisit = env.db.prepare("SELECT id FROM visits WHERE location_id = ? AND status = 'APPROVED' LIMIT 1").get(locationId(env.db, 'LOC-B')) as { id: number };
    const res = await alpha.post('/corrections/missing-event', {
      subjectType: 'VISITOR',
      subjectId: bravoVisit.id,
      eventType: 'ENTRY',
      gateId: gateId(env.db, 'A1'),
      reportedOccurredAt: new Date(clock.nowMs() - 60_000).toISOString(),
      reason: 'Cross-location probe',
    });
    expect(res.status).toBe(404);
    const bravoInside = env.db
      .prepare("SELECT pr.subject_id AS id FROM presence pr JOIN personnel p ON p.id = pr.subject_id WHERE pr.subject_type = 'PERSONNEL' AND pr.state = 'INSIDE' AND pr.location_id = ? AND NOT EXISTS (SELECT 1 FROM personnel_locations pl WHERE pl.personnel_id = p.id AND pl.location_id = ?) LIMIT 1")
      .get(locationId(env.db, 'LOC-B'), locationId(env.db, 'LOC-A')) as { id: number };
    const exit = await alpha.post('/corrections/missing-event', {
      subjectType: 'PERSONNEL',
      subjectId: bravoInside.id,
      eventType: 'EXIT',
      gateId: gateId(env.db, 'A1'),
      reportedOccurredAt: new Date(clock.nowMs() - 60_000).toISOString(),
      reason: 'Cross-location probe',
    });
    expect(exit.status).toBe(404);
  });

  it('a missing exit must be recorded at the location where the subject is inside', async () => {
    const hq = await env.as('hq.admin');
    const roles = await (await env.as('admin')).get('/admin/roles');
    const perms = roles.body.roles.find((r: { code: string }) => r.code === 'HQ_ADMIN').permissions;
    await (await env.as('admin')).put('/admin/roles/HQ_ADMIN', { permissions: [...perms, 'events.correct'] });
    const inside = env.db.prepare("SELECT subject_id AS id FROM presence WHERE subject_type = 'PERSONNEL' AND state = 'INSIDE' AND location_id = ? LIMIT 1").get(locationId(env.db, 'LOC-B')) as { id: number };
    const res = await hq.post('/corrections/missing-event', {
      subjectType: 'PERSONNEL',
      subjectId: inside.id,
      eventType: 'EXIT',
      gateId: gateId(env.db, 'A1'),
      reportedOccurredAt: new Date(clock.nowMs() - 60_000).toISOString(),
      reason: 'Wrong gate probe',
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INSIDE_ELSEWHERE');
  });

  it('organization-wide shared records cannot be changed by a location administrator when used elsewhere', async () => {
    const alpha = await env.as('alpha.admin');
    const shared = env.db
      .prepare('SELECT company_id AS id FROM contractors WHERE location_id <> ? LIMIT 1')
      .get(locationId(env.db, 'LOC-A')) as { id: number };
    expect((await alpha.patch(`/contractor-companies/${shared.id}`, { status: 'INACTIVE' })).status).toBe(403);
  });

  it('temporary access can only be issued to people within the issuer’s locations', async () => {
    const alpha = await env.as('alpha.admin');
    const bravoOnly = env.db
      .prepare('SELECT p.id FROM personnel p WHERE p.primary_location_id = ? AND p.status = \'ACTIVE\' AND NOT EXISTS (SELECT 1 FROM personnel_locations pl WHERE pl.personnel_id = p.id AND pl.location_id = ?) LIMIT 1')
      .get(locationId(env.db, 'LOC-B'), locationId(env.db, 'LOC-A')) as { id: number };
    const res = await alpha.post('/temporary-access', {
      locationId: locationId(env.db, 'LOC-A'),
      holderType: 'PERSONNEL',
      personnelId: bravoOnly.id,
      reason: 'Probe',
      validFrom: new Date(clock.nowMs()).toISOString(),
      validUntil: new Date(clock.nowMs() + 3_600_000).toISOString(),
    });
    expect(res.status).toBe(404);
  });

  it('referenced users (delivery recipient, exception owner, handover recipient) must be at the location', async () => {
    const alpha = await env.as('alpha.admin');
    const bravoHost = userId(env.db, 'bravo.host');
    const d = await alpha.post('/deliveries', { locationId: locationId(env.db, 'LOC-A'), category: 'PARCEL', company: 'X (Demo)', courierName: 'Y', recipientUserId: bravoHost, recipientDepartment: 'Z', description: 'Box', itemCount: 1 });
    expect(d.status).toBe(400);
    const x = await alpha.post('/exceptions', { locationId: locationId(env.db, 'LOC-A'), category: 'OTHER', title: 'T', description: 'D', responsibleUserId: bravoHost });
    expect(x.status).toBe(400);
    const h = await alpha.post('/handovers', { locationId: locationId(env.db, 'LOC-A'), shiftLabel: 'Day', handedOverTo: bravoHost });
    expect(h.status).toBe(400);
  });

  it('audit history of records without a location is limited to all-location users', async () => {
    const alpha = await env.as('alpha.admin');
    await env.as('bravo.admin');
    const bravoAdmin = userId(env.db, 'bravo.admin');
    const rows = await alpha.get('/audit/record', { entityType: 'user', entityId: String(bravoAdmin) });
    expect(rows.status).toBe(200);
    expect(rows.body).toEqual([]);
    const hq = await env.as('hq.admin');
    expect((await hq.get('/audit/record', { entityType: 'user', entityId: String(bravoAdmin) })).body.length).toBeGreaterThan(0);
  });
});

describe('workflow rules cannot be bypassed by clients', () => {
  it('a requester cannot waive an organization-wide security verification requirement', async () => {
    const admin = await env.as('admin');
    await admin.put('/admin/settings/visit.requireSecurityCheck', { value: true });
    const host = await env.as('alpha.host');
    const v = await host.post('/visits', {
      locationId: locationId(env.db, 'LOC-A'),
      visitor: { fullName: 'Waiver Probe' },
      approvingOfficerId: userId(env.db, 'alpha.officer'),
      purpose: 'Probe',
      destination: 'Admin Block',
      visitDate: '2026-10-24',
      arrivalTime: '12:00',
      departureTime: '14:00',
      requiresSecurityCheck: false,
    });
    expect(v.status).toBe(200);
    expect(v.body.requiresSecurityCheck).toBe(1);
    const officer = await env.as('alpha.officer');
    const approved = await officer.post(`/visits/${v.body.id}/approve`, {});
    expect(approved.body.passes).toHaveLength(0);
  });

  it('a credential blocked or a person deactivated after verification cannot be admitted', async () => {
    const guard = await env.as('alpha.guard');
    const admin = await env.as('alpha.admin');
    const p = freshPersonnel(env.db, 'LOC-A');
    const v = await verify(guard, gateId(env.db, 'A1'), 'PERSONNEL', p.credential);
    expect(v.result).toBe('VERIFIED');
    const credId = (env.db.prepare('SELECT id FROM credentials WHERE credential_number = ?').get(p.credential) as { id: number }).id;
    await admin.post(`/credentials/${credId}/status`, { action: 'BLOCK', reason: 'Blocked during verification window' });
    const res = await record(guard, v.attemptId, 'ENTRY');
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('RECORD_CHANGED');

    const q = freshPersonnel(env.db, 'LOC-A');
    const v2 = await verify(guard, gateId(env.db, 'A1'), 'PERSONNEL', q.credential);
    await admin.post(`/personnel/${q.personnelId}/status`, { status: 'INACTIVE', reason: 'Posted out' });
    expect((await record(guard, v2.attemptId, 'ENTRY')).status).toBe(409);
  });

  it('linked subjects on recorded movements must exist', async () => {
    const guard = await env.as('alpha.guard2');
    const veh = env.db.prepare("SELECT display_registration AS r FROM vehicles WHERE registered_location_id = ? AND authorization_status = 'AUTHORIZED' AND NOT EXISTS (SELECT 1 FROM presence pr WHERE pr.subject_type = 'VEHICLE' AND pr.subject_id = vehicles.id AND pr.state = 'INSIDE') LIMIT 1").get(locationId(env.db, 'LOC-A')) as { r: string };
    const v = await verify(guard, gateId(env.db, 'A2'), 'VEHICLE', veh.r);
    expect((await record(guard, v.attemptId, 'ENTRY', { linkedSubjectType: 'PERSONNEL', linkedSubjectId: 999999 })).status).toBe(404);
    expect((await record(guard, v.attemptId, 'ENTRY', { linkedSubjectType: 'PERSONNEL' })).status).toBe(400);
  });
});

describe('data minimization', () => {
  it('hosts can only look up visitors from visits they can open, and cannot overwrite contact details', async () => {
    const officer = await env.as('alpha.officer');
    const created = await officer.post('/visits', {
      locationId: locationId(env.db, 'LOC-A'),
      visitor: { fullName: 'Zephyrine Lookupprobe', phone: '+91 90000 77777', email: 'z@example.test' },
      approvingOfficerId: userId(env.db, 'alpha.host'),
      purpose: 'Probe',
      destination: 'Admin Block',
      visitDate: '2026-10-24',
      arrivalTime: '12:00',
      departureTime: '14:00',
    });
    expect(created.status).toBe(200);
    // alpha.host is the approver of that visit, so they can see it; a different host cannot.
    const admin = await env.as('admin');
    const newHost = await admin.post('/admin/users', { username: 'alpha.host2', displayName: 'Second Host', role: 'HOST', locationIds: [locationId(env.db, 'LOC-A')], password: 'Password12345' });
    expect(newHost.status).toBe(200);
    const agent = env.anon();
    await agent.post('/auth/login', { username: 'alpha.host2', password: 'Password12345' });
    const found = await agent.get('/lookups/visitors', { q: 'Lookupprobe' });
    expect(found.status).toBe(200);
    expect(found.body).toEqual([]);
    const visible = await (await env.as('alpha.host')).get('/lookups/visitors', { q: 'Lookupprobe' });
    expect(visible.body).toHaveLength(1);
  });

  it('QR tokens scanned in the wrong mode are never stored in readable form', async () => {
    const guard = await env.as('alpha.guard2');
    const token = 'SGV1.AAAAAAAAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBBBBBBBB';
    const v = await verify(guard, gateId(env.db, 'A2'), 'VEHICLE', token);
    const row = env.db.prepare('SELECT input_display FROM verification_attempts WHERE id = ?').get(v.attemptId) as { input_display: string };
    expect(row.input_display).not.toContain('AAAAAAAA');
  });
});

describe('password hashes', () => {
  it('a stored hash with an empty key part never verifies', async () => {
    const salt = hashPassword('pw').split('$')[4];
    const tampered = ['scrypt', 16384, 8, 1, salt, ''].join('$');
    expect(verifyPassword('anything', tampered)).toBe(false);
    // Signing in against such a record fails too.
    env.db.prepare('UPDATE users SET password_hash = ? WHERE username = ?').run(tampered, 'alpha.guard');
    const res = await env.anon().post('/auth/login', { username: 'alpha.guard', password: 'anything' });
    expect(res.status).toBe(401);
  });
});
