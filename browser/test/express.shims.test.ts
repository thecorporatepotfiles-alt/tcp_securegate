/**
 * Express shim: differential tests against the real Express 5 stack.
 *
 * The same route table is built with the real `express` package (loaded via
 * createRequire, so no Vite alias applies) and with browser/shims/express.ts.
 * Each request goes through real supertest over HTTP for the former and
 * through dispatch() for the latter; status, body and the relevant headers
 * must match exactly.
 */
import { createRequire } from 'node:module';
import nodePathModule from 'node:path';
import querystring from 'node:querystring';
import * as nodeUrl from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import shimExpress, { dispatch, parseQueryString, serializeCookie, type CookieOptions, type NextFunction, type Request, type Response } from '../shims/express';
import shimHelmet from '../shims/helmet';
import shimCookieParser, { parseCookieHeader } from '../shims/cookie-parser';
import * as shimFs from '../shims/node-fs';
import * as shimPath from '../shims/node-path';
import * as shimUrl from '../shims/node-url';

const nodeRequire = createRequire(import.meta.url);

type Factory = typeof shimExpress;
interface RealResponse {
  status: number;
  text: string;
  headers: Record<string, string | string[]>;
}
interface RealTest extends PromiseLike<RealResponse> {
  set(name: string, value: string): RealTest;
  send(body: string): RealTest;
}
type RealAgent = Record<'get' | 'post' | 'put' | 'patch' | 'delete' | 'head' | 'options', (url: string) => RealTest>;

const realExpress = nodeRequire('express') as Factory;
const realRequest = nodeRequire('supertest') as (app: unknown) => RealAgent;
const realCookie = nodeRequire('cookie') as { serialize(name: string, value: string, opts?: object): string };
const realCookieParser = nodeRequire('cookie-parser') as () => (req: object, res: object, next: () => void) => void;
const realHelmet = nodeRequire('helmet') as (opts?: object) => (req: object, res: object, next: (err?: unknown) => void) => void;

const CHECK = String.fromCodePoint(0x2713);

