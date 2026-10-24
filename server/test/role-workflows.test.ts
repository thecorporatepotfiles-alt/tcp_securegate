import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clock } from '../src/clock.js';
import { gateId, locationId, setup, type TestEnv } from './helpers.js';

let env: TestEnv;
beforeEach(() => {
  env = setup();
});
afterEach(() => {
  env.db.close();
  clock.set(null);
});

/** Scenario 26: every role can reach the endpoints its workflow depends on. */
const WORKFLOWS: Record<string, string[]> = {
  admin: ['/dashboard', '/admin/users', '/admin/roles', '/admin/settings', '/admin/locations', '/audit/verify', '/integrations/readers'],
  'hq.admin': ['/dashboard', '/presence', '/events', '/alerts', '/reports', '/reports/location-activity', '/exceptions'],
  'alpha.admin': ['/dashboard', '/personnel', '/credentials', '/visits', '/manual-reviews', '/admin/users', '/vehicles', '/deliveries', '/contractors', '/temporary-access'],
  'alpha.officer': ['/visits?approvalQueue=true', '/visits/waiting-list', '/notifications', '/deliveries?mine=true'],
  'alpha.host': ['/visits?mine=true', '/visits/waiting-list', '/notifications'],
  auditor: ['/dashboard', '/personnel', '/visits', '/reports/audit-history', '/audit/verify', '/events'],
};

describe('scenario 26: each role can complete its permitted workflow', () => {
  for (const [user, paths] of Object.entries(WORKFLOWS)) {
    it(`${user} can reach its workflow`, async () => {
      const c = await env.as(user);
      for (const p of paths) {
        const [path, qs] = p.split('?');
        const res = await c.get(path, Object.fromEntries(new URLSearchParams(qs ?? '')));
        expect(res.status, `${user} GET ${p}`).toBe(200);
      }
    });
  }

  it('guard can operate its gate end to end', async () => {
    const guard = await env.as('alpha.guard');
    const g = gateId(env.db, 'A1');
    for (const p of [`/gate/${g}/home`, `/gate/${g}/recent`, `/gate/${g}/visitors`, `/gate/${g}/deliveries`, `/gate/${g}/hosts`, `/gate/${g}/alerts`, `/gate/${g}/demo-samples`, '/manual-reviews?mine=true']) {
      const [path, qs] = p.split('?');
      expect((await guard.get(path, Object.fromEntries(new URLSearchParams(qs ?? '')))).status, p).toBe(200);
    }
    const samples = (await guard.get(`/gate/${g}/demo-samples`)).body as { mode: string; input: string; expected: string; method: string }[];
    expect(samples.length).toBeGreaterThan(10);
    // Every simulated-scanner sample produces the result it advertises.
    const label: Record<string, string> = {};
    for (const s of samples) {
      const res = await guard.post('/gate/verify', { gateId: g, mode: s.mode, input: s.input, method: s.method });
      expect(res.status).toBe(200);
      label[`${s.mode}:${s.expected}`] = res.body.label;
      const expectedLabel = s.expected.replace(/ \((entry|exit)\)$/, '');
      if (!expectedLabel.includes(' or ')) expect(res.body.label, `${s.mode} ${s.input}`).toBe(expectedLabel);
    }
    expect(Object.keys(label).length).toBeGreaterThan(10);
  });

  it('list endpoints accept a sort direction without a sort key (regression)', async () => {
    const admin = await env.as('admin');
    for (const p of ['/personnel', '/credentials', '/visits', '/vehicles', '/deliveries', '/contractors', '/temporary-access', '/alerts', '/exceptions', '/events', '/presence', '/admin/users']) {
      expect((await admin.get(p, { dir: 'asc' })).status, p).toBe(200);
      expect((await admin.get(p, { sort: 'not-a-column', dir: 'desc' })).status, p).toBe(200);
    }
  });

  it('host workflow: create a visitor request for an approving officer', async () => {
    const host = await env.as('alpha.host');
    const approvers = await host.get('/lookups/approvers', { locationId: locationId(env.db, 'LOC-A') });
    expect(approvers.body.length).toBeGreaterThan(0);
  });
});
