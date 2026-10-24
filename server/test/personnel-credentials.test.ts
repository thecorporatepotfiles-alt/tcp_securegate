import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clock } from '../src/clock.js';
import { freshPersonnel, gateId, locationId, setup, verify, type TestEnv } from './helpers.js';

let env: TestEnv;
beforeEach(() => {
  env = setup();
});
afterEach(() => {
  env.db.close();
  clock.set(null);
});

async function createPerson(serviceNumber = 'TCP-A-90001') {
  const admin = await env.as('alpha.admin');
  const res = await admin.post('/personnel', {
    serviceNumber,
    fullName: 'Test Person Alpha',
    rank: 'Nk',
    unit: 'Alpha Signals Wing',
    department: 'Signals',
    locationId: locationId(env.db, 'LOC-A'),
    authorizedLocationIds: [locationId(env.db, 'HQ')],
  });
  return { admin, res };
}

describe('personnel management', () => {
  it('scenario 1: an administrator creates a synthetic personnel record (audited)', async () => {
    const { res } = await createPerson();
    expect(res.status).toBe(200);
    expect(res.body.serviceNumber).toBe('TCP-A-90001');
    expect(res.body.authorizedLocations.map((l: { code: string }) => l.code).sort()).toEqual(['HQ', 'LOC-A']);
    const audit = env.db.prepare("SELECT * FROM audit_events WHERE action = 'personnel.create' AND entity_ref = 'TCP-A-90001'").get();
    expect(audit).toBeTruthy();
  });

  it('prevents duplicate personnel IDs', async () => {
    await createPerson();
    const { res } = await createPerson();
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('DUPLICATE_PERSONNEL_ID');
  });

  it('partial updates keep fields that were not sent', async () => {
    const { admin, res } = await createPerson();
    const upd = await admin.patch(`/personnel/${res.body.id}`, { notes: 'Updated note' });
    expect(upd.status).toBe(200);
    expect(upd.body.notes).toBe('Updated note');
    expect(upd.body.authorizedLocations).toHaveLength(2);
    expect(upd.body.unit).toBe('Alpha Signals Wing');
  });

  it('search finds personnel by name, ID and credential number', async () => {
    const admin = await env.as('admin');
    const p = freshPersonnel(env.db, 'LOC-A');
    const byCred = await admin.get('/personnel', { q: p.credential });
    expect(byCred.body.items.map((r: { id: number }) => r.id)).toContain(p.personnelId);
  });
});

