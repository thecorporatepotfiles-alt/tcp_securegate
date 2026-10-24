import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clock } from '../src/clock.js';
import { freshPersonnel, gateId, locationId, record, setup, userId, verify, type TestEnv } from './helpers.js';

let env: TestEnv;
beforeEach(() => {
  env = setup();
});
afterEach(() => {
  env.db.close();
  clock.set(null);
});

describe('vehicles', () => {
  it('scenario 15: a vehicle can be registered and its entry and exit recorded', async () => {
    const admin = await env.as('alpha.admin');
    const p = freshPersonnel(env.db, 'LOC-A');
    const reg = await admin.post('/vehicles', {
      registration: 'DM 01 ZZ 4242',
      category: 'CAR',
      makeModel: 'Test Sedan',
      ownerType: 'PERSONNEL',
      personnelId: p.personnelId,
      locationId: locationId(env.db, 'LOC-A'),
      authorizationStatus: 'AUTHORIZED',
    });
    expect(reg.status).toBe(200);
    expect(reg.body.registrationNumber).toBe('DM01ZZ4242');
    const dup = await admin.post('/vehicles', { registration: 'dm01zz-4242', category: 'CAR', ownerType: 'OTHER', locationId: locationId(env.db, 'LOC-A') });
    expect(dup.status).toBe(409);

    const guard = await env.as('alpha.guard2');
    const v = await verify(guard, gateId(env.db, 'A2'), 'VEHICLE', 'dm 01 zz 4242');
    expect(v.result).toBe('VERIFIED');
    const e = await record(guard, v.attemptId, 'ENTRY', { driverReference: 'Owner', purpose: 'Duty' });
    expect(e.status).toBe(200);
    const v2 = await verify(guard, gateId(env.db, 'A2'), 'VEHICLE', 'DM01ZZ4242');
    expect(v2.allowedActions).toEqual(['EXIT']);
    expect((await record(guard, v2.attemptId, 'EXIT')).status).toBe(200);
    const detail = await admin.get(`/vehicles/${reg.body.id}`);
    expect(detail.body.events).toHaveLength(2);
    expect(detail.body.presenceState).toBe('OUTSIDE');
  });

  it('scenario 16: vehicle movement remains separate from occupant movement', async () => {
    const admin = await env.as('alpha.admin');
    const p = freshPersonnel(env.db, 'LOC-A');
    const reg = await admin.post('/vehicles', { registration: 'DM 02 ZZ 1111', category: 'CAR', ownerType: 'PERSONNEL', personnelId: p.personnelId, locationId: locationId(env.db, 'LOC-A'), authorizationStatus: 'AUTHORIZED' });
    const guard = await env.as('alpha.guard2');
    const v = await verify(guard, gateId(env.db, 'A2'), 'VEHICLE', 'DM 02 ZZ 1111');
    await record(guard, v.attemptId, 'ENTRY', { linkedSubjectType: 'PERSONNEL', linkedSubjectId: p.personnelId, driverReference: 'Owner driving' });
    const vehiclePresence = env.db.prepare("SELECT state FROM presence WHERE subject_type = 'VEHICLE' AND subject_id = ?").get(reg.body.id) as { state: string };
    expect(vehiclePresence.state).toBe('INSIDE');
    const personPresence = env.db.prepare("SELECT state FROM presence WHERE subject_type = 'PERSONNEL' AND subject_id = ?").get(p.personnelId) as { state: string } | undefined;
    expect(personPresence?.state ?? 'NONE').not.toBe('INSIDE');
  });

  it('unregistered vehicles are registered at the gate as pending and require manual review', async () => {
    const guard = await env.as('alpha.guard2');
    const v = await verify(guard, gateId(env.db, 'A2'), 'VEHICLE', 'DM 77 QQ 7777');
    expect(v.result).toBe('UNREGISTERED_VEHICLE');
    const reg = await guard.post('/gate/vehicles', { gateId: gateId(env.db, 'A2'), registration: 'DM 77 QQ 7777', category: 'VAN', ownerType: 'OTHER', ownerName: 'Unknown supplier' });
    expect(reg.status).toBe(200);
    expect(reg.body.authorizationStatus).toBe('PENDING');
    const v2 = await verify(guard, gateId(env.db, 'A2'), 'VEHICLE', 'DM 77 QQ 7777');
    expect(v2.result).toBe('MANUAL_REVIEW_REQUIRED');
    expect(v2.allowedActions).toEqual([]);
  });

  it('partial updates do not reset authorization (regression)', async () => {
    const admin = await env.as('alpha.admin');
    const reg = await admin.post('/vehicles', { registration: 'DM 03 ZZ 3333', category: 'CAR', ownerType: 'OTHER', ownerName: 'X', locationId: locationId(env.db, 'LOC-A'), authorizationStatus: 'AUTHORIZED' });
    const upd = await admin.patch(`/vehicles/${reg.body.id}`, { notes: 'New note' });
    expect(upd.status).toBe(200);
    expect(upd.body.authorizationStatus).toBe('AUTHORIZED');
    const blocked = await admin.patch(`/vehicles/${reg.body.id}`, { authorizationStatus: 'BLOCKED', reason: 'Test' });
    expect(blocked.body.authorizationStatus).toBe('BLOCKED');
    const guard = await env.as('alpha.guard2');
    expect((await verify(guard, gateId(env.db, 'A2'), 'VEHICLE', 'DM 03 ZZ 3333')).result).toBe('BLOCKED_VEHICLE');
  });
});