/** One route table, built with either implementation. */
function buildApp(express: Factory) {
  const app = express();
  app.set('env', 'production'); // real finalhandler then reports status text instead of stacks
  app.use(express.json({ limit: '1kb' }));

  const api = express.Router();
  api.get('/items/:id', (req, res) => {
    res.json({ id: req.params.id, path: req.path, baseUrl: req.baseUrl, originalUrl: req.originalUrl, url: req.url, query: req.query });
  });
  api.get('/items/:id/tags/:tag', (req, res) => res.json(req.params));
  const nested = express.Router({ mergeParams: true });
  nested.get('/deep/:leaf', (req, res) => res.json({ params: req.params, baseUrl: req.baseUrl, path: req.path }));
  api.use('/nested/:group', nested);
  api.get(
    '/chain',
    (_req, res, next) => {
      res.locals.trail = ['a'];
      next();
    },
    (_req, res, next) => {
      res.locals.trail.push('b');
      next('route');
    },
    (_req, res) => res.json({ unreachable: true }),
  );
  api.get('/chain', (_req, res) => res.json({ trail: res.locals.trail }));
  api.get('/async-error', async () => {
    await new Promise((r) => setTimeout(r, 2));
    throw Object.assign(new Error('async boom'), { status: 418 });
  });
  api.get('/sync-error', () => {
    throw new Error('sync boom');
  });
  api.get(
    '/next-error',
    (_req, _res, next) => next(Object.assign(new Error('teapot'), { status: 418 })),
    (_req, res) => res.json({ unreachable: true }),
  );
  api.get('/router-exit', (_req, _res, next) => next('router'));
  api.use((err: Error & { status?: number; type?: string }, _req: Request, res: Response, next: NextFunction) => {
    if (err.message === 'sync boom') return next(err);
    res.status(err.status ?? 500).json({ handled: err.message, status: err.status ?? null });
  });
  app.use('/api', api);
  app.get('/api/router-exit', (_req, res) => res.json({ exited: true }));

  app.get(/^\/re\/(\d+)$/, (req, res) => res.json({ params: req.params }));
  app.get('/files/*rest', (req, res) => res.json({ rest: req.params.rest }));
  app.get('/opt{/:x}', (req, res) => res.json({ x: req.params.x ?? null }));
  app.get('/search', (req, res) => res.json(req.query));
  app.post('/echo', (req, res) => res.json({ body: req.body === undefined ? 'UNDEFINED' : req.body }));
  app.get('/send/html', (_req, res) => res.send('<p>hi</p>'));
  app.get('/send/null', (_req, res) => res.send(null));
  app.get('/send/number', (_req, res) => res.send(42));
  app.get('/send/csv', (_req, res) => {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.send(`a,b\r\n1,${CHECK}`);
  });
  app.get('/send/type', (_req, res) => res.type('txt').send('plain'));
  app.get('/send/204', (_req, res) => res.status(204).send('ignored'));
  app.get('/send/status', (_req, res) => res.sendStatus(418));
  app.get('/send/json-undefined', (_req, res) => res.json(undefined));
  app.get('/send/redirect', (_req, res) => res.redirect('/target?x=1'));
  app.get('/cookies/set', (_req, res) => {
    res.cookie('sid', 'abc 123', { httpOnly: true, sameSite: 'strict', secure: true, maxAge: 3_600_000 });
    res.cookie('pref', { a: 1 });
    res.json({ ok: true });
  });
  app.get('/cookies/clear', (_req, res) => {
    res.clearCookie('sid', { httpOnly: true, sameSite: 'strict', path: '/', maxAge: 5000 });
    res.json({ ok: true });
  });
  app.get('/headers', (req, res) => {
    res.json({ ua: req.get('User-Agent') ?? null, custom: req.header('x-custom') ?? null, ref: req.get('referrer') ?? null, ip: req.ip, ips: req.ips, hostname: req.hostname });
  });
  app.use((err: Error & { status?: number; type?: string }, _req: Request, res: Response, next: NextFunction) => {
    if (err.type) return res.status(err.status ?? 500).json({ type: err.type, status: err.status, message: err.message });
    next(err);
  });
  return app;
}

interface Case {
  name: string;
  method?: string;
  url: string;
  headers?: Record<string, string>;
  body?: string;
}

