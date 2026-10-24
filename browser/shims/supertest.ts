/**
 * Test-only supertest replacement (aliased as 'supertest' by vitest.shims.config.ts).
 *
 * Requests are dispatched in-process through the Express shim's dispatch()
 * instead of a real HTTP server, so the server test suite exercises the same
 * code path as the browser edition. Supported surface: request(app) and
 * request.agent(app) with get/post/put/patch/delete/head/options, chainable
 * .query() / .set() / .type() / .send() / .expect(status), awaiting or .end().
 * Agents keep cookies from Set-Cookie like superagent's cookie jar.
 */
import { dispatch, type Express } from './express';

export interface Response {
  status: number;
  statusCode: number;
  ok: boolean;
  /** Parsed JSON for JSON responses, otherwise {}. */
  body: any;
  text: string;
  /** Lower-case header names; 'set-cookie' is always an array. */
  headers: Record<string, string | string[]>;
  header: Record<string, string | string[]>;
  /** Media type without parameters, e.g. 'application/json'. */
  type: string;
  charset: string | undefined;
  get(name: string): string | string[] | undefined;
}

/** RFC 3986 encoding as used by qs.stringify. */
const encode = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/** qs.stringify(obj, { indices: false, strictNullHandling: true }), which superagent uses for .query(object). */
function stringifyQuery(obj: Record<string, unknown>): string {
  const parts: string[] = [];
  const add = (key: string, value: unknown): void => {
    if (value === undefined) return;
    if (value === null) parts.push(encode(key));
    else if (value instanceof Date) parts.push(`${encode(key)}=${encode(value.toISOString())}`);
    else if (Array.isArray(value)) for (const v of value) add(key, v);
    else if (typeof value === 'object') for (const [k, v] of Object.entries(value)) add(`${key}[${k}]`, v);
    else parts.push(`${encode(key)}=${encode(String(value))}`);
  };
  for (const [k, v] of Object.entries(obj)) add(k, v);
  return parts.join('&');
}

interface StoredCookie {
  name: string;
  value: string;
  path: string;
  secure: boolean;
  expires: number | null;
}

/** Minimal superagent-style cookie jar: one origin, path-prefix matching, expiry honoured. */
class CookieJar {
  private cookies = new Map<string, StoredCookie>();

  store(setCookie: string[]): void {
    for (const line of setCookie) {
      const [pair, ...attrs] = line.split(';');
      const eq = pair.indexOf('=');
      if (eq <= 0) continue;
      const cookie: StoredCookie = { name: pair.slice(0, eq).trim(), value: pair.slice(eq + 1).trim(), path: '/', secure: false, expires: null };
      let maxAge: number | null = null;
      for (const attr of attrs) {
        const i = attr.indexOf('=');
        const key = (i === -1 ? attr : attr.slice(0, i)).trim().toLowerCase();
        const val = i === -1 ? '' : attr.slice(i + 1).trim();
        if (key === 'max-age' && /^-?\d+$/.test(val)) maxAge = Number(val);
        else if (key === 'expires') {
          const t = Date.parse(val);
          if (!Number.isNaN(t)) cookie.expires = t;
        } else if (key === 'path' && val.startsWith('/')) cookie.path = val;
        else if (key === 'secure') cookie.secure = true;
      }
      // Max-Age takes precedence over Expires (RFC 6265 section 5.3).
      if (maxAge !== null) cookie.expires = Date.now() + maxAge * 1000;
      const key = `${cookie.name};${cookie.path}`;
      if (cookie.expires !== null && cookie.expires <= Date.now()) this.cookies.delete(key);
      else this.cookies.set(key, cookie);
    }
  }

  /** Cookie header value for a request path. Secure cookies are withheld, as supertest talks plain http. */
  header(path: string): string {
    const now = Date.now();
    const out: string[] = [];
    for (const [key, c] of this.cookies) {
      if (c.expires !== null && c.expires <= now) {
        this.cookies.delete(key);
        continue;
      }
      const matches = path === c.path || (path.startsWith(c.path) && (c.path.endsWith('/') || path[c.path.length] === '/'));
      if (matches && !c.secure) out.push(`${c.name}=${c.value}`);
    }
    return out.join('; ');
  }
}

export class Test implements PromiseLike<Response> {
  private headers: Record<string, string> = {};
  private queryParts: string[] = [];
  private queryObj: Record<string, unknown> = {};
  private data: unknown = undefined;
  private expectedStatus: number | undefined;
  private promise: Promise<Response> | undefined;

  constructor(
    private readonly app: Express,
    private readonly method: string,
    private readonly url: string,
    private readonly jar: CookieJar | null,
  ) {}

  query(value: Record<string, unknown> | string): this {
    if (typeof value === 'string') this.queryParts.push(value);
    else Object.assign(this.queryObj, value);
    return this;
  }

  set(field: string | Record<string, string>, value?: string): this {
    if (typeof field === 'object') {
      for (const [k, v] of Object.entries(field)) this.set(k, v);
      return this;
    }
    this.headers[field.toLowerCase()] = String(value);
    return this;
  }

  type(type: string): this {
    const map: Record<string, string> = { json: 'application/json', form: 'application/x-www-form-urlencoded', html: 'text/html', text: 'text/plain' };
    return this.set('content-type', map[type] ?? type);
  }