describe('credential management', () => {
  it('scenario 2: a credential can be assigned and blocked; blocked credentials are rejected and alerted', async () => {
    const { admin, res } = await createPerson();
    const personId = res.body.id;
    const assign = await admin.post('/credentials', { holderType: 'PERSONNEL', holderId: personId, credentialNumber: 'RF-TEST0001', credentialType: 'RFID_CARD' });
    expect(assign.status).toBe(200);
    const guard = await env.as('alpha.guard');
    const ok = await verify(guard, gateId(env.db, 'A1'), 'PERSONNEL', 'RF-TEST0001');
    expect(ok.result).toBe('VERIFIED');
    expect(ok.allowedActions).toEqual(['ENTRY']);

    const block = await admin.post(`/credentials/${assign.body.id}/status`, { action: 'BLOCK', reason: 'Reported by holder' });
    expect(block.status).toBe(200);
    expect(block.body.status).toBe('BLOCKED');
    expect(block.body.history.map((h: { action: string }) => h.action)).toEqual(['ISSUED', 'BLOCKED']);

    const denied = await verify(guard, gateId(env.db, 'A1'), 'PERSONNEL', 'RF-TEST0001');
    expect(denied.result).toBe('BLOCKED_CREDENTIAL');
    expect(denied.allowedActions).toEqual([]);
    const alert = env.db.prepare("SELECT * FROM alerts WHERE alert_type = 'BLOCKED_CREDENTIAL' AND verification_attempt_id = ?").get(denied.attemptId);
    expect(alert).toBeTruthy();
    expect(env.db.prepare("SELECT 1 FROM audit_events WHERE action = 'credential.block'").get()).toBeTruthy();
  });

  it('prevents duplicate and invalid credential assignments', async () => {
    const { admin, res } = await createPerson();
    const existing = freshPersonnel(env.db, 'LOC-A');
    const dup = await admin.post('/credentials', { holderType: 'PERSONNEL', holderId: res.body.id, credentialNumber: existing.credential, credentialType: 'RFID_CARD' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('DUPLICATE_CREDENTIAL');
    await admin.post('/credentials', { holderType: 'PERSONNEL', holderId: res.body.id, credentialNumber: 'RF-TEST0002', credentialType: 'RFID_CARD' });
    const second = await admin.post('/credentials', { holderType: 'PERSONNEL', holderId: res.body.id, credentialNumber: 'RF-TEST0003', credentialType: 'RFID_CARD' });
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('ACTIVE_CREDENTIAL_EXISTS');
  });

  it('replacement retires the old credential and links the new one', async () => {
    const { admin, res } = await createPerson();
    const a = await admin.post('/credentials', { holderType: 'PERSONNEL', holderId: res.body.id, credentialNumber: 'RF-OLD00001', credentialType: 'RFID_CARD' });
    const r = await admin.post(`/credentials/${a.body.id}/replace`, { newCredentialNumber: 'RF-NEW00001', credentialType: 'NFC_CARD', reason: 'Card damaged', markOldAs: 'REPLACED' });
    expect(r.status).toBe(200);
    expect(r.body.replacesId).toBe(a.body.id);
    const guard = await env.as('alpha.guard');
    expect((await verify(guard, gateId(env.db, 'A1'), 'PERSONNEL', 'RF-OLD00001')).result).toBe('INACTIVE_CREDENTIAL');
    expect((await verify(guard, gateId(env.db, 'A1'), 'PERSONNEL', 'RF-NEW00001')).result).toBe('VERIFIED');
  });

  it('scenario 3: inactive credentials and inactive personnel are rejected', async () => {
    const admin = await env.as('alpha.admin');
    const guard = await env.as('alpha.guard');
    const p = freshPersonnel(env.db, 'LOC-A');
    const credId = (env.db.prepare('SELECT id FROM credentials WHERE credential_number = ?').get(p.credential) as { id: number }).id;
    await admin.post(`/credentials/${credId}/status`, { action: 'DEACTIVATE', reason: 'Long leave' });
    expect((await verify(guard, gateId(env.db, 'A1'), 'PERSONNEL', p.credential)).result).toBe('INACTIVE_CREDENTIAL');
    await admin.post(`/credentials/${credId}/status`, { action: 'REACTIVATE', reason: 'Returned' });
    expect((await verify(guard, gateId(env.db, 'A1'), 'PERSONNEL', p.credential)).result).toBe('VERIFIED');
    const deact = await admin.post(`/personnel/${p.personnelId}/status`, { status: 'INACTIVE', reason: 'Posted out' });
    expect(deact.status).toBe(200);
    expect((await verify(guard, gateId(env.db, 'A1'), 'PERSONNEL', p.credential)).result).toBe('INACTIVE_PERSONNEL');
  });

  it('scenario 11: a temporary credential expires correctly', async () => {
    const { admin, res } = await createPerson();
    const until = new Date(clock.nowMs() + 2 * 3_600_000).toISOString();
    const t = await admin.post('/credentials', { holderType: 'PERSONNEL', holderId: res.body.id, credentialNumber: 'TC-TEMP0001', credentialType: 'RFID_CARD', temporary: true, validUntil: until });
    expect(t.status).toBe(200);
    expect(t.body.isTemporary).toBe(1);
    const guard = await env.as('alpha.guard');
    expect((await verify(guard, gateId(env.db, 'A1'), 'PERSONNEL', 'TC-TEMP0001')).result).toBe('VERIFIED');
    clock.advance(3 * 3_600_000);
    const guard2 = await env.as('alpha.guard');
    expect((await verify(guard2, gateId(env.db, 'A1'), 'PERSONNEL', 'TC-TEMP0001')).result).toBe('EXPIRED_CREDENTIAL');
    // The scheduled check records the expiry in the credential history.
    const admin2 = await env.as('admin');
    await admin2.post('/admin/run-checks');
    const cred = await admin2.get(`/credentials/${t.body.id}`);
    expect(cred.body.status).toBe('EXPIRED');
    expect(cred.body.history.at(-1).action).toBe('EXPIRED');
  });

  it('temporary credentials require an expiry', async () => {
    const { admin, res } = await createPerson();
    const t = await admin.post('/credentials', { holderType: 'PERSONNEL', holderId: res.body.id, credentialNumber: 'TC-TEMP0002', credentialType: 'RFID_CARD', temporary: true });
    expect(t.status).toBe(400);
  });

  it('identifying by personnel ID without a credential requires manual review', async () => {
    const guard = await env.as('alpha.guard');
    const p = freshPersonnel(env.db, 'LOC-A');
    const sn = (env.db.prepare('SELECT service_number AS s FROM personnel WHERE id = ?').get(p.personnelId) as { s: string }).s;
    const v = await verify(guard, gateId(env.db, 'A1'), 'PERSONNEL', sn);
    expect(v.result).toBe('MANUAL_REVIEW_REQUIRED');
    expect(v.manualReviewEligible).toBe(true);
    expect(v.allowedActions).toEqual([]);
  });
});