const JSON_CT = { 'content-type': 'application/json' };
const CASES: Case[] = [
  { name: 'route param', url: '/api/items/42' },
  { name: 'decoded param', url: '/api/items/a%20b%2Fc' },
  { name: 'two params', url: '/api/items/7/tags/x%2By' },
  { name: 'case-insensitive match', url: '/API/Items/7' },
  { name: 'trailing slash', url: '/api/items/7/' },
  { name: 'query on a mounted route', url: '/api/items/7?x=1&x=2' },
  { name: 'mount prefix needs a segment boundary', url: '/apix/items/1' },
  { name: 'mergeParams nested router', url: '/api/nested/g1/deep/leaf%21' },
  { name: "next('route') and res.locals", url: '/api/chain' },
  { name: 'async rejection reaches error middleware', url: '/api/async-error' },
  { name: 'sync throw re-thrown to the default handler', url: '/api/sync-error' },
  { name: 'next(err) skips remaining handlers', url: '/api/next-error' },
  { name: "next('router') leaves the router", url: '/api/router-exit' },
  { name: 'RegExp route', url: '/re/123' },
  { name: 'RegExp route without match', url: '/re/abc' },
  { name: 'wildcard', url: '/files/a/b%20c/d.txt' },
  { name: 'optional group absent', url: '/opt' },
  { name: 'optional group present', url: '/opt/val' },
  { name: 'simple query parser', url: '/search?a=1&a=2&b=x+y&c=%E2%9C%93&d&e=&=f&g=%zz&h[]=1&h[]=2&i[j]=3' },
  { name: 'malformed param escape', url: '/api/items/%E0%A4%A' },
  { name: 'unmatched path', url: '/nope?x=1' },
  { name: 'unmatched method', method: 'DELETE', url: '/api/items/1' },
  { name: 'HEAD served by GET', method: 'HEAD', url: '/api/items/1' },
  { name: 'automatic OPTIONS', method: 'OPTIONS', url: '/api/items/1' },
  { name: 'JSON body', method: 'POST', url: '/echo', headers: JSON_CT, body: '{"a":[1,2],"b":"x"}' },
  { name: 'JSON with charset', method: 'POST', url: '/echo', headers: { 'content-type': 'application/json; charset=UTF-8' }, body: '{"a":1}' },
  { name: 'empty JSON body', method: 'POST', url: '/echo', headers: JSON_CT, body: '' },
  { name: 'no body', method: 'POST', url: '/echo' },
  { name: 'non-JSON content type is not parsed', method: 'POST', url: '/echo', headers: { 'content-type': 'text/plain' }, body: '{"a":1}' },
  { name: '+json is not parsed by default', method: 'POST', url: '/echo', headers: { 'content-type': 'application/vnd.api+json' }, body: '{"a":1}' },
  { name: 'malformed JSON', method: 'POST', url: '/echo', headers: JSON_CT, body: '{"a":' },
  { name: 'strict mode rejects primitives', method: 'POST', url: '/echo', headers: JSON_CT, body: '"just a string"' },
  { name: 'leading whitespace before array', method: 'POST', url: '/echo', headers: JSON_CT, body: ' \n [1,2]' },
  { name: 'body over the limit', method: 'POST', url: '/echo', headers: JSON_CT, body: JSON.stringify({ pad: 'x'.repeat(2000) }) },
  { name: 'body exactly at the limit', method: 'POST', url: '/echo', headers: JSON_CT, body: `{"p":"${'x'.repeat(1024 - 8)}"}` },
  { name: 'multi-byte body over the limit', method: 'POST', url: '/echo', headers: JSON_CT, body: `{"p":"${CHECK.repeat(340)}"}` },
  { name: 'unsupported charset', method: 'POST', url: '/echo', headers: { 'content-type': 'application/json; charset=latin1' }, body: '{}' },
  { name: 'send(string)', url: '/send/html' },
  { name: 'send(null)', url: '/send/null' },
  { name: 'send(number)', url: '/send/number' },
  { name: 'send with preset content type', url: '/send/csv' },
  { name: 'type() + send()', url: '/send/type' },
  { name: '204 strips the body', url: '/send/204' },
  { name: 'sendStatus', url: '/send/status' },
  { name: 'json(undefined)', url: '/send/json-undefined' },
  { name: 'redirect', url: '/send/redirect' },
  { name: 'cookie()', url: '/cookies/set' },
  { name: 'clearCookie()', url: '/cookies/clear' },
  { name: 'request header access', url: '/headers', headers: { 'user-agent': 'shim-test', 'x-custom': 'v', referer: 'http://ref.example/' } },
];

const COMPARED_HEADERS = ['content-type', 'content-length', 'set-cookie', 'allow', 'location', 'x-powered-by', 'x-content-type-options', 'content-security-policy'];

function snapshot(status: number, headers: Record<string, string | string[]>, body: string | undefined) {
  const picked: Record<string, string | string[]> = {};
  for (const h of COMPARED_HEADERS) if (headers[h] !== undefined) picked[h] = headers[h];
  return { status, headers: picked, body: body ?? '' };
}

