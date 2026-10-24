/**
 * Routes the client's `/api/*` fetches to the in-page server instead of the
 * network. Everything else goes to the real fetch untouched. A small cookie
 * jar stands in for the browser's cookie store so the server's httpOnly
 * session cookie keeps working; it never leaves this page's memory (and the
 * tab's sessionStorage, so a reload keeps the user signed in).
 */

export interface ServerRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
  ip?: string;
}

export interface ServerResponse {
  status: number;
  headers: Record<string, string | string[]>;
  body: string;
}

export type Dispatch = (req: ServerRequest) => Promise<ServerResponse>;

const JAR_KEY = 'sg:cookies';

export class CookieJar {
  private cookies = new Map<string, string>();

  constructor() {
    try {
      const raw = sessionStorage.getItem(JAR_KEY);
      if (raw) for (const [k, v] of Object.entries(JSON.parse(raw) as Record<string, string>)) this.cookies.set(k, v);
    } catch {
      /* storage unavailable: cookies live for this page load only */
    }
  }

  header(): string | undefined {
    if (!this.cookies.size) return undefined;
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  apply(setCookie: string | string[] | undefined): void {
    if (!setCookie) return;
    for (const line of Array.isArray(setCookie) ? setCookie : [setCookie]) {
      const [pair, ...attrs] = line.split(';').map((s) => s.trim());
      const eq = pair.indexOf('=');
      if (eq <= 0) continue;
      const name = pair.slice(0, eq);
      const value = pair.slice(eq + 1);
      const maxAge = attrs.find((a) => /^max-age=/i.test(a));
      const expires = attrs.find((a) => /^expires=/i.test(a));
      const expired =
        value === '' || (maxAge ? Number(maxAge.split('=')[1]) <= 0 : expires ? Date.parse(expires.slice(8)) <= Date.now() : false);
      if (expired) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    this.persist();
  }

  clear(): void {
    this.cookies.clear();
    this.persist();
  }

  private persist(): void {
    try {
      if (this.cookies.size) sessionStorage.setItem(JAR_KEY, JSON.stringify(Object.fromEntries(this.cookies)));
      else sessionStorage.removeItem(JAR_KEY);
    } catch {
      /* ignore */
    }
  }
}

function headersToObject(h: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!h) return out;
  new Headers(h).forEach((value, key) => {
    out[key.toLowerCase()] = value;
  });
  return out;
}

async function bodyToString(body: BodyInit | null | undefined): Promise<string | undefined> {
  if (body === undefined || body === null) return undefined;
  if (typeof body === 'string') return body;
  return new Response(body).text();
}

/** The in-page API path for a fetch target, or null when the request is not for the API. */
function apiPath(input: RequestInfo | URL): string | null {
  const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const isApi = (p: string) => p === '/api' || p.startsWith('/api/') || p.startsWith('/api?');
  // The client always uses root-relative URLs; match those without a base URL,
  // which may not be parseable in an embedded document (e.g. about:srcdoc).
  if (raw.startsWith('/') && !raw.startsWith('//')) return isApi(raw) ? raw.split('#')[0] : null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  let origin: string | undefined;
  try {
    origin = globalThis.location?.origin;
  } catch {
    origin = undefined;
  }
  if (!origin || origin === 'null' || url.origin !== origin || !isApi(url.pathname)) return null;
  return url.pathname + url.search;
}

/**
 * Install the interceptor. API requests made before `ready` settles wait for
 * it, so the client may start before the in-page server has finished booting.
 */
export function installFetchInterceptor(ready: Promise<Dispatch>, jar: CookieJar, onSettled?: (method: string) => void): () => void {
  const realFetch = globalThis.fetch.bind(globalThis);

  const intercepted: typeof fetch = async (input, init) => {
    const path = apiPath(input);
    if (path === null) return realFetch(input, init);
    const dispatch = await ready;
    const request = input instanceof Request ? input : null;
    const method = (init?.method ?? request?.method ?? 'GET').toUpperCase();
    const headers = { ...headersToObject(request?.headers), ...headersToObject(init?.headers) };
    const cookie = jar.header();
    if (cookie) headers.cookie = cookie;
    const body = init?.body !== undefined ? await bodyToString(init.body) : request && !['GET', 'HEAD'].includes(method) ? await request.text() : undefined;
    try {
      const res = await dispatch({ method, url: path, headers, body, ip: '127.0.0.1' });
      jar.apply(res.headers['set-cookie']);
      const outHeaders = new Headers();
      for (const [k, v] of Object.entries(res.headers)) {
        if (k.toLowerCase() === 'set-cookie') continue;
        for (const value of Array.isArray(v) ? v : [v]) outHeaders.append(k, value);
      }
      const nullBody = res.status === 204 || res.status === 304 || method === 'HEAD';
      return new Response(nullBody ? null : res.body, { status: res.status, headers: outHeaders });
    } finally {
      onSettled?.(method);
    }
  };

  globalThis.fetch = intercepted;
  return () => {
    if (globalThis.fetch === intercepted) globalThis.fetch = realFetch;
  };
}