describe('deliveries', () => {
  it('scenarios 13 & 14: arrival registered, authorized, receipt acknowledged (audited), departure recorded', async () => {
    const guard = await env.as('alpha.guard');
    const arrive = await guard.post('/gate/deliveries', {
      gateId: gateId(env.db, 'A3'),
      category: 'PARCEL',
      company: 'Test Couriers (Demo)',
      courierName: 'Courier Person',
      recipientUserId: userId(env.db, 'alpha.host'),
      recipientDepartment: 'Signals',
      description: 'Two boxes',
      itemCount: 2,
    });
    expect(arrive.status).toBe(200);
    expect(arrive.body.status).toBe('AWAITING_AUTHORIZATION');
    const id = arrive.body.id;
    const host = await env.as('alpha.host');
    const mine = await host.get('/deliveries', { mine: true });
    expect(mine.body.items.map((d: { id: number }) => d.id)).toContain(id);
    // Receipt cannot be acknowledged before authorization.
    expect((await host.post(`/deliveries/${id}/acknowledge`, {})).status).toBe(422);
    const auth = await host.post(`/deliveries/${id}/authorize`, { note: 'Expected parcel' });
    expect(auth.status).toBe(200);
    expect(auth.body.status).toBe('AUTHORIZED');

    // Courier entry through the shared verification pipeline.
    const v = await verify(guard, gateId(env.db, 'A3'), 'DELIVERY', arrive.body.reference);
    expect(v.result).toBe('VERIFIED');
    expect((await record(guard, v.attemptId, 'ENTRY')).status).toBe(200);

    const ack = await host.post(`/deliveries/${id}/acknowledge`, { receivedByName: 'Capt Neha Sharma', note: 'Received in good order' });
    expect(ack.status).toBe(200);
    expect(ack.body.status).toBe('RECEIVED');
    expect(ack.body.receivedByUser).toBe('Capt Neha Sharma');
    expect(ack.body.receivedAt).toBeTruthy();
    const audit = env.db.prepare("SELECT actor_username FROM audit_events WHERE action = 'delivery.receipt.acknowledge' AND entity_id = ?").get(String(id)) as { actor_username: string };
    expect(audit.actor_username).toBe('alpha.host');

    const depart = await guard.post(`/gate/deliveries/${id}/depart`, { gateId: gateId(env.db, 'A3') });
    expect(depart.status).toBe(200);
    expect(depart.body.status).toBe('DEPARTED');
    expect(depart.body.events.map((e: { eventType: string }) => e.eventType).sort()).toEqual(['ENTRY', 'EXIT']);
    expect((await guard.post(`/gate/deliveries/${id}/depart`, { gateId: gateId(env.db, 'A3') })).status).toBe(409);
  });

  it('a courier leaving without receipt requires a reason and marks the delivery returned', async () => {
    const guard = await env.as('alpha.guard');
    const arrive = await guard.post('/gate/deliveries', { gateId: gateId(env.db, 'A3'), category: 'FOOD', company: 'Food Co (Demo)', courierName: 'Rider', recipientDepartment: 'Mess', description: 'Lunch', itemCount: 1 });
    expect((await guard.post(`/gate/deliveries/${arrive.body.id}/depart`, { gateId: gateId(env.db, 'A3') })).status).toBe(400);
    const d = await guard.post(`/gate/deliveries/${arrive.body.id}/depart`, { gateId: gateId(env.db, 'A3'), reason: 'Recipient unavailable' });
    expect(d.body.status).toBe('RETURNED');
  });

  it('guards cannot authorize deliveries unless configured', async () => {
    const guard = await env.as('alpha.guard');
    const arrive = await guard.post('/gate/deliveries', { gateId: gateId(env.db, 'A3'), category: 'COURIER', company: 'X (Demo)', courierName: 'Y', recipientDepartment: 'Z', description: 'Envelope', itemCount: 1 });
    expect((await guard.post(`/deliveries/${arrive.body.id}/authorize`, {})).status).toBe(403);
  });

  it('incomplete acknowledgements raise an alert after the configured time', async () => {
    clock.advance(5 * 3_600_000);
    const admin = await env.as('admin');
    const res = await admin.post('/admin/run-checks');
    expect(res.status).toBe(200);
    expect((env.db.prepare("SELECT COUNT(*) AS n FROM alerts WHERE alert_type = 'INCOMPLETE_DELIVERY_ACK'").get() as { n: number }).n).toBeGreaterThan(0);
  });
});