describe('express shim vs real Express 5', () => {
  const realApp = buildApp(realExpress);
  const shimApp = buildApp(shimExpress);

  beforeAll(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {}); // both log unhandled errors
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-24T06:00:00.000Z') }); // stable cookie Expires
  });
  afterAll(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each(CASES)('$name: $method $url', async (c) => {
    const method = c.method ?? 'GET';
    let t = realRequest(realApp)[method.toLowerCase() as keyof RealAgent](c.url);
    for (const [k, v] of Object.entries(c.headers ?? {})) t = t.set(k, v);
    if (c.body !== undefined) t = t.send(c.body);
    const real = await t;
    const shim = await dispatch(shimApp, { method, url: c.url, headers: { host: '127.0.0.1', ...c.headers }, body: c.body });
    expect(snapshot(shim.status, shim.headers, shim.body)).toEqual(snapshot(real.status, real.headers, real.text));
  });
});

describe('dispatch()', () => {
  it('resolves only once an async handler has responded', async () => {
    const app = shimExpress();
    app.get('/slow', async (_req, res) => {
      await new Promise((r) => setTimeout(r, 20));
      res.status(201).json({ done: true });
    });
    const res = await dispatch(app, { method: 'get', url: '/slow' });
    expect(res).toMatchObject({ status: 201, body: '{"done":true}' });
    expect(res.headers['content-type']).toBe('application/json; charset=utf-8');
  });

  it('ignores the origin of absolute URLs and defaults req.ip', async () => {
    const app = shimExpress();
    app.get('/where', (req, res) => res.json({ path: req.path, query: req.query, ip: req.ip }));
    const res = await dispatch(app, { method: 'GET', url: 'https://example.test/where?q=1' });
    expect(JSON.parse(res.body)).toEqual({ path: '/where', query: { q: '1' }, ip: '127.0.0.1' });
  });

  it("honours 'trust proxy' hop counts for req.ip", async () => {
    const app = shimExpress();
    app.set('trust proxy', 1);
    app.get('/ip', (req, res) => res.json({ ip: req.ip, ips: req.ips }));
    const res = await dispatch(app, { method: 'GET', url: '/ip', headers: { 'X-Forwarded-For': '203.0.113.9, 198.51.100.7' }, ip: '10.0.0.1' });
    expect(JSON.parse(res.body)).toEqual({ ip: '198.51.100.7', ips: ['198.51.100.7'] });
  });

  it('turns a second response attempt into an error instead of a corrupted response', async () => {
    const app = shimExpress();
    const seen: string[] = [];
    app.get('/twice', (_req, res) => {
      res.json({ first: true });
      res.json({ second: true });
    });
    app.use((err: Error & { code?: string }, _req: Request, _res: Response, next: NextFunction) => {
      seen.push(err.code ?? err.message);
      next(err);
    });
    const res = await dispatch(app, { method: 'GET', url: '/twice' });
    expect(res.body).toBe('{"first":true}');
    expect(seen).toEqual(['ERR_HTTP_HEADERS_SENT']);
  });

  it('exposes listen() and static() as browser no-ops', async () => {
    const app = shimExpress();
    expect(() => app.listen(3000)).toThrow(/not available/);
    app.use(shimExpress.static('/nowhere'));
    app.get('/x', (_req, res) => res.send('after static'));
    expect((await dispatch(app, { method: 'GET', url: '/x' })).body).toBe('after static');
  });

  it('mounts sub-applications', async () => {
    const app = shimExpress();
    const sub = shimExpress();
    sub.get('/hello', (req, res) => res.json({ baseUrl: req.baseUrl, sameApp: req.app === sub }));
    app.use('/sub', sub);
    app.get('/after', (req, res) => res.json({ sameApp: req.app === app }));
    expect(JSON.parse((await dispatch(app, { method: 'GET', url: '/sub/hello' })).body)).toEqual({ baseUrl: '/sub', sameApp: true });
    expect(JSON.parse((await dispatch(app, { method: 'GET', url: '/after' })).body)).toEqual({ sameApp: true });
  });
});

