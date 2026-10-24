/**
 * server/src/app.ts running on the browser shims (express, helmet,
 * cookie-parser, supertest and the browser crypto), plus differential checks
 * of the supertest shim against real supertest + Express.
 * Run with vitest.shims.config.ts.
 */
import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as expressModule from 'express';
import request from 'supertest';
import * as serverCrypto from '../../server/src/lib/crypto.js';
import { clock } from '../../server/src/clock.js';
import { DEMO_PASSWORD } from '../../server/src/seed/demo.js';
import { setup, type TestEnv } from '../../server/test/helpers.js';
import shimExpress, { type Request, type Response } from '../shims/express';
import shimRequest from '../shims/supertest';

const nodeRequire = createRequire(import.meta.url);
const SESSION_SET = /^sg_session=[A-Za-z0-9_-]{43}; Max-Age=43200; Path=\/; Expires=[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT; HttpOnly; SameSite=Strict$/;
const SESSION_CLEARED = 'sg_session=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; SameSite=Strict';

describe('test configuration', () => {
  it('routes express, supertest and the server crypto module to the browser implementations', () => {
    expect(typeof (expressModule as unknown as Record<string, unknown>).dispatch).toBe('function');
    expect(request).toBe(shimRequest);
    expect(serverCrypto.hashPassword.toString()).not.toContain('scryptSync');
  });
});

describe('server/src/app.ts on the shims', () => {
  let env: TestEnv;
  beforeEach(() => {
    env = setup();
  });
  afterEach(() => {
    env.db.close();
    clock.set(null);
  });

  it('maps malformed JSON to 400 BAD_JSON', async () => {
    const res = await env.anon().agent.post('/api/auth/login').set('X-SG-Request', '1').set('Content-Type', 'application/json').send('{"username":');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: { code: 'BAD_JSON', message: 'Malformed JSON body' } });
  });

  it('enforces the 100kb JSON limit with 413 TOO_LARGE', async () => {
    const c = env.anon();
    const big = await c.post('/auth/login', { username: 'admin', password: 'x'.repeat(100 * 1024) });
    expect(big.status).toBe(413);
    expect(big.body.error.code).toBe('TOO_LARGE');
    // Just under the limit is parsed and reaches validation instead.
    const pad = 'x'.repeat(100 * 1024 - JSON.stringify({ username: 'admin', password: '' }).length);
    const ok = await c.post('/auth/login', { username: 'admin', password: pad });
    expect(ok.status).toBe(400);
    expect(ok.body.error.code).toBe('BAD_REQUEST');
  });

  it('requires the CSRF header on state-changing requests only', async () => {
    const c = env.anon();
    const blocked = await c.agent.post('/api/auth/logout').send({});
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('CSRF');
    expect((await c.agent.get('/api/health')).status).toBe(200);
    expect((await c.post('/auth/logout')).status).toBe(200);
  });

  it('sets and clears the session cookie like Express, and the agent follows it', async () => {
    const c = env.anon();
    const login = await c.post('/auth/login', { username: 'admin', password: DEMO_PASSWORD });
    expect(login.status).toBe(200);
    const setCookie = login.headers['set-cookie'] as unknown as string[];
    expect(setCookie).toHaveLength(1);
    expect(setCookie[0]).toMatch(SESSION_SET);
    expect((await c.get('/auth/me')).body.user.username).toBe('admin');

    const logout = await c.post('/auth/logout');
    expect(logout.headers['set-cookie']).toEqual([SESSION_CLEARED]);
    const me = await c.get('/auth/me');
    expect(me.status).toBe(401);
    expect(me.body.error.code).toBe('NO_SESSION');
  });

  it('applies helmet, permissions and cache headers to API responses', async () => {
    const res = await env.anon().get('/config');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['permissions-policy']).toBe('camera=(self), microphone=(), geolocation=()');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['strict-transport-security']).toBeUndefined();
  });

  it('answers unknown API paths with 401 (anonymous) or the JSON 404 (signed in)', async () => {
    expect((await env.anon().get('/no-such-endpoint')).status).toBe(401);
    const admin = await env.as('admin');
    const res = await admin.get('/no-such-endpoint');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('rate limits with 429 and Retry-After', async () => {
    const c = env.anon();
    let last;
    for (let i = 0; i < 21; i++) last = await c.post('/auth/demo-login', { username: 'admin' });
    expect(last!.status).toBe(429);
    expect(last!.headers['retry-after']).toMatch(/^\d+$/);
    expect(last!.body.error.code).toBe('RATE_LIMITED');
  });

  it('passes route params, query strings and async service errors through the router', async () => {
    const admin = await env.as('admin');
    expect((await admin.get('/personnel/abc')).body.error).toMatchObject({ code: 'BAD_REQUEST', message: 'Invalid id' });
    expect((await admin.get('/personnel/999999')).status).toBe(404);
    const page = await admin.get('/personnel', { page: 2, pageSize: 5 });
    expect(page.status).toBe(200);
    expect(page.body).toMatchObject({ page: 2, pageSize: 5 });
    expect(page.body.items).toHaveLength(5);
  });
});