describe('contractors & temporary access', () => {
  it('scenario 12: a contractor record can be searched and its history viewed', async () => {
    const admin = await env.as('alpha.admin');
    const company = await admin.get('/contractor-companies');
    const companyId = company.body.find((c: { status: string; category: string }) => c.status === 'ACTIVE' && c.category === 'CONTRACTOR').id;
    const c = await admin.post('/contractors', {
      companyId,
      fullName: 'Searchable Contractor',
      sponsoringDepartment: 'Works',
      purpose: 'Electrical inspection',
      locationId: locationId(env.db, 'LOC-A'),
      validFrom: '2026-10-01',
      validUntil: '2026-12-31',
      windowStart: '08:00',
      windowEnd: '18:00',
      allowedDays: '1111110',
    });
    expect(c.status).toBe(200);
    const found = await admin.get('/contractors', { q: 'Searchable' });
    expect(found.body.items.map((r: { id: number }) => r.id)).toContain(c.body.id);
    const byRef = await admin.get('/contractors', { q: c.body.reference });
    expect(byRef.body.total).toBe(1);

    const guard = await env.as('alpha.guard');
    const v = await verify(guard, gateId(env.db, 'A1'), 'CONTRACTOR', c.body.reference);
    expect(v.result).toBe('VERIFIED');
    await record(guard, v.attemptId, 'ENTRY');
    const detail = await admin.get(`/contractors/${c.body.id}`);
    expect(detail.body.events).toHaveLength(1);
    expect(detail.body.presenceState).toBe('INSIDE');

    // Partial update keeps the permitted-hours configuration (regression).
    const upd = await admin.patch(`/contractors/${c.body.id}`, { notes: 'Updated' });
    expect(upd.body.windowStart).toBe('08:00');
    expect(upd.body.allowedDays).toBe('1111110');
  });

  it('expired, cancelled, inactive and out-of-hours contractor access is rejected', async () => {
    const admin = await env.as('alpha.admin');
    const company = (await admin.get('/contractor-companies')).body.find((c: { status: string }) => c.status === 'ACTIVE').id;
    const base = { companyId: company, fullName: 'Hours Test', sponsoringDepartment: 'Works', purpose: 'Test', locationId: locationId(env.db, 'LOC-A') };
    const late = await admin.post('/contractors', { ...base, validFrom: '2026-10-01', validUntil: '2026-12-31', windowStart: '06:00', windowEnd: '09:00', allowedDays: '1111111' });
    const expired = await admin.post('/contractors', { ...base, fullName: 'Expired Test', validFrom: '2026-09-01', validUntil: '2026-10-01' });
    const guard = await env.as('alpha.guard');
    expect((await verify(guard, gateId(env.db, 'A1'), 'CONTRACTOR', late.body.reference)).result).toBe('OUTSIDE_PERMITTED_HOURS');
    expect((await verify(guard, gateId(env.db, 'A1'), 'CONTRACTOR', expired.body.reference)).result).toBe('EXPIRED_ACCESS');
    await admin.patch(`/contractors/${late.body.id}`, { status: 'CANCELLED', statusReason: 'Contract ended' });
    expect((await verify(guard, gateId(env.db, 'A1'), 'CONTRACTOR', late.body.reference)).result).toBe('INACTIVE_RECORD');
  });

  it('temporary access works until it expires or is revoked', async () => {
    const admin = await env.as('alpha.admin');
    const t = await admin.post('/temporary-access', {
      locationId: locationId(env.db, 'LOC-A'),
      holderType: 'INDIVIDUAL',
      holderName: 'Trainee Instructor',
      reason: 'Short course',
      validFrom: new Date(clock.nowMs() - 60_000).toISOString(),
      validUntil: new Date(clock.nowMs() + 2 * 3_600_000).toISOString(),
    });
    expect(t.status).toBe(200);
    const pass = await admin.get(`/temporary-access/${t.body.id}/pass`);
    expect(pass.body.token).toMatch(/^SGT1\./);
    const guard = await env.as('alpha.guard');
    const v = await verify(guard, gateId(env.db, 'A1'), 'TEMPORARY', pass.body.token);
    expect(v.result).toBe('VERIFIED');
    await record(guard, v.attemptId, 'ENTRY');
    const reg = await admin.get('/events', { category: 'TEMPORARY' });
    expect(reg.body.items.some((e: { subjectId: number }) => e.subjectId === t.body.id)).toBe(true);
    clock.advance(3 * 3_600_000);
    const guard2 = await env.as('alpha.guard');
    const late = await verify(guard2, gateId(env.db, 'A1'), 'TEMPORARY', pass.body.token);
    expect(late.result).toBe('EXPIRED_ACCESS');
    expect(late.allowedActions).toEqual(['EXIT']); // still allowed to leave
    const admin2 = await env.as('alpha.admin');
    await admin2.post(`/temporary-access/${t.body.id}/revoke`, { reason: 'Course ended' });
    expect((await verify(guard2, gateId(env.db, 'A1'), 'TEMPORARY', t.body.reference)).result).toBe('REVOKED_ACCESS');
  });
});