describe('query parser', () => {
  it('matches node:querystring.parse', () => {
    const samples = ['', 'a', 'a=', '=a', '=', '&', 'a&&b', 'a=1&a=2&a=3', 'a+b=c+d', 'a=%20%2B', 'a=%E2%9C%93', 'a=%zz', 'a=%E2%9C', 'a=%',
      'a==b', '__proto__=x', 'constructor=1', 'a[]=1&a[]=2', ' a = b ', '%61=1', 'x=%C3%A9%FF', 'a=1&b=2&a=3&b=4&a=5'];
    for (let i = 0; i < 200; i++) samples.push(Array.from({ length: i % 7 }, (_, j) => `${'ab%+= '[j % 6]}${i}${'=&'[j % 2]}${j}`).join('&'));
    for (const s of samples) expect({ ...parseQueryString(s) }, s).toEqual({ ...querystring.parse(s) });
    expect(Object.keys(parseQueryString(Array.from({ length: 1005 }, (_, i) => `k${i}=1`).join('&')))).toHaveLength(1000);
  });
});

describe('cookies', () => {
  const now = new Date('2026-10-24T06:00:00.000Z');
  const options: CookieOptions[] = [
    {},
    { path: '/' },
    { httpOnly: true, sameSite: 'strict', secure: true, path: '/', maxAge: 43200 },
    { domain: 'example.test', path: '/api', expires: now, priority: 'high', partitioned: true, sameSite: 'lax' },
    { sameSite: true },
    { sameSite: 'none', secure: true },
  ];

  it('serialises Set-Cookie exactly like the cookie package', () => {
    for (const o of options) {
      for (const value of ['abc', 'a b;c', '', 'j:{"a":1}', CHECK]) {
        expect(serializeCookie('sid', value, o)).toBe(realCookie.serialize('sid', value, o));
      }
    }
    expect(() => serializeCookie('bad name', 'x')).toThrow(TypeError);
    expect(() => serializeCookie('sid', 'x', { sameSite: 'bogus' as never })).toThrow(TypeError);
  });

  it('cookie-parser shim parses Cookie headers like cookie-parser', () => {
    const headers = ['', 'a=1', 'a=1; b=2', ' a = 1 ;b= "quoted" ', 'a=1; a=2', 'enc=%E2%9C%93; bad=%E0%A4%A', 'j=j%3A%7B%22x%22%3A1%7D',
      'noequals; c=3', 'x=1;;y=2', `big=${'v'.repeat(500)}`];
    for (const cookie of headers) {
      const real: { cookies?: object } & { headers: object } = { headers: { cookie } };
      const shim: { cookies?: object; headers: Record<string, string> } = { headers: { cookie } };
      realCookieParser()(real, {}, () => {});
      shimCookieParser()(shim, {}, () => {});
      expect({ ...shim.cookies }, cookie).toEqual({ ...real.cookies });
    }
    expect(parseCookieHeader('a=1; b=%20x')).toEqual({ a: '1', b: ' x' });
    expect(() => shimCookieParser('secret')).toThrow(/not supported/);
  });
});

describe('helmet shim', () => {
  function headersFrom(mw: (req: object, res: object, next: (err?: unknown) => void) => void) {
    const out: Record<string, string> = { 'x-powered-by': 'Express' };
    const res = {
      setHeader: (k: string, v: string) => void (out[k.toLowerCase()] = v),
      removeHeader: (k: string) => void delete out[k.toLowerCase()],
    };
    let called = false;
    mw({}, res, (err) => {
      expect(err).toBeUndefined();
      called = true;
    });
    expect(called).toBe(true);
    return out;
  }

  const appTsOptions = (production: boolean, secureCookies: boolean) => ({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        fontSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        mediaSrc: ["'self'", 'blob:'],
        workerSrc: ["'self'", 'blob:'],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        ...(production ? { upgradeInsecureRequests: [] } : {}),
      },
    },
    strictTransportSecurity: secureCookies ? { maxAge: 15552000, includeSubDomains: true } : (false as const),
    crossOriginEmbedderPolicy: false,
  });

  it.each([
    ['defaults', undefined],
    ['app.ts (demo)', appTsOptions(false, false)],
    ['app.ts (production)', appTsOptions(true, true)],
    ['selected options', { contentSecurityPolicy: false, xFrameOptions: { action: 'deny' }, referrerPolicy: { policy: ['origin', 'same-origin'] }, xPoweredBy: false, crossOriginEmbedderPolicy: true }],
  ])('sets the same headers as helmet: %s', (_name, opts) => {
    expect(headersFrom(shimHelmet(opts as never) as never)).toEqual(headersFrom(realHelmet(opts)));
  });
});