  /** superagent semantics: objects are merged and sent as JSON; strings are appended (form-encoded by default). */
  send(data?: unknown): this {
    const isObject = data !== null && typeof data === 'object';
    if (isObject && (this.data === undefined || this.data === null)) this.data = Array.isArray(data) ? [] : {};
    if (isObject && typeof this.data === 'object' && this.data !== null) {
      Object.assign(this.data, data);
      if (!this.headers['content-type']) this.type('json');
    } else if (typeof data === 'string') {
      if (!this.headers['content-type']) this.type('form');
      const form = this.headers['content-type'].toLowerCase().trim() === 'application/x-www-form-urlencoded';
      this.data = typeof this.data === 'string' ? (form ? `${this.data}&${data}` : this.data + data) : data;
    } else {
      this.data = data;
    }
    return this;
  }

  expect(status: number): this {
    this.expectedStatus = status;
    return this;
  }

  then<T1 = Response, T2 = never>(
    onFulfilled?: ((value: Response) => T1 | PromiseLike<T1>) | null,
    onRejected?: ((reason: unknown) => T2 | PromiseLike<T2>) | null,
  ): Promise<T1 | T2> {
    return this.run().then(onFulfilled, onRejected);
  }

  catch<T = never>(onRejected?: ((reason: unknown) => T | PromiseLike<T>) | null): Promise<Response | T> {
    return this.run().catch(onRejected);
  }

  end(callback?: (err: unknown, res?: Response) => void): this {
    this.run().then(
      (res) => callback?.(null, res),
      (err) => callback?.(err),
    );
    return this;
  }

  private run(): Promise<Response> {
    this.promise ??= this.execute();
    return this.promise;
  }

  private async execute(): Promise<Response> {
    let url = this.url;
    const qs = stringifyQuery(this.queryObj);
    const query = [...this.queryParts, ...(qs ? [qs] : [])].join('&');
    if (query) url += (url.includes('?') ? '&' : '?') + query;

    const headers: Record<string, string> = { host: '127.0.0.1', ...this.headers };
    const cookies = this.jar?.header(url.split('?')[0]);
    if (cookies) headers.cookie = headers.cookie ? `${headers.cookie}; ${cookies}` : cookies;

    let body: string | undefined;
    if (this.data !== undefined && this.data !== null) {
      const json = /[/+]json(\s*;|$)/i.test(headers['content-type'] ?? '');
      body = typeof this.data === 'string' ? this.data : json ? JSON.stringify(this.data) : String(this.data);
    }

    // supertest's ephemeral server listens on 127.0.0.1, which is what req.ip reports.
    const result = await dispatch(this.app, { method: this.method, url, headers, body, ip: '127.0.0.1' });

    const resHeaders: Record<string, string | string[]> = {};
    for (const [k, v] of Object.entries(result.headers)) resHeaders[k] = k === 'set-cookie' ? ([] as string[]).concat(v) : Array.isArray(v) ? v.join(', ') : v;
    const setCookie = resHeaders['set-cookie'];
    if (this.jar && setCookie) this.jar.store(setCookie as string[]);

    const contentType = String(resHeaders['content-type'] ?? '');
    const [type, ...params] = contentType.split(';');
    const charset = params.map((p) => p.trim().split('=')).find(([k]) => k.toLowerCase() === 'charset')?.[1];
    let parsed: unknown = {};
    if (/[/+]json($|[^-\w])/i.test(type.trim()) && result.body !== '') {
      try {
        parsed = JSON.parse(result.body);
      } catch (err) {
        throw Object.assign(new Error(`Failed to parse JSON response: ${(err as Error).message}`), { status: result.status });
      }
    }

    const response: Response = {
      status: result.status,
      statusCode: result.status,
      ok: result.status >= 200 && result.status < 300,
      body: parsed,
      text: result.body,
      headers: resHeaders,
      header: resHeaders,
      type: type.trim().toLowerCase(),
      charset,
      get: (name: string) => resHeaders[name.toLowerCase()],
    };
    if (this.expectedStatus !== undefined && response.status !== this.expectedStatus) {
      throw new Error(`expected ${this.expectedStatus}, got ${response.status} (${this.method} ${url})`);
    }
    return response;
  }
}

export class Agent {
  constructor(
    private readonly app: Express,
    private readonly jar: CookieJar | null,
  ) {}

  private request(method: string, url: string): Test {
    return new Test(this.app, method.toUpperCase(), url, this.jar);
  }

  get(url: string): Test {
    return this.request('GET', url);
  }
  post(url: string): Test {
    return this.request('POST', url);
  }
  put(url: string): Test {
    return this.request('PUT', url);
  }
  patch(url: string): Test {
    return this.request('PATCH', url);
  }
  delete(url: string): Test {
    return this.request('DELETE', url);
  }
  del(url: string): Test {
    return this.request('DELETE', url);
  }
  head(url: string): Test {
    return this.request('HEAD', url);
  }
  options(url: string): Test {
    return this.request('OPTIONS', url);
  }
}

function asApp(app: unknown): Express {
  if (typeof app !== 'function' || typeof (app as { handle?: unknown }).handle !== 'function') {
    throw new TypeError('The supertest shim only accepts an Express (shim) application, not a URL or http.Server');
  }
  return app as Express;
}

/** request(app): one-off requests without cookie persistence. */
function request(app: unknown): Agent {
  return new Agent(asApp(app), null);
}

/** request.agent(app): requests share a cookie jar, like supertest's agent. */
request.agent = (app: unknown): Agent => new Agent(asApp(app), new CookieJar());

type TestType = Test;
type ResponseType = Response;
type AgentType = Agent;

/** Type-only namespace so callers can write `request.Test`, as with @types/supertest. */
// eslint-disable-next-line @typescript-eslint/no-namespace
namespace request {
  export type Test = TestType;
  export type Response = ResponseType;
  export type Agent = AgentType;
}

export default request;