describe('supertest shim vs real supertest', () => {
  type Factory = typeof shimExpress;
  interface AnyResponse {
    status: number;
    body: unknown;
    text: string;
    type: string;
    headers: Record<string, string | string[]>;
  }
  interface AnyTest extends PromiseLike<AnyResponse> {
    set(name: string, value: string): AnyTest;
    send(body: unknown): AnyTest;
    query(q: Record<string, unknown> | string): AnyTest;
  }
  type AnyAgent = Record<'get' | 'post' | 'put' | 'patch' | 'delete', (url: string) => AnyTest>;
  type AnyRequest = ((app: unknown) => AnyAgent) & { agent: (app: unknown) => AnyAgent };

  const realExpress = nodeRequire('express') as Factory;
  const realRequest = nodeRequire('supertest') as AnyRequest;

  function buildApp(express: Factory) {
    const app = express();
    app.use(express.json());
    app.use((req: Request, _res: Response, next: () => void) => {
      const header = req.headers.cookie;
      req.cookies = Object.fromEntries(
        String(header ?? '')
          .split(';')
          .filter((p) => p.includes('='))
          .map((p) => p.trim().split('=')),
      );
      next();
    });
    app.get('/echo', (req, res) => res.json({ query: req.query, cookies: req.cookies, custom: req.get('x-custom') ?? null }));
    app.post('/echo', (req, res) => res.json({ body: req.body ?? null, type: req.get('content-type') ?? null }));
    app.get('/login', (_req, res) => {
      res.cookie('a', '1', { httpOnly: true });
      res.cookie('b', '2', { maxAge: 60_000 });
      res.cookie('scoped', '3', { path: '/scoped' });
      res.json({ ok: true });
    });
    app.get('/scoped/echo', (req, res) => res.json({ cookies: req.cookies }));
    app.get('/logout', (_req, res) => {
      res.clearCookie('a');
      res.cookie('b', 'gone', { maxAge: 0 });
      res.json({ ok: true });
    });
    app.get('/text', (_req, res) => res.type('txt').send('hello'));
    app.get('/missing', (_req, res) => res.status(404).json({ error: 'nope' }));
    return app;
  }

  const realApp = buildApp(realExpress);
  const shimApp = buildApp(shimExpress);
  const pick = (r: AnyResponse) => ({ status: r.status, body: r.body, text: r.text, type: r.type, contentType: r.headers['content-type'] });

  async function both(run: (req: AnyRequest, app: unknown) => Promise<AnyResponse[]>) {
    const real = await run(realRequest, realApp);
    const shim = await run(shimRequest as unknown as AnyRequest, shimApp);
    expect(shim.map(pick)).toEqual(real.map(pick));
    return shim;
  }

  it('serialises .query() objects like superagent', async () => {
    const [first, second] = await both(async (req, app) => [
      await req(app).get('/echo').query({ a: [1, 2], b: 'x y', c: undefined, d: null, e: true, n: { k: 'v' }, s: "it's!*" }),
      await req(app).get('/echo?pre=1').query({ z: 0 }).query('raw=a%20b'),
      await req(app).get('/echo').query({}),
    ]);
    expect((first.body as { query: unknown }).query).toEqual({ a: ['1', '2'], b: 'x y', d: '', e: 'true', 'n[k]': 'v', s: "it's!*" });
    expect((second.body as { query: unknown }).query).toEqual({ pre: '1', raw: 'a b', z: '0' });
  });

  it('sends JSON bodies and merges repeated .send() objects', async () => {
    await both(async (req, app) => [
      await req(app).post('/echo').send({ a: 1 }).send({ b: [true, null] }),
      await req(app).post('/echo').send([1, 2, 3]),
      await req(app).post('/echo').set('Content-Type', 'application/json').send('{"raw":true}'),
      await req(app).post('/echo').send('x=1').send('y=2'),
      await req(app).post('/echo'),
    ]);
  });

  it('exposes text, empty bodies for non-JSON and lower-case headers', async () => {
    await both(async (req, app) => [await req(app).get('/text'), await req(app).get('/missing'), await req(app).get('/nowhere')]);
  });

  it('agents keep cookies, honour Path, Max-Age=0 and past Expires; plain requests do not', async () => {
    const results = await both(async (req, app) => {
      const agent = req.agent(app);
      return [
        await agent.get('/login'),
        await agent.get('/echo').set('X-Custom', 'v'),
        await agent.get('/scoped/echo'),
        await agent.get('/logout'),
        await agent.get('/echo'),
        await req(app).get('/echo'),
      ];
    });
    const cookiesOf = (r: AnyResponse) => (r.body as { cookies: unknown }).cookies;
    expect(cookiesOf(results[1])).toEqual({ a: '1', b: '2' });
    expect((results[1].body as { custom: unknown }).custom).toBe('v');
    expect(cookiesOf(results[2])).toEqual({ a: '1', b: '2', scoped: '3' });
    expect(cookiesOf(results[4])).toEqual({});
    expect(cookiesOf(results[5])).toEqual({});
    const shimLogin = await shimRequest.agent(shimApp).get('/login');
    expect(shimLogin.headers['set-cookie']).toHaveLength(3);
  });

  it('supports .expect(status) and .end(callback)', async () => {
    await expect(shimRequest(shimApp).get('/missing').expect(200)).rejects.toThrow(/expected 200, got 404/);
    const res = await new Promise<{ status: number }>((resolve, reject) => {
      shimRequest(shimApp)
        .get('/text')
        .end((err, r) => (err ? reject(err) : resolve(r!)));
    });
    expect(res.status).toBe(200);
    expect(() => shimRequest('http://127.0.0.1:1')).toThrow(/only accepts an Express/);
  });
});