describe('node builtin stubs', () => {
  const nodePath = nodePathModule.posix;

  it('node:path matches path.posix', () => {
    const paths = ['', '.', '..', '/', '//', '///a//b/', 'a', 'a/', 'a/b', '/a/b/c', 'a/../b', '/a/../../b', './a/./b/', 'a/b/../../..', '/x/y.tar.gz', '.bashrc',
      'a.', 'a..', '/a/b.c/', 'dir/file.txt', '../up', '/a//b'];
    for (const p of paths) {
      expect(shimPath.normalize(p), `normalize ${p}`).toBe(nodePath.normalize(p));
      expect(shimPath.dirname(p), `dirname ${p}`).toBe(nodePath.dirname(p));
      expect(shimPath.basename(p), `basename ${p}`).toBe(nodePath.basename(p));
      expect(shimPath.extname(p), `extname ${p}`).toBe(nodePath.extname(p));
      expect(shimPath.isAbsolute(p)).toBe(nodePath.isAbsolute(p));
      expect(shimPath.resolve(p), `resolve ${p}`).toBe(nodePath.resolve(p));
      for (const q of ['b', '/b', '../c', '']) {
        expect(shimPath.join(p, q), `join ${p} ${q}`).toBe(nodePath.join(p, q));
        expect(shimPath.resolve(p, q), `resolve ${p} ${q}`).toBe(nodePath.resolve(p, q));
        expect(shimPath.relative(p || '/', q || '/'), `relative ${p} ${q}`).toBe(nodePath.relative(p || '/', q || '/'));
      }
    }
    for (const [p, suffix] of [['/a/b.html', '.html'], ['aaa', 'aaa'], ['/a/aaa', 'aaa'], ['a.js/', '.js'], ['x', 'longer'], ['/a/b', 'b'], ['file.txt', 'txt']]) {
      expect(shimPath.basename(p, suffix), `basename ${p} ${suffix}`).toBe(nodePath.basename(p, suffix));
    }
    expect(shimPath.default.join('a', 'b')).toBe('a/b');
    expect(shimPath.sep).toBe('/');
  });

  it('node:url converts file URLs like node:url', () => {
    for (const p of ['/a/b.sql', '/with space/x', '/pct%41/#hash?q']) {
      expect(shimUrl.pathToFileURL(p).href).toBe(nodeUrl.pathToFileURL(p).href);
      expect(shimUrl.fileURLToPath(nodeUrl.pathToFileURL(p).href)).toBe(p);
    }
    expect(() => shimUrl.fileURLToPath('https://x/y')).toThrow(TypeError);
    expect(shimUrl.default.fileURLToPath('file:///tmp/a%20b')).toBe('/tmp/a b');
  });

  it('node:fs reports an empty disk and refuses I/O', () => {
    expect(shimFs.existsSync('/anything')).toBe(false);
    expect(shimFs.default.existsSync('/x')).toBe(false);
    for (const fn of [shimFs.readFileSync, shimFs.writeFileSync, shimFs.mkdirSync, shimFs.readdirSync, shimFs.cpSync, shimFs.rmSync]) {
      expect(() => fn('/x')).toThrow('Not available in the browser edition');
    }
  });
});
