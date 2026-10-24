import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clock } from '../src/clock.js';
import { DEMO_PASSWORD } from '../src/seed/demo.js';
import { gateId, locationId, setup, verify, type TestEnv } from './helpers.js';

let env: TestEnv;
beforeEach(() => {
  env = setup();
});
afterEach(() => {
  env.db.close();
  clock.set(null);
});

describe('authentication & sessions', () => {
  it('signs in with username/password and rejects wrong passwords without revealing which part was wrong', async () => {
    const c = env.anon();
    const bad = await c.post('/auth/login', { username: 'admin', password: 'wrong-password-1' });
    expect(bad.status).toBe(401);
    expect(bad.body.error.message).toBe('Invalid username or password.');
    const unknown = await c.post('/auth/login', { username: 'nobody', password: 'whatever-123' });
    expect(unknown.status).toBe(401);
    expect(unknown.body.error.message).toBe(bad.body.error.message);
    const ok = await c.post('/auth/login', { username: 'admin', password: DEMO_PASSWORD });
    expect(ok.status).toBe(200);
    const me = await c.get('/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.user.role).toBe('SYSTEM_ADMIN');
  });

  it('locks an account after repeated failures', async () => {
    const c = env.anon();
    for (let i = 0; i < 8; i++) await c.post('/auth/login', { username: 'alpha.host', password: `bad-password-${i}` });
    const res = await c.post('/auth/login', { username: 'alpha.host', password: DEMO_PASSWORD });
    expect(res.status).toBe(401);
    expect(res.body.error.message).toMatch(/locked/i);
  });

  it('requires authentication for protected endpoints', async () => {
    const res = await env.anon().get('/dashboard');
    expect(res.status).toBe(401);
  });

  it('expires idle sessions (scenario 27: expired sessions)', async () => {
    const c = await env.as('admin');
    expect((await c.get('/auth/me')).status).toBe(200);
    clock.advance((env.config.sessionIdleMinutes + 1) * 60_000);
    const res = await c.get('/dashboard');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('SESSION_EXPIRED');
  });

  it('logout revokes the session', async () => {
    const c = await env.as('admin');
    await c.post('/auth/logout');
    expect((await c.get('/auth/me')).status).toBe(401);
  });

  it('rejects state-changing requests without the CSRF header', async () => {
    const c = await env.as('admin');
    const res = await c.agent.post('/api/personnel').send({});
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CSRF');
  });

  it('disables demo login and demo reset outside demo mode', async () => {
    const prod = setup({ mode: 'production' });
    try {
      const res = await prod.anon().post('/auth/demo-login', { username: 'admin' });
      expect(res.status).toBe(404);
      const cfg = await prod.anon().get('/config');
      expect(cfg.body.demo).toBe(false);
      expect(cfg.body.demoAccounts).toEqual([]);
      const c = prod.anon();
      await c.post('/auth/login', { username: 'admin', password: DEMO_PASSWORD });
      const reset = await c.post('/admin/demo/reset');
      expect(reset.status).toBe(404);
    } finally {
      prod.db.close();
    }
  });

  it('validates input and returns field-level errors (scenario 27: invalid input)', async () => {
    const c = await env.as('alpha.admin');
    const res = await c.post('/personnel', { serviceNumber: '!', fullName: '', locationId: 'x' });
    expect(res.status).toBe(400);
    expect(res.body.error.details.fields.length).toBeGreaterThan(0);
  });
});

describe('role-based access control', () => {
  it('restricts guards to gate operations', async () => {
    const guard = await env.as('alpha.guard');
    expect((await guard.get('/dashboard')).status).toBe(403);
    expect((await guard.get('/personnel')).status).toBe(403);
    expect((await guard.get('/reports')).status).toBe(403);
    expect((await guard.get('/audit/verify')).status).toBe(403);
    const home = await guard.get(`/gate/${gateId(env.db, 'A1')}/home`);
    expect(home.status).toBe(200);
  });

  it('keeps auditors read-only', async () => {
    const auditor = await env.as('auditor');
    expect((await auditor.get('/personnel')).status).toBe(200);
    expect((await auditor.get('/reports/audit-history')).status).toBe(200);
    const create = await auditor.post('/personnel', { serviceNumber: 'TCP-X-1', fullName: 'Test', locationId: locationId(env.db, 'LOC-A') });
    expect(create.status).toBe(403);
    expect((await auditor.post('/gate/verify', { gateId: gateId(env.db, 'A1'), mode: 'PERSONNEL', input: 'X' })).status).toBe(403);
  });

  it('records denied actions in the audit trail', async () => {
    const auditor = await env.as('auditor');
    await auditor.post('/personnel', { serviceNumber: 'TCP-X-2', fullName: 'Test', locationId: locationId(env.db, 'LOC-A') });
    const denied = env.db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE outcome = 'DENIED' AND actor_username = 'auditor'").get() as { n: number };
    expect(denied.n).toBeGreaterThan(0);
  });

  it('applies permission changes on the next request (scenario 27: permission changes)', async () => {
    const hq = await env.as('hq.admin');
    expect((await hq.get('/dashboard')).status).toBe(200);
    const admin = await env.as('admin');
    const roles = await admin.get('/admin/roles');
    const hqPerms = roles.body.roles.find((r: { code: string }) => r.code === 'HQ_ADMIN').permissions as string[];
    const upd = await admin.put('/admin/roles/HQ_ADMIN', { permissions: hqPerms.filter((p) => p !== 'dashboard.view') });
    expect(upd.status).toBe(200);
    expect(upd.body.removed).toEqual(['dashboard.view']);
    expect((await hq.get('/dashboard')).status).toBe(403);
    const audit = env.db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action = 'role.permissions.update'").get() as { n: number };
    expect(audit.n).toBe(1);
  });

  it('never lets System Administrator lose role-management permissions', async () => {
    const admin = await env.as('admin');
    const res = await admin.put('/admin/roles/SYSTEM_ADMIN', { permissions: ['dashboard.view'] });
    expect(res.status).toBe(200);
    expect(res.body.permissions).toEqual(expect.arrayContaining(['roles.manage', 'users.manage', 'settings.manage']));
  });

  it('immediately invalidates sessions of deactivated users', async () => {
    const guard = await env.as('alpha.guard');
    const admin = await env.as('alpha.admin');
    const guardId = (env.db.prepare("SELECT id FROM users WHERE username = 'alpha.guard'").get() as { id: number }).id;
    const res = await admin.patch(`/admin/users/${guardId}`, { isActive: false });
    expect(res.status).toBe(200);
    expect((await guard.get('/auth/me')).status).toBe(401);
  });

  it('limits location administrators to assignable roles and their own locations', async () => {
    const admin = await env.as('alpha.admin');
    const asHq = await admin.post('/admin/users', { username: 'x.hq', displayName: 'X', role: 'HQ_ADMIN', locationIds: [], password: 'Password12345' });
    expect(asHq.status).toBe(403);
    const otherLoc = await admin.post('/admin/users', { username: 'x.guard', displayName: 'X', role: 'GUARD', locationIds: [locationId(env.db, 'LOC-B')], password: 'Password12345' });
    expect(otherLoc.status).toBe(404);
    const ok = await admin.post('/admin/users', { username: 'x.guard', displayName: 'X Guard', role: 'GUARD', locationIds: [locationId(env.db, 'LOC-A')], password: 'Password12345' });
    expect(ok.status).toBe(200);
    const list = await admin.get('/admin/users');
    expect(list.body.items.every((u: { role: string }) => ['HOST', 'GUARD'].includes(u.role))).toBe(true);
  });
});

describe('location isolation (scenarios 18 & 19)', () => {
  it('HQ sees consolidated summaries across all locations', async () => {
    const hq = await env.as('hq.admin');
    const res = await hq.get('/dashboard');
    expect(res.status).toBe(200);
    expect(res.body.charts.locationActivity).toHaveLength(5);
    const total = res.body.metrics.find((m: { key: string }) => m.key === 'totalPersonnel').value;
    const count = (env.db.prepare('SELECT COUNT(*) AS n FROM personnel').get() as { n: number }).n;
    expect(total).toBe(count);
  });

  it('local users only see their location', async () => {
    const alpha = await env.as('alpha.admin');
    const dash = await alpha.get('/dashboard');
    expect(dash.body.charts.locationActivity).toHaveLength(1);
    const bravo = locationId(env.db, 'LOC-B');
    expect((await alpha.get('/personnel', { locationId: bravo })).status).toBe(403);
    expect((await alpha.get('/dashboard', { locationId: bravo })).status).toBe(403);
    const bravoOnly = env.db
      .prepare('SELECT p.id FROM personnel p WHERE p.primary_location_id = ? AND NOT EXISTS (SELECT 1 FROM personnel_locations pl WHERE pl.personnel_id = p.id AND pl.location_id <> ?) LIMIT 1')
      .get(bravo, bravo) as { id: number };
    expect((await alpha.get(`/personnel/${bravoOnly.id}`)).status).toBe(404);
    const list = await alpha.get('/visits', { pageSize: 200 });
    const alphaId = locationId(env.db, 'LOC-A');
    expect(list.body.items.every((v: { locationId: number }) => v.locationId === alphaId)).toBe(true);
    const report = await alpha.get('/reports/daily-movement', { pageSize: 500 });
    expect(report.body.items.every((r: { locationName: string }) => r.locationName === 'Location Alpha')).toBe(true);
  });

  it('guards cannot operate gates of another location', async () => {
    const guard = await env.as('alpha.guard');
    const res = await guard.post('/gate/verify', { gateId: gateId(env.db, 'B1'), mode: 'PERSONNEL', input: 'RF-00000000' });
    expect(res.status).toBe(404);
  });

  it('does not treat movement between locations as automatically authorized', async () => {
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
    expect(v.allowedActions).toEqual([]);
  });
});
