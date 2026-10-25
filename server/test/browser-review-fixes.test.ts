/**
 * Regression tests for issues found while reviewing the browser edition that
 * live in shared server code, so they apply to both editions. They run under
 * the native stack (npx vitest run) and through the browser shims
 * (npx vitest run -c vitest.browser.config.ts).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { clock } from '../src/clock.js';
import { gateId, locationId, setup, userId, type TestEnv } from './helpers.js';

let env: TestEnv;
beforeEach(() => {
  env = setup();
});
afterEach(() => {
  env.db.close();
  clock.set(null);
  vi.restoreAllMocks();
});

describe('malformed requests are client errors, not server faults', () => {
  it('answers 415/400 with fixed messages and logs nothing', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const admin = await env.as('admin');

    const latin1 = await admin.agent.post('/api/auth/login').set('X-SG-Request', '1').set('Content-Type', 'application/json; charset=latin1').send('{}');
    expect(latin1.status).toBe(415);
    expect(latin1.body.error.code).toBe('UNSUPPORTED_MEDIA_TYPE');

    const unknownEncoding = await admin.agent.post('/api/auth/login').set('X-SG-Request', '1').set('Content-Type', 'application/json').set('Content-Encoding', 'compress').send('{}');
    expect(unknownEncoding.status).toBe(415);
    expect(unknownEncoding.body.error.code).toBe('UNSUPPORTED_MEDIA_TYPE');

    // Declared as gzip but not compressed: the body cannot be decoded.
    const notGzip = await admin.agent.post('/api/auth/login').set('X-SG-Request', '1').set('Content-Type', 'application/json').set('Content-Encoding', 'gzip').send('{}');
    expect(notGzip.status).toBe(400);
    expect(notGzip.body.error.code).toBe('BAD_REQUEST');

    for (const res of [await admin.get('/visits/%E0%A4%A'), await admin.get('/visits/%'), await admin.post('/visits/%ZZ/cancel', { reason: 'x' })]) {
      expect(res.status).toBe(400);
      expect(res.body.error).toEqual({ code: 'BAD_REQUEST', message: 'The request could not be understood.' });
    }

    // Signed out, the same body error is still a 415, not a logged 500.
    const anon = await env.anon().agent.post('/api/auth/login').set('X-SG-Request', '1').set('Content-Type', 'application/json; charset=iso-8859-1').send('{}');
    expect(anon.status).toBe(415);

    expect(logged).not.toHaveBeenCalled();
    // The session is unaffected.
    expect((await admin.get('/auth/me')).status).toBe(200);
  });
});

describe('errors serving the client keep their status', () => {
  it('answers 416/412/404 with fixed messages and logs nothing', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-client-'));
    try {
      fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>SecureGate</title>');
      const app = createApp({ db: env.db, config: { ...env.config, serveClient: true, clientDir: dir } });
      // Only the native stack serves files; the browser edition's sendFile always reports a missing file.
      if ((await request(app).get('/visitors')).status === 200) {
        const range = await request(app).get('/visitors').set('Range', 'bytes=9999-');
        expect(range.status).toBe(416);
        expect(range.headers['content-type']).toMatch(/^application\/json/); // not the file's text/html
        expect(range.body.error).toEqual({ code: 'REQUEST_REJECTED', message: 'The request could not be completed.' });
        const precondition = await request(app).get('/visitors').set('If-Match', '"not-this-file"');
        expect(precondition.status).toBe(412);
        expect(precondition.body.error.code).toBe('REQUEST_REJECTED');
      }
      fs.rmSync(path.join(dir, 'index.html'));
      const missing = await request(app).get('/visitors');
      expect(missing.status).toBe(404);
      expect(missing.body.error).toEqual({ code: 'NOT_FOUND', message: 'Not found' });
      expect(logged).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('marking a visitor as arrived is idempotent', () => {
  const counts = (visitId: number) => ({
    notifications: (env.db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE type = 'VISITOR_ARRIVED' AND related_type = 'visit' AND related_id = ?").get(visitId) as { n: number }).n,
    audits: (env.db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action = 'visit.arrival' AND entity_id = ?").get(String(visitId)) as { n: number }).n,
  });

  it('an approved visit notifies its host once, however often arrival is marked', async () => {
    const visit = env.db
      .prepare("SELECT id FROM visits WHERE status = 'APPROVED' AND arrived_at IS NULL AND location_id = ? ORDER BY id LIMIT 1")
      .get(locationId(env.db, 'LOC-A')) as { id: number };
    const before = counts(visit.id);
    const guard = await env.as('alpha.guard');
    const gate = gateId(env.db, 'A1');

    const first = await guard.post(`/gate/visits/${visit.id}/arrive`, { gateId: gate });
    expect(first.status).toBe(200);
    expect(first.body.arrivedAt).toBeTruthy();
    expect(counts(visit.id)).toEqual({ notifications: before.notifications + 1, audits: before.audits + 1 });
    const note = env.db.prepare("SELECT body FROM notifications WHERE type = 'VISITOR_ARRIVED' AND related_id = ? ORDER BY id DESC LIMIT 1").get(visit.id) as { body: string };
    expect(note.body).not.toMatch(/acknowledge/i); // an approved visit has nothing left to acknowledge

    clock.advance(60_000);
    const again = await guard.post(`/gate/visits/${visit.id}/arrive`, { gateId: gate });
    expect(again.status).toBe(200);
    expect(again.body.status).toBe('APPROVED');
    expect(again.body.arrivedAt).toBe(first.body.arrivedAt);
    expect(counts(visit.id)).toEqual({ notifications: before.notifications + 1, audits: before.audits + 1 });
  });

  it('an approved walk-in (arrival recorded at registration) is not announced again', async () => {
    const guard = await env.as('alpha.guard');
    const gate = gateId(env.db, 'A1');
    const w = await guard.post('/gate/walk-in', {
      gateId: gate,
      visitor: { fullName: 'Repeat Notify Walkin', phone: '+91 90000 33333' },
      hostUserId: userId(env.db, 'alpha.officer'),
      purpose: 'Meeting',
      destination: 'Admin Block',
      departureTime: '16:00',
    });
    expect(w.status).toBe(200);
    const officer = await env.as('alpha.officer');
    expect((await officer.post(`/visits/${w.body.id}/acknowledge`)).status).toBe(200);
    expect((await officer.post(`/visits/${w.body.id}/approve`, {})).body.status).toBe('APPROVED');
    const before = counts(w.body.id);
    expect(before.notifications).toBe(1);

    const guard2 = await env.as('alpha.guard');
    const res = await guard2.post(`/gate/visits/${w.body.id}/arrive`, { gateId: gate });
    expect(res.status).toBe(200);
    expect(counts(w.body.id)).toEqual(before);
  });
});
