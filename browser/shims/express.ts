/**
 * Express 5-compatible subset for the browser edition (aliased as 'express').
 *
 * Covers what server/src/app.ts, server/src/routes/*.ts and the middleware use:
 * apps and routers with Express 5 routing semantics (path-to-regexp 8 matching,
 * mounting with path stripping, async handlers, 4-argument error middleware,
 * next('route'/'router')), express.json(), express.static() (inert), and the
 * request/response helpers listed in the exported types. There is no HTTP
 * server: requests enter through dispatch(), which resolves with the finished
 * response. Routing is a port of the router@2 / path-to-regexp@8 algorithms.
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type NextFunction = (err?: unknown) => void;
export type PathParams = string | RegExp | (string | RegExp)[];
export type RequestHandler = (req: Request, res: Response, next: NextFunction) => unknown;
export type ErrorRequestHandler = (err: any, req: Request, res: Response, next: NextFunction) => unknown;
export type HandlerArgument = RequestHandler | ErrorRequestHandler | HandlerArgument[];
export type Query = Record<string, string | string[] | undefined>;
export type HeaderValue = string | number | readonly string[];

export interface RouterMatcher<T> {
  (path: PathParams, ...handlers: RequestHandler[]): T;
  (path: PathParams, ...handlers: HandlerArgument[]): T;
}

export interface RouterUse<T> {
  (...handlers: RequestHandler[]): T;
  (path: PathParams, ...handlers: RequestHandler[]): T;
  (...handlers: ErrorRequestHandler[]): T;
  (path: PathParams, ...handlers: ErrorRequestHandler[]): T;
  (...handlers: HandlerArgument[]): T;
  (path: PathParams, ...handlers: HandlerArgument[]): T;
}

interface RoutingMethods<T> {
  use: RouterUse<T>;
  all: RouterMatcher<T>;
  post: RouterMatcher<T>;
  put: RouterMatcher<T>;
  patch: RouterMatcher<T>;
  delete: RouterMatcher<T>;
  options: RouterMatcher<T>;
  head: RouterMatcher<T>;
  route(path: PathParams): Route;
}

export interface Router extends RoutingMethods<Router> {
  (req: Request, res: Response, next: NextFunction): void;
  get: RouterMatcher<Router>;
  readonly stack: Layer[];
  handle(req: Request, res: Response, done: NextFunction): void;
}

export interface RouterOptions {
  caseSensitive?: boolean;
  mergeParams?: boolean;
  strict?: boolean;
}

export interface Express extends RoutingMethods<Express> {
  (req: Request, res: Response, next?: NextFunction): void;
  // Settings getter first, as in @types/express, so app.get('name') is typed as a lookup.
  get: ((setting: string) => any) & RouterMatcher<Express>;
  locals: Record<string, any>;
  settings: Record<string, any>;
  mountpath: string | string[];
  readonly router: Router;
  set(setting: string): any;
  set(setting: string, value: unknown): Express;
  enable(setting: string): Express;
  disable(setting: string): Express;
  enabled(setting: string): boolean;
  disabled(setting: string): boolean;
  handle(req: Request, res: Response, callback?: NextFunction): void;
  /** There is no network listener in the browser edition; always throws. */
  listen(...args: unknown[]): never;
}
export type Application = Express;

export interface Request {
  app: Express;
  res: Response;
  next: NextFunction;
  method: string;
  url: string;
  originalUrl: string;
  baseUrl: string;
  readonly path: string;
  params: Record<string, string>;
  readonly query: Query;
  body: any;
  cookies: Record<string, any>;
  signedCookies: Record<string, any>;
  secret?: string;
  headers: Record<string, string | string[] | undefined>;
  readonly ip: string | undefined;
  readonly ips: string[];
  readonly protocol: string;
  readonly secure: boolean;
  readonly hostname: string | undefined;
  route?: Route;
  get(name: 'set-cookie'): string[] | undefined;
  get(name: string): string | undefined;
  header(name: 'set-cookie'): string[] | undefined;
  header(name: string): string | undefined;
}

export interface CookieOptions {
  maxAge?: number;
  expires?: Date;
  path?: string;
  domain?: string;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: boolean | 'lax' | 'strict' | 'none';
  priority?: 'low' | 'medium' | 'high';
  partitioned?: boolean;
  signed?: boolean;
  encode?: (value: string) => string;
}

export interface Response {
  app: Express;
  req: Request;
  locals: Record<string, any>;
  statusCode: number;
  statusMessage: string;
  readonly headersSent: boolean;
  readonly writableEnded: boolean;
  status(code: number): this;
  sendStatus(code: number): this;
  send(body?: unknown): this;
  json(body?: unknown): this;
  type(type: string): this;
  contentType(type: string): this;
  set(field: string, value: HeaderValue): this;
  set(fields: Record<string, HeaderValue>): this;
  header(field: string, value: HeaderValue): this;
  header(fields: Record<string, HeaderValue>): this;
  get(field: string): string | number | string[] | undefined;
  append(field: string, value: string | string[]): this;
  setHeader(name: string, value: HeaderValue): this;
  getHeader(name: string): string | number | string[] | undefined;
  getHeaders(): Record<string, string | number | string[]>;
  getHeaderNames(): string[];
  hasHeader(name: string): boolean;
  removeHeader(name: string): void;
  cookie(name: string, value: unknown, options?: CookieOptions): this;
  clearCookie(name: string, options?: CookieOptions): this;
  location(url: string): this;
  redirect(url: string): void;
  redirect(status: number, url: string): void;
  /** Not available in the browser edition: forwards a 404 error to next(). */
  sendFile(path: string, ...rest: unknown[]): void;
  writeHead(statusCode: number, headers?: Record<string, HeaderValue>): this;
  write(chunk: string | Uint8Array): boolean;
  end(cb?: () => void): this;
  end(chunk: string | Uint8Array | undefined, cb?: () => void): this;
  end(chunk: string | Uint8Array | undefined, encoding: string, cb?: () => void): this;
  on(event: 'finish' | 'close', listener: () => void): this;
  once(event: 'finish' | 'close', listener: () => void): this;
}

/** Transport-independent request accepted by dispatch(). */
export interface DispatchRequest {
  method: string;
  /** Path plus optional query string, e.g. '/api/visits?page=2' (an absolute URL's origin is ignored). */
  url: string;
  headers?: Record<string, string>;
  /** Raw request body. For POST/PUT/PATCH an omitted body is sent as empty, as browsers do. */
  body?: string;
  /** Remote address seen by req.ip (default '127.0.0.1'). */
  ip?: string;
}

export interface DispatchResult {
  status: number;
  /** Lower-case header names; 'set-cookie' (and any other repeated header) is an array. */
  headers: Record<string, string | string[]>;
  body: string;
}

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

const STATUS_TEXT: Record<number, string> = {
  200: 'OK', 201: 'Created', 202: 'Accepted', 204: 'No Content', 205: 'Reset Content', 206: 'Partial Content',
  301: 'Moved Permanently', 302: 'Found', 303: 'See Other', 304: 'Not Modified', 307: 'Temporary Redirect', 308: 'Permanent Redirect',
  400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 405: 'Method Not Allowed', 406: 'Not Acceptable',
  408: 'Request Timeout', 409: 'Conflict', 410: 'Gone', 411: 'Length Required', 412: 'Precondition Failed', 413: 'Payload Too Large',
  414: 'URI Too Long', 415: 'Unsupported Media Type', 416: 'Range Not Satisfiable', 418: "I'm a Teapot", 422: 'Unprocessable Entity',
  423: 'Locked', 428: 'Precondition Required', 429: 'Too Many Requests', 431: 'Request Header Fields Too Large',
  500: 'Internal Server Error', 501: 'Not Implemented', 502: 'Bad Gateway', 503: 'Service Unavailable', 504: 'Gateway Timeout',
};

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'options', 'head'] as const;
type Method = (typeof HTTP_METHODS)[number];

const encoder = new TextEncoder();
const byteLength = (s: string) => encoder.encode(s).length;
const decodeBytes = (b: Uint8Array) => new TextDecoder().decode(b);

/** Replaces router's setImmediate deferrals (unwinds the stack before continuing). */
const defer = (fn: () => void) => queueMicrotask(fn);

function isPromiseLike(v: unknown): v is PromiseLike<unknown> {
  return !!v && (typeof v === 'object' || typeof v === 'function') && typeof (v as { then?: unknown }).then === 'function';
}

type HttpError = Error & { status: number; statusCode: number; expose: boolean; type?: string; [key: string]: unknown };

/** Minimal http-errors equivalent: keeps an existing error's status, otherwise applies `status`. */
function httpError(status: number, err: string | Error, props: Record<string, unknown> = {}): HttpError {
  const e = (typeof err === 'string' ? new Error(err) : err) as HttpError;
  const s = typeof e.status === 'number' ? e.status : typeof e.statusCode === 'number' ? e.statusCode : status;
  e.status = e.statusCode = s;
  e.expose = s < 500;
  Object.assign(e, props);
  return e;
}

/** pathname of a request target (router uses parseurl). */
function pathnameOf(url: string): string {
  const end = url.search(/[?#]/);
  return end === -1 ? url : url.slice(0, end);
}

function queryStringOf(url: string): string {
  const q = url.indexOf('?');
  if (q === -1) return '';
  const h = url.indexOf('#', q);
  return url.slice(q + 1, h === -1 ? undefined : h);
}

const isHexCode = (c: number) => (c >= 48 && c <= 57) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102);

/**
 * querystring.unescape: decodeURIComponent, falling back to Node's unescapeBuffer, which decodes valid
 * %XX escapes, keeps invalid ones literally and (like Buffer) keeps only the low byte of other code units.
 */
function unescapeQs(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    const out = new Uint8Array(s.length);
    let n = 0;
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c === 37 /* % */ && i < s.length - 2 && isHexCode(s.charCodeAt(i + 1)) && isHexCode(s.charCodeAt(i + 2))) {
        out[n++] = parseInt(s.slice(i + 1, i + 3), 16);
        i += 2;
      } else out[n++] = c;
    }
    return decodeBytes(out.subarray(0, n));
  }
}

function addQueryPair(obj: Query, key: string, value: string, keyEncoded: boolean, valEncoded: boolean): void {
  if (key.length > 0 && keyEncoded) key = unescapeQs(key);
  if (value.length > 0 && valEncoded) value = unescapeQs(value);
  const prev = obj[key];
  if (prev === undefined) obj[key] = value;
  else if (Array.isArray(prev)) prev.push(value);
  else obj[key] = [prev, value];
}

/**
 * Express 5's default 'simple' query parser: a port of node:querystring.parse with the default
 * '&' / '=' separators and maxKeys 1000 (empty segments count towards it). Like Node, a key or value
 * is only unescaped once a valid %XX escape has been seen in it, and '+' becomes a space.
 */
export function parseQueryString(qs: string): Query {
  const obj: Query = Object.create(null);
  if (!qs) return obj;
  let pairs = 1000;
  let lastPos = 0;
  let inValue = false;
  let key = '';
  let value = '';
  let keyEncoded = false;
  let valEncoded = false;
  let encodeCheck = 0;
  for (let i = 0; i < qs.length; ++i) {
    const code = qs.charCodeAt(i);
    if (code === 38 /* & */) {
      if (!inValue) {
        if (lastPos < i) key += qs.slice(lastPos, i);
        else if (key.length === 0) {
          if (--pairs === 0) return obj;
          lastPos = i + 1;
          continue;
        }
      } else if (lastPos < i) value += qs.slice(lastPos, i);
      addQueryPair(obj, key, value, keyEncoded, valEncoded);
      if (--pairs === 0) return obj;
      keyEncoded = valEncoded = inValue = false;
      key = value = '';
      encodeCheck = 0;
      lastPos = i + 1;
      continue;
    }
    if (!inValue) {
      if (code === 61 /* = */) {
        if (lastPos < i) key += qs.slice(lastPos, i);
        encodeCheck = 0;
        lastPos = i + 1;
        inValue = true;
        continue;
      }
      if (!keyEncoded) {
        if (code === 37 /* % */) {
          encodeCheck = 1;
          continue;
        } else if (encodeCheck > 0) {
          if (isHexCode(code)) {
            if (++encodeCheck === 3) keyEncoded = true;
            continue;
          }
          encodeCheck = 0;
        }
      }
      if (code === 43 /* + */) {
        if (lastPos < i) key += qs.slice(lastPos, i);
        key += ' ';
        lastPos = i + 1;
        continue;
      }
    }
    // Node runs this branch for key characters too once the key is known to be encoded.
    if (code === 43 /* + */) {
      if (lastPos < i) value += qs.slice(lastPos, i);
      value += ' ';
      lastPos = i + 1;
    } else if (!valEncoded) {
      if (code === 37 /* % */) encodeCheck = 1;
      else if (encodeCheck > 0) {
        if (isHexCode(code)) {
          if (++encodeCheck === 3) valEncoded = true;
        } else encodeCheck = 0;
      }
    }
  }
  if (lastPos < qs.length) {
    if (inValue) value += qs.slice(lastPos);
    else key += qs.slice(lastPos);
  } else if (!inValue && key.length === 0) {
    return obj;
  }
  addQueryPair(obj, key, value, keyEncoded, valEncoded);
  return obj;
}

/** Media type + parameters of a Content-Type value, or null when it cannot be parsed. */
function parseContentType(value: unknown): { type: string; params: Record<string, string> } | null {
  if (typeof value !== 'string') return null;
  const [type, ...rest] = value.split(';');
  const t = type.trim().toLowerCase();
  if (!/^[!#$%&'*+.^_`|~0-9a-z-]+\/[!#$%&'*+.^_`|~0-9a-z-]+$/.test(t)) return null;
  const params: Record<string, string> = {};
  for (const p of rest) {
    const eq = p.indexOf('=');
    if (eq === -1) continue;
    let v = p.slice(eq + 1).trim();
    if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) v = v.slice(1, -1).replace(/\\(.)/g, '$1');
    params[p.slice(0, eq).trim().toLowerCase()] = v;
  }
  return { type: t, params };
}

function formatContentType(type: string, params: Record<string, string>): string {
  let out = type;
  for (const k of Object.keys(params).sort()) {
    const v = params[k];
    out += `; ${k}=${/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(v) ? v : JSON.stringify(v)}`;
  }
  return out;
}

const MIME_BY_EXT: Record<string, string> = {
  html: 'text/html', htm: 'text/html', json: 'application/json', txt: 'text/plain', text: 'text/plain', csv: 'text/csv',
  js: 'text/javascript', mjs: 'text/javascript', css: 'text/css', xml: 'application/xml', svg: 'image/svg+xml',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', pdf: 'application/pdf', bin: 'application/octet-stream',
  urlencoded: 'application/x-www-form-urlencoded', form: 'application/x-www-form-urlencoded', multipart: 'multipart/*',
};

/** mime-types.contentType(): resolve an extension and add the default charset for textual types. */
function mimeContentType(value: string): string | false {
  const full = value.includes('/') ? value : MIME_BY_EXT[value.replace(/^\./, '').toLowerCase()];
  if (!full) return false;
  if (/charset/i.test(full)) return full;
  const base = full.split(';')[0].trim().toLowerCase();
  const textual = base.startsWith('text/') || base === 'application/json' || base === 'application/javascript';
  return textual ? `${full}; charset=utf-8` : full;
}

/** type-is: does the request Content-Type match one of `types` (extensions, full types, wildcards, '+json')? */
function typeIs(contentType: unknown, types: string[]): boolean {
  const parsed = parseContentType(contentType);
  if (!parsed) return false;
  const [aType, aSub] = parsed.type.split('/');
  return types.some((t) => {
    const expected = t[0] === '+' ? `*/*${t}` : t.includes('/') ? t.toLowerCase() : MIME_BY_EXT[t.toLowerCase()];
    if (!expected) return false;
    const [eType, eSub] = expected.split('/');
    if (eType !== '*' && eType !== aType) return false;
    if (eSub.startsWith('*+')) return eSub.length <= aSub.length + 1 && aSub.endsWith(eSub.slice(1));
    return eSub === '*' || eSub === aSub;
  });
}

function hasBody(req: Request): boolean {
  const length = req.headers['content-length'];
  return req.headers['transfer-encoding'] !== undefined || (length !== undefined && !Number.isNaN(Number(length)));
}

/** bytes.parse() for limits such as '100kb' (1kb = 1024 bytes). */
function parseBytes(limit: string | number): number {
  if (typeof limit === 'number') return limit;
  const m = /^((?:-|\+)?(?:\d+(?:\.\d*)?|\.\d+))\s*(b|kb|mb|gb|tb|pb)?$/i.exec(limit.trim());
  if (!m) throw new TypeError(`option limit "${limit}" is invalid`);
  const unit = (m[2] ?? 'b').toLowerCase();
  const mult = { b: 1, kb: 1 << 10, mb: 1 << 20, gb: 1 << 30, tb: 1024 ** 4, pb: 1024 ** 5 }[unit as 'b'];
  return Math.floor(Number.parseFloat(m[1]) * mult);
}

// ---------------------------------------------------------------------------
// Path matching: port of path-to-regexp@8 as configured by router@2
// ---------------------------------------------------------------------------

type Token = { type: 'text'; value: string } | { type: 'param' | 'wildcard'; name: string } | { type: 'group'; tokens: Token[] };
type MatchResult = { path: string; params: Record<string, unknown> };
type Matcher = (path: string) => MatchResult | false;

const ID_START = /^[$_\p{ID_Start}]$/u;
const ID_CONTINUE = /^[$\u200c\u200d\p{ID_Continue}]$/u;
const escapeRe = (s: string) => s.replace(/[.+*?^${}()[\]|/\\]/g, '\\$&');

function pathError(message: string, path: string) {
  return new TypeError(`${message}: ${path}; visit https://git.new/pathToRegexpError for info`);
}

function parsePath(str: string): Token[] {
  const chars = [...str];
  let index = 0;
  function consumeUntil(end: string): Token[] {
    const output: Token[] = [];
    let path = '';
    const writePath = () => {
      if (path) output.push({ type: 'text', value: path });
      path = '';
    };
    while (index < chars.length) {
      const value = chars[index++];
      if (value === end) {
        writePath();
        return output;
      }
      if (value === '\\') {
        if (index === chars.length) throw pathError(`Unexpected end after \\ at index ${index}`, str);
        path += chars[index++];
        continue;
      }
      if (value === ':' || value === '*') {
        let name = '';
        if (ID_START.test(chars[index] ?? '')) {
          do name += chars[index++];
          while (ID_CONTINUE.test(chars[index] ?? ''));
        } else if (chars[index] === '"') {
          let quoteStart = index;
          while (index < chars.length) {
            if (chars[++index] === '"') {
              index++;
              quoteStart = 0;
              break;
            }
            if (chars[index] === '\\') index++;
            name += chars[index];
          }
          if (quoteStart) throw pathError(`Unterminated quote at index ${quoteStart}`, str);
        }
        if (!name) throw pathError(`Missing parameter name at index ${index}`, str);
        writePath();
        output.push({ type: value === ':' ? 'param' : 'wildcard', name });
        continue;
      }
      if (value === '{') {
        writePath();
        output.push({ type: 'group', tokens: consumeUntil('}') });
        continue;
      }
      if ('}()[]+?!'.includes(value)) throw pathError(`Unexpected ${value} at index ${index - 1}`, str);
      path += value;
    }
    if (end) throw pathError(`Unexpected end at index ${index}, expected ${end}`, str);
    writePath();
    return output;
  }
  return consumeUntil('');
}

/** Expand optional groups into every concrete token sequence. */
function flattenTokens(tokens: Token[], index: number, result: Token[], callback: (seq: Token[]) => void): void {
  while (index < tokens.length) {
    const token = tokens[index++];
    if (token.type === 'group') {
      const len = result.length;
      flattenTokens(token.tokens, 0, result, (seq) => flattenTokens(tokens, index, seq, callback));
      result.length = len;
      continue;
    }
    result.push(token);
  }
  callback(result);
}

function negate(a: string, b: string): string {
  if (b.length > a.length) return negate(b, a);
  if (a === b) b = '';
  if (b.length > 1) return `(?:(?!${escapeRe(a)}|${escapeRe(b)})[^])`;
  if (a.length > 1) return `(?:(?!${escapeRe(a)})[^${escapeRe(b)}])`;
  return `[^${escapeRe(a + b)}]`;
}

function toRegExpSource(tokens: Token[], keys: { type: 'param' | 'wildcard'; name: string }[], originalPath: string): string {
  const delimiter = '/';
  let result = '';
  let backtrack = '';
  let wildcardBacktrack = '';
  let prevCaptureType = 0;
  let hasSegmentCapture = 0;
  let index = 0;
  const hasInSegment = (i: number, type: string) => {
    while (i < tokens.length) {
      const t = tokens[i++];
      if (t.type === type) return true;
      if (t.type === 'text' && t.value.includes(delimiter)) break;
    }
    return false;
  };
  const peekText = (i: number) => {
    let out = '';
    while (i < tokens.length) {
      const t = tokens[i++];
      if (t.type !== 'text') break;
      out += t.value;
    }
    return out;
  };
  while (index < tokens.length) {
    const token = tokens[index++];
    if (token.type === 'text') {
      result += escapeRe(token.value);
      backtrack += token.value;
      if (prevCaptureType === 2) wildcardBacktrack += token.value;
      if (token.value.includes(delimiter)) hasSegmentCapture = 0;
      continue;
    }
    if (token.type === 'group') throw new TypeError('Unexpected group token');
    if (prevCaptureType && !backtrack) throw pathError(`Missing text before "${token.name}" ${token.type}`, originalPath);
    if (token.type === 'param') {
      result +=
        hasSegmentCapture & 2
          ? `(${negate(delimiter, backtrack)}+)`
          : hasInSegment(index, 'wildcard')
            ? `(${negate(delimiter, peekText(index))}+)`
            : hasSegmentCapture & 1
              ? `(${negate(delimiter, backtrack)}+|${escapeRe(backtrack)})`
              : `(${negate(delimiter, '')}+)`;
      hasSegmentCapture |= prevCaptureType = 1;
    } else {
      result +=
        hasSegmentCapture & 2
          ? `(${negate(backtrack, '')}+)`
          : wildcardBacktrack
            ? `(${negate(wildcardBacktrack, '')}+|${negate(delimiter, '')}+)`
            : '([^]+)';
      wildcardBacktrack = '';
      hasSegmentCapture |= prevCaptureType = 2;
    }
    keys.push(token);
    backtrack = '';
  }
  return result;
}

/** router's decodeParam: decodeURIComponent, with a 400 error for malformed escapes. */
function decodeParam(val: string): string {
  if (typeof val !== 'string' || val.length === 0) return val;
  try {
    return decodeURIComponent(val);
  } catch (err) {
    if (err instanceof URIError) {
      err.message = `Failed to decode param '${val}'`;
      (err as URIError & { status: number }).status = 400;
    }
    throw err;
  }
}

function stringMatcher(path: string, opts: { sensitive: boolean; end: boolean; strict: boolean }): Matcher {
  const loose = opts.strict || path === '/' ? path : path.replace(/\/+$/, '');
  const keys: { type: 'param' | 'wildcard'; name: string }[] = [];
  const sources: string[] = [];
  flattenTokens(parsePath(loose), 0, [], (seq) => {
    if (sources.length >= 256) throw pathError('Too many path combinations', loose);
    sources.push(toRegExpSource(seq, keys, loose));
  });
  let pattern = `^(?:${sources.join('|')})`;
  if (!opts.strict) pattern += '(?:\\/$)?';
  pattern += opts.end ? '$' : '(?=\\/|$)';
  const re = new RegExp(pattern, opts.sensitive ? '' : 'i');
  return (input) => {
    const m = re.exec(input);
    if (!m) return false;
    const params: Record<string, unknown> = Object.create(null);
    for (let i = 1; i < m.length; i++) {
      if (m[i] === undefined) continue;
      const key = keys[i - 1];
      params[key.name] = key.type === 'param' ? decodeParam(m[i]) : m[i].split('/').map(decodeParam);
    }
    return { path: m[0], params };
  };
}

const MATCHING_GROUP_REGEXP = /\((?:\?<(.*?)>)?(?!\?)/g;

function regexpMatcher(re: RegExp): Matcher {
  const keys: (string | number)[] = [];
  let name = 0;
  for (const m of re.source.matchAll(MATCHING_GROUP_REGEXP)) keys.push(m[1] || name++);
  return (p) => {
    const match = re.exec(p);
    if (!match) return false;
    const params: Record<string, unknown> = {};
    for (let i = 1; i < match.length; i++) {
      const val = decodeParam(match[i]);
      if (val !== undefined) params[keys[i - 1]] = val;
    }
    return { params, path: match[0] };
  };
}

// ---------------------------------------------------------------------------
// Layer & Route (router@2 semantics)
// ---------------------------------------------------------------------------

type AnyHandler = (...args: any[]) => unknown;

export class Layer {
  keys: string[] = [];
  params: Record<string, unknown> | undefined;
  path: string | undefined;
  route: Route | undefined;
  method: string | undefined;
  readonly name: string;
  private readonly slash: boolean;
  private readonly matchers: Matcher[];

  constructor(
    path: PathParams,
    opts: { sensitive?: boolean; strict?: boolean; end: boolean },
    readonly handle: AnyHandler,
  ) {
    this.name = handle.name || '<anonymous>';
    this.slash = path === '/' && opts.end === false;
    const o = { sensitive: !!opts.sensitive, strict: !!opts.strict, end: opts.end };
    const make = (p: string | RegExp) => (p instanceof RegExp ? regexpMatcher(p) : stringMatcher(String(p), o));
    this.matchers = Array.isArray(path) ? path.map(make) : [make(path)];
  }

  match(path: string): boolean {
    let match: MatchResult | false = false;
    if (path != null) {
      if (this.slash) {
        this.params = {};
        this.path = '';
        return true;
      }
      for (let i = 0; !match && i < this.matchers.length; i++) match = this.matchers[i](path);
    }
    if (!match) {
      this.params = undefined;
      this.path = undefined;
      return false;
    }
    this.params = match.params;
    this.path = match.path;
    this.keys = Object.keys(match.params);
    return true;
  }

  handleError(error: unknown, req: Request, res: Response, next: NextFunction): void {
    const fn = this.handle;
    if (fn.length !== 4) return next(error);
    try {
      const ret = fn(error, req, res, next);
      if (isPromiseLike(ret)) ret.then(undefined, (e: unknown) => next(e || new Error('Rejected promise')));
    } catch (err) {
      next(err);
    }
  }

  handleRequest(req: Request, res: Response, next: NextFunction): void {
    const fn = this.handle;
    if (fn.length > 3) return next();
    try {
      const ret = fn(req, res, next);
      if (isPromiseLike(ret)) ret.then(undefined, (e: unknown) => next(e || new Error('Rejected promise')));
    } catch (err) {
      next(err);
    }
  }
}

function flattenHandlers(args: unknown[]): AnyHandler[] {
  const fns = (args as unknown[]).flat(Infinity) as unknown[];
  if (fns.length === 0) throw new TypeError('argument handler is required');
  for (const fn of fns) if (typeof fn !== 'function') throw new TypeError('argument handler must be a function');
  return fns as AnyHandler[];
}

export class Route {
  readonly stack: Layer[] = [];
  readonly methods: Record<string, boolean> = {};
  declare get: (...handlers: HandlerArgument[]) => Route;
  declare post: (...handlers: HandlerArgument[]) => Route;
  declare put: (...handlers: HandlerArgument[]) => Route;
  declare patch: (...handlers: HandlerArgument[]) => Route;
  declare delete: (...handlers: HandlerArgument[]) => Route;
  declare options: (...handlers: HandlerArgument[]) => Route;
  declare head: (...handlers: HandlerArgument[]) => Route;

  constructor(readonly path: PathParams) {}

  handlesMethod(method: string): boolean {
    if (this.methods._all) return true;
    let name = method.toLowerCase();
    if (name === 'head' && !this.methods.head) name = 'get';
    return Boolean(this.methods[name]);
  }

  allowedMethods(): string[] {
    const methods = Object.keys(this.methods);
    if (this.methods.get && !this.methods.head) methods.push('head');
    return methods.map((m) => m.toUpperCase());
  }

  dispatch(req: Request, res: Response, done: NextFunction): void {
    let idx = 0;
    let sync = 0;
    const stack = this.stack;
    if (stack.length === 0) return done();
    let method = req.method.toLowerCase();
    if (method === 'head' && !this.methods.head) method = 'get';
    req.route = this;
    const next = (err?: unknown): void => {
      if (err === 'route') return done();
      if (err === 'router') return done(err);
      if (idx >= stack.length) return done(err);
      if (++sync > 100) return defer(() => next(err));
      let layer: Layer | undefined;
      let match = false;
      while (!match && idx < stack.length) {
        layer = stack[idx++];
        match = !layer.method || layer.method === method;
      }
      if (!match || !layer) return done(err);
      if (err) layer.handleError(err, req, res, next);
      else layer.handleRequest(req, res, next);
      sync = 0;
    };
    next();
  }

  all(...handlers: HandlerArgument[]): this {
    for (const fn of flattenHandlers(handlers)) {
      const layer = new Layer('/', { end: true }, fn);
      layer.method = undefined;
      this.methods._all = true;
      this.stack.push(layer);
    }
    return this;
  }
}

for (const method of HTTP_METHODS) {
  (Route.prototype as unknown as Record<Method, unknown>)[method] = function (this: Route, ...handlers: HandlerArgument[]) {
    for (const fn of flattenHandlers(handlers)) {
      const layer = new Layer('/', { end: true }, fn);
      layer.method = method;
      this.methods[method] = true;
      this.stack.push(layer);
    }
    return this;
  };
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

function mergeParams(params: Record<string, unknown>, parent: unknown): Record<string, unknown> {
  if (typeof parent !== 'object' || !parent) return params;
  const obj: Record<string, unknown> = { ...(parent as Record<string, unknown>) };
  if (!(0 in params) || !(0 in parent)) return Object.assign(obj, params);
  let i = 0;
  let o = 0;
  while (i in params) i++;
  while (o in parent) o++;
  for (i--; i >= 0; i--) {
    params[i + o] = params[i];
    if (i < o) delete params[i];
  }
  return Object.assign(obj, params);
}

/** Split `use()`/verb arguments into an optional leading path and the handlers. */
function splitPathArgs(args: unknown[]): { path: PathParams; handlers: unknown[] } {
  let arg = args[0];
  while (Array.isArray(arg) && arg.length !== 0) arg = arg[0];
  return typeof arg !== 'function' && args.length > 0 && typeof args[0] !== 'function'
    ? { path: args[0] as PathParams, handlers: args.slice(1) }
    : { path: '/', handlers: args };
}

export function Router(options: RouterOptions = {}): Router {
  // The inner function is unnamed on purpose: `router` must refer to the typed const below.
  const router = function (req: Request, res: Response, next: NextFunction) {
    router.handle(req, res, next);
  } as Router;
  const stack: Layer[] = [];
  const caseSensitive = !!options.caseSensitive;
  const strict = !!options.strict;

  const route = (path: PathParams): Route => {
    const r = new Route(path);
    const layer = new Layer(path, { sensitive: caseSensitive, strict, end: true }, function handle(req: Request, res: Response, next: NextFunction) {
      r.dispatch(req, res, next);
    });
    layer.route = r;
    stack.push(layer);
    return r;
  };

  const methods: Record<string, unknown> = {
    stack,
    route,
    use(...args: unknown[]) {
      const { path, handlers } = splitPathArgs(args);
      for (const fn of flattenHandlers(handlers)) {
        const layer = new Layer(path, { sensitive: caseSensitive, strict: false, end: false }, fn);
        layer.route = undefined;
        stack.push(layer);
      }
      return router;
    },
    all(path: PathParams, ...handlers: HandlerArgument[]) {
      route(path).all(...handlers);
      return router;
    },
    handle(req: Request, res: Response, callback: NextFunction) {
      handleRouter(stack, !!options.mergeParams, req, res, callback);
    },
  };
  for (const method of HTTP_METHODS) {
    methods[method] = (path: PathParams, ...handlers: HandlerArgument[]) => {
      route(path)[method](...handlers);
      return router;
    };
  }
  return Object.assign(router, methods);
}

function handleRouter(stack: Layer[], shouldMergeParams: boolean, req: Request, res: Response, callback: NextFunction): void {
  let idx = 0;
  let removed = '';
  let slashAdded = false;
  let sync = 0;
  let optionsMethods: string[] | undefined;
  const parentParams = req.params;
  const parentUrl = req.baseUrl || '';
  const saved = { baseUrl: req.baseUrl, next: req.next, params: req.params };
  let done: NextFunction = (err) => {
    req.baseUrl = saved.baseUrl;
    req.next = saved.next;
    req.params = saved.params;
    callback(err);
  };

  req.next = next;

  // OPTIONS: respond with the allowed methods if nothing else responds.
  if (req.method === 'OPTIONS') {
    optionsMethods = [];
    const inner = done;
    done = (err) => {
      if (err || optionsMethods!.length === 0) return inner(err);
      try {
        const allow = [...new Set(optionsMethods)].sort().join(', ');
        res.setHeader('Allow', allow);
        res.setHeader('Content-Length', String(byteLength(allow)));
        res.setHeader('Content-Type', 'text/plain');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.end(allow);
      } catch (e) {
        inner(e);
      }
    };
  }

  req.baseUrl = parentUrl;
  req.originalUrl = req.originalUrl || req.url;

  next();

  function next(err?: unknown): void {
    let layerError = err === 'route' ? null : err;

    if (slashAdded) {
      req.url = req.url.slice(1);
      slashAdded = false;
    }
    if (removed.length !== 0) {
      req.baseUrl = parentUrl;
      req.url = removed + req.url;
      removed = '';
    }
    if (layerError === 'router') {
      defer(() => done(null));
      return;
    }
    if (idx >= stack.length) {
      defer(() => done(layerError));
      return;
    }
    if (++sync > 100) {
      defer(() => next(err));
      return;
    }

    const path = pathnameOf(req.url);
    let layer: Layer | undefined;
    let match: boolean | unknown = false;
    let route: Route | undefined;

    while (match !== true && idx < stack.length) {
      layer = stack[idx++];
      try {
        match = layer.match(path);
      } catch (e) {
        match = e;
      }
      route = layer.route;
      if (typeof match !== 'boolean') layerError = layerError || match;
      if (match !== true) continue;
      if (!route) continue;
      if (layerError) {
        match = false;
        continue;
      }
      const hasMethod = route.handlesMethod(req.method);
      if (!hasMethod && req.method === 'OPTIONS' && optionsMethods) optionsMethods.push(...route.allowedMethods());
      if (!hasMethod && req.method !== 'HEAD') match = false;
    }

    if (match !== true || !layer) return done(layerError);

    if (route) req.route = route;
    req.params = (shouldMergeParams ? mergeParams(layer.params ?? {}, parentParams) : layer.params ?? {}) as Record<string, string>;
    const layerPath = layer.path ?? '';

    if (route) layer.handleRequest(req, res, next);
    else trimPrefix(layer, layerError, layerPath, path);
    sync = 0;
  }

  function trimPrefix(layer: Layer, layerError: unknown, layerPath: string, path: string): void {
    if (layerPath.length !== 0) {
      if (layerPath !== path.substring(0, layerPath.length)) return next(layerError);
      const c = path[layerPath.length];
      if (c && c !== '/') return next(layerError);
      removed = layerPath;
      req.url = req.url.slice(removed.length);
      if (req.url[0] !== '/') {
        req.url = `/${req.url}`;
        slashAdded = true;
      }
      req.baseUrl = parentUrl + (removed[removed.length - 1] === '/' ? removed.slice(0, -1) : removed);
    }
    if (layerError) layer.handleError(layerError, req, res, next);
    else layer.handleRequest(req, res, next);
  }
}

// ---------------------------------------------------------------------------
// Request & Response
// ---------------------------------------------------------------------------

type TrustFn = (addr: string, i: number) => boolean;

function compileTrust(val: unknown): TrustFn {
  if (typeof val === 'function') return val as TrustFn;
  if (val === true) return () => true;
  if (typeof val === 'number') return (_a, i) => i < val;
  if (!val) return () => false;
  // Address/subnet lists ('loopback', '10.0.0.0/8', ...) are not needed by the browser edition.
  throw new TypeError(`trust proxy value ${JSON.stringify(val)} is not supported by the browser Express shim`);
}

const remoteAddresses = new WeakMap<object, string>();

class ShimRequest implements Request {
  declare app: Express;
  declare res: Response;
  declare next: NextFunction;
  method: string;
  url: string;
  originalUrl = '';
  baseUrl = '';
  params: Record<string, string> = {};
  body: any = undefined;
  declare cookies: Record<string, any>;
  declare signedCookies: Record<string, any>;
  declare secret?: string;
  headers: Record<string, string | string[] | undefined>;
  route?: Route;

  constructor(app: Express, input: { method: string; url: string; headers: Record<string, string>; ip: string }) {
    this.app = app;
    this.method = input.method.toUpperCase();
    this.url = input.url;
    this.headers = input.headers;
    remoteAddresses.set(this, input.ip);
  }

  get path(): string {
    return pathnameOf(this.url);
  }

  get query(): Query {
    const parser = this.app.get('query parser fn') as ((s: string) => Query) | undefined;
    return parser ? parser(queryStringOf(this.url)) : Object.create(null);
  }

  /** proxy-addr: socket address followed by X-Forwarded-For entries (nearest first), cut at the first untrusted hop. */
  private addresses(): string[] {
    const xff = this.headers['x-forwarded-for'];
    const forwarded = (Array.isArray(xff) ? xff.join(',') : xff ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .reverse();
    const addrs = [remoteAddresses.get(this) ?? '127.0.0.1', ...forwarded];
    const trust = this.app.get('trust proxy fn') as TrustFn;
    for (let i = 0; i < addrs.length - 1; i++) {
      if (!trust(addrs[i], i)) {
        addrs.length = i + 1;
        break;
      }
    }
    return addrs;
  }

  get ip(): string | undefined {
    const addrs = this.addresses();
    return addrs[addrs.length - 1];
  }

  get ips(): string[] {
    return this.addresses().slice(1).reverse();
  }

  get protocol(): string {
    const trust = this.app.get('trust proxy fn') as TrustFn;
    const proto = this.headers['x-forwarded-proto'];
    if (!proto || !trust(remoteAddresses.get(this) ?? '', 0)) return 'http';
    return String(proto).split(',')[0].trim();
  }

  get secure(): boolean {
    return this.protocol === 'https';
  }

  get hostname(): string | undefined {
    const host = this.headers.host;
    if (typeof host !== 'string' || !host) return undefined;
    const offset = host[0] === '[' ? host.indexOf(']') + 1 : 0;
    const colon = host.indexOf(':', offset);
    return colon === -1 ? host : host.slice(0, colon);
  }

  get(name: 'set-cookie'): string[] | undefined;
  get(name: string): string | undefined;
  get(name: string): string | string[] | undefined {
    if (!name) throw new TypeError('name argument is required to req.get');
    if (typeof name !== 'string') throw new TypeError('name must be a string to req.get');
    const lc = name.toLowerCase();
    if (lc === 'referer' || lc === 'referrer') return (this.headers.referrer ?? this.headers.referer) as string | undefined;
    return this.headers[lc] as string | string[] | undefined;
  }

  header(name: 'set-cookie'): string[] | undefined;
  header(name: string): string | undefined;
  header(name: string): string | string[] | undefined {
    return this.get(name);
  }
}

const COOKIE_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const COOKIE_VALUE_RE = /^("?)[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]*\1$/;
const COOKIE_DOMAIN_RE = /^([.]?[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)([.][a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/i;
const COOKIE_PATH_RE = /^[\x20-\x3A\x3D-\x7E]*$/;

/** cookie@0.7 serialize(): same attribute order and validation as Express's res.cookie(). */
export function serializeCookie(name: string, val: string, opt: CookieOptions = {}): string {
  const enc = opt.encode ?? encodeURIComponent;
  if (!COOKIE_NAME_RE.test(name)) throw new TypeError('argument name is invalid');
  const value = enc(val);
  if (!COOKIE_VALUE_RE.test(value)) throw new TypeError('argument val is invalid');
  let str = `${name}=${value}`;
  if (opt.maxAge != null) {
    const maxAge = Math.floor(opt.maxAge);
    if (!Number.isFinite(maxAge)) throw new TypeError('option maxAge is invalid');
    str += `; Max-Age=${maxAge}`;
  }
  if (opt.domain) {
    if (!COOKIE_DOMAIN_RE.test(opt.domain)) throw new TypeError('option domain is invalid');
    str += `; Domain=${opt.domain}`;
  }
  if (opt.path) {
    if (!COOKIE_PATH_RE.test(opt.path)) throw new TypeError('option path is invalid');
    str += `; Path=${opt.path}`;
  }
  if (opt.expires) {
    if (!(opt.expires instanceof Date) || Number.isNaN(opt.expires.valueOf())) throw new TypeError('option expires is invalid');
    str += `; Expires=${opt.expires.toUTCString()}`;
  }
  if (opt.httpOnly) str += '; HttpOnly';
  if (opt.secure) str += '; Secure';
  if (opt.partitioned) str += '; Partitioned';
  if (opt.priority) {
    const p = String(opt.priority).toLowerCase();
    if (p !== 'low' && p !== 'medium' && p !== 'high') throw new TypeError('option priority is invalid');
    str += `; Priority=${p[0].toUpperCase()}${p.slice(1)}`;
  }
  if (opt.sameSite) {
    const s = typeof opt.sameSite === 'string' ? opt.sameSite.toLowerCase() : opt.sameSite;
    if (s === true || s === 'strict') str += '; SameSite=Strict';
    else if (s === 'lax') str += '; SameSite=Lax';
    else if (s === 'none') str += '; SameSite=None';
    else throw new TypeError('option sameSite is invalid');
  }
  return str;
}

function headersSentError(): Error {
  return Object.assign(new Error('Cannot set headers after they are sent to the client'), { code: 'ERR_HTTP_HEADERS_SENT' });
}

function validateHeader(name: string, value: HeaderValue): void {
  if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name)) throw new TypeError(`Header name must be a valid HTTP token ["${name}"]`);
  const values = Array.isArray(value) ? value : [value];
  for (const v of values) {
    if (v === undefined) throw new TypeError(`Invalid value "undefined" for header "${name}"`);
    if (/[^\t\x20-\x7e\x80-\xff]/.test(String(v))) throw new TypeError(`Invalid character in header content ["${name}"]`);
  }
}

class ShimResponse implements Response {
  declare app: Express;
  declare req: Request;
  locals: Record<string, any> = Object.create(null);
  statusCode = 200;
  statusMessage = '';
  private sent = false;
  private ended = false;
  private streamed = false;
  private removedContentLength = false;
  private chunks: string[] = [];
  private readonly headerMap = new Map<string, { name: string; value: string | number | string[] }>();
  private readonly listeners: { event: string; fn: () => void; once: boolean }[] = [];

  constructor(private readonly onEnd: (res: ShimResponse) => void) {}

  get headersSent(): boolean {
    return this.sent;
  }

  get writableEnded(): boolean {
    return this.ended;
  }

  // -- Node ServerResponse surface -----------------------------------------

  setHeader(name: string, value: HeaderValue): this {
    if (this.sent) throw headersSentError();
    validateHeader(name, value);
    this.headerMap.set(name.toLowerCase(), { name, value: Array.isArray(value) ? [...value] : (value as string | number) });
    return this;
  }

  getHeader(name: string): string | number | string[] | undefined {
    return this.headerMap.get(name.toLowerCase())?.value;
  }

  getHeaders(): Record<string, string | number | string[]> {
    const out: Record<string, string | number | string[]> = Object.create(null);
    for (const [k, v] of this.headerMap) out[k] = v.value;
    return out;
  }

  getHeaderNames(): string[] {
    return [...this.headerMap.keys()];
  }

  hasHeader(name: string): boolean {
    return this.headerMap.has(name.toLowerCase());
  }

  removeHeader(name: string): void {
    if (this.sent) throw headersSentError();
    if (name.toLowerCase() === 'content-length') this.removedContentLength = true;
    this.headerMap.delete(name.toLowerCase());
  }

  writeHead(statusCode: number, headers?: Record<string, HeaderValue>): this {
    if (this.sent) throw headersSentError();
    this.statusCode = statusCode;
    for (const [k, v] of Object.entries(headers ?? {})) this.setHeader(k, v);
    this.sent = true;
    return this;
  }

  write(chunk: string | Uint8Array): boolean {
    if (this.ended) throw Object.assign(new Error('write after end'), { code: 'ERR_STREAM_WRITE_AFTER_END' });
    this.sent = true;
    this.streamed = true;
    this.chunks.push(typeof chunk === 'string' ? chunk : decodeBytes(chunk));
    return true;
  }

  end(...args: unknown[]): this {
    if (this.ended) return this;
    const cb = typeof args[args.length - 1] === 'function' ? (args.pop() as () => void) : undefined;
    const chunk = args[0] as string | Uint8Array | undefined;
    if (chunk !== undefined && chunk !== null) this.chunks.push(typeof chunk === 'string' ? chunk : decodeBytes(chunk));
    this.sent = true;
    this.ended = true;
    this.emit('finish');
    this.emit('close');
    cb?.();
    this.onEnd(this);
    return this;
  }

  on(event: 'finish' | 'close', listener: () => void): this {
    this.listeners.push({ event, fn: listener, once: false });
    return this;
  }

  once(event: 'finish' | 'close', listener: () => void): this {
    this.listeners.push({ event, fn: listener, once: true });
    return this;
  }

  private emit(event: string): void {
    for (const l of [...this.listeners]) {
      if (l.event !== event) continue;
      if (l.once) this.listeners.splice(this.listeners.indexOf(l), 1);
      l.fn();
    }
  }

  // -- Express response helpers --------------------------------------------

  status(code: number): this {
    if (!Number.isInteger(code)) throw new TypeError(`Invalid status code: ${JSON.stringify(code)}. Status code must be an integer.`);
    if (code < 100 || code > 999) {
      throw new RangeError(`Invalid status code: ${JSON.stringify(code)}. Status code must be greater than 99 and less than 1000.`);
    }
    this.statusCode = code;
    return this;
  }

  sendStatus(code: number): this {
    const body = STATUS_TEXT[code] ?? String(code);
    this.status(code);
    this.type('txt');
    return this.send(body);
  }

  set(field: string | Record<string, HeaderValue>, value?: HeaderValue): this {
    if (typeof field !== 'string') {
      for (const key of Object.keys(field)) this.set(key, field[key]);
      return this;
    }
    let v: string | string[] = Array.isArray(value) ? value.map(String) : String(value);
    if (field.toLowerCase() === 'content-type') {
      if (Array.isArray(v)) throw new TypeError('Content-Type cannot be set to an Array');
      v = mimeContentType(v) || v;
    }
    return this.setHeader(field, v);
  }

  header(field: string | Record<string, HeaderValue>, value?: HeaderValue): this {
    return this.set(field as string, value as HeaderValue);
  }

  get(field: string): string | number | string[] | undefined {
    return this.getHeader(field);
  }

  append(field: string, value: string | string[]): this {
    const prev = this.get(field);
    let next: HeaderValue = value;
    if (prev) next = Array.isArray(prev) ? prev.concat(value) : Array.isArray(value) ? [String(prev), ...value] : [String(prev), value];
    return this.set(field, next);
  }

  type(type: string): this {
    return this.set('Content-Type', type.includes('/') ? type : mimeContentType(type) || 'application/octet-stream');
  }

  contentType(type: string): this {
    return this.type(type);
  }

  json(obj?: unknown): this {
    const app = this.app;
    const replacer = app?.get('json replacer') as ((key: string, value: unknown) => unknown) | undefined;
    const spaces = app?.get('json spaces') as string | number | undefined;
    let body = replacer || spaces ? JSON.stringify(obj, replacer, spaces) : JSON.stringify(obj);
    if (app?.get('json escape') && typeof body === 'string') {
      body = body.replace(/[<>&]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
    }
    if (!this.get('Content-Type')) this.set('Content-Type', 'application/json');
    return this.send(body);
  }

  send(body?: unknown): this {
    let chunk: unknown = body;
    switch (typeof chunk) {
      case 'string': {
        const type = this.get('Content-Type');
        const parsed = typeof type === 'string' ? parseContentType(type) : null;
        if (typeof type === 'string') this.set('Content-Type', parsed ? formatContentType(parsed.type, { ...parsed.params, charset: 'utf-8' }) : type);
        else this.type('html');
        break;
      }
      case 'boolean':
      case 'number':
      case 'object':
        if (chunk === null) chunk = '';
        else if (ArrayBuffer.isView(chunk)) {
          if (!this.get('Content-Type')) this.type('bin');
          chunk = decodeBytes(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
        } else return this.json(chunk);
        break;
    }
    if (chunk !== undefined && !this.get('Transfer-Encoding')) this.set('Content-Length', byteLength(String(chunk)));
    if (this.statusCode === 204 || this.statusCode === 304) {
      this.removeHeader('Content-Type');
      this.removeHeader('Content-Length');
      this.removeHeader('Transfer-Encoding');
      chunk = '';
    }
    if (this.statusCode === 205) {
      this.set('Content-Length', '0');
      this.removeHeader('Transfer-Encoding');
      chunk = '';
    }
    if (this.req?.method === 'HEAD') this.end();
    else this.end(chunk as string | undefined);
    return this;
  }

  cookie(name: string, value: unknown, options: CookieOptions = {}): this {
    const opts: CookieOptions = { ...options };
    if (opts.signed) throw new Error('Signed cookies are not supported by the browser Express shim');
    const val = typeof value === 'object' ? `j:${JSON.stringify(value)}` : String(value);
    if (opts.maxAge != null) {
      const maxAge = opts.maxAge - 0;
      if (!Number.isNaN(maxAge)) {
        opts.expires = new Date(Date.now() + maxAge);
        opts.maxAge = Math.floor(maxAge / 1000);
      }
    }
    if (opts.path == null) opts.path = '/';
    return this.append('Set-Cookie', serializeCookie(name, val, opts));
  }

  clearCookie(name: string, options: CookieOptions = {}): this {
    // Express 5: always expire in the past and never send Max-Age.
    const opts: CookieOptions = { path: '/', ...options, expires: new Date(1) };
    delete opts.maxAge;
    return this.cookie(name, '', opts);
  }

  location(url: string): this {
    return this.set('Location', encodeURI(url).replace(/%25([0-9A-Fa-f]{2})/g, '%$1'));
  }

  redirect(statusOrUrl: number | string, maybeUrl?: string): void {
    const status = typeof statusOrUrl === 'number' ? statusOrUrl : 302;
    const url = typeof statusOrUrl === 'number' ? String(maybeUrl) : statusOrUrl;
    this.location(url);
    this.status(status);
    this.type('txt');
    this.send(`${STATUS_TEXT[status] ?? status}. Redirecting to ${this.get('Location')}`);
  }

  sendFile(path: string, ...rest: unknown[]): void {
    const err = httpError(404, `sendFile is not available in the browser edition (${path})`, { code: 'ENOENT' });
    const cb = rest.find((r) => typeof r === 'function') as ((e: unknown) => void) | undefined;
    if (cb) cb(err);
    else this.req.next(err);
  }

  /** Snapshot for dispatch(). */
  toResult(): DispatchResult {
    const headers: Record<string, string | string[]> = {};
    for (const [k, v] of this.headerMap) headers[k] = Array.isArray(v.value) ? v.value.map(String) : String(v.value);
    if (typeof headers['set-cookie'] === 'string') headers['set-cookie'] = [headers['set-cookie']];
    const body = this.chunks.join('');
    // Like Node: a body passed whole to end() gets a Content-Length unless the response has no body.
    const bodiless = this.req?.method === 'HEAD' || this.statusCode === 204 || this.statusCode === 304 || this.statusCode < 200;
    if (!bodiless && !this.streamed && !this.removedContentLength && headers['content-length'] === undefined && headers['transfer-encoding'] === undefined) {
      headers['content-length'] = String(byteLength(body));
    }
    return { status: this.statusCode, headers, body: bodiless ? '' : body };
  }
}

// ---------------------------------------------------------------------------
// Final handler (finalhandler@2 equivalent)
// ---------------------------------------------------------------------------

const HTML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);

function finalHandler(req: Request, res: Response): NextFunction {
  return (err?: unknown) => {
    if (!err && res.headersSent) return;
    let status: number;
    let message: string;
    let extraHeaders: Record<string, HeaderValue> = {};
    if (err) {
      const e = err as { status?: unknown; statusCode?: unknown; headers?: unknown; stack?: string };
      const fromErr = [e.status, e.statusCode].find((s): s is number => typeof s === 'number' && s >= 400 && s < 600);
      if (fromErr === undefined) status = res.statusCode >= 400 && res.statusCode < 600 ? res.statusCode : 500;
      else {
        status = fromErr;
        if (e.headers && typeof e.headers === 'object') extraHeaders = e.headers as Record<string, HeaderValue>;
      }
      // Like Express's default logerror(); the response itself only carries the status text.
      console.error(e?.stack ?? String(err));
      message = STATUS_TEXT[status] ?? String(status);
    } else {
      status = 404;
      message = `Cannot ${req.method} ${encodeURI(pathnameOf(req.originalUrl || req.url)).replace(/%25([0-9A-Fa-f]{2})/g, '%$1')}`;
    }
    if (res.headersSent) {
      if (!res.writableEnded) res.end();
      return;
    }
    const body = `<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<title>Error</title>\n</head>\n<body>\n<pre>${escapeHtml(message)
      .replaceAll('\n', '<br>')
      .replaceAll('  ', ' &nbsp;')}</pre>\n</body>\n</html>\n`;
    res.statusCode = status;
    for (const h of ['Content-Encoding', 'Content-Language', 'Content-Range']) res.removeHeader(h);
    for (const [k, v] of Object.entries(extraHeaders)) res.setHeader(k, v);
    res.setHeader('Content-Security-Policy', "default-src 'none'");
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Length', String(byteLength(body)));
    if (req.method === 'HEAD') res.end();
    else res.end(body);
  };
}

// ---------------------------------------------------------------------------
// Application
// ---------------------------------------------------------------------------

function compileQueryParser(val: unknown): ((s: string) => Query) | undefined {
  if (typeof val === 'function') return val as (s: string) => Query;
  if (val === true || val === 'simple') return parseQueryString;
  if (val === false) return undefined;
  throw new TypeError(`query parser ${JSON.stringify(val)} is not supported by the browser Express shim`);
}

function createApplication(): Express {
  const app = function (req: Request, res: Response, next?: NextFunction) {
    app.handle(req, res, next);
  } as Express;
  const settings: Record<string, any> = Object.create(null);
  let router: Router | null = null;

  const set = (setting: string, ...rest: unknown[]): any => {
    if (rest.length === 0) return settings[setting];
    const value = rest[0];
    settings[setting] = value;
    if (setting === 'trust proxy') settings['trust proxy fn'] = compileTrust(value);
    if (setting === 'query parser') settings['query parser fn'] = compileQueryParser(value);
    return app;
  };

  const props: Record<string, unknown> = {
    settings,
    locals: Object.assign(Object.create(null), { settings }),
    mountpath: '/',
    set,
    enable: (s: string) => set(s, true),
    disable: (s: string) => set(s, false),
    enabled: (s: string) => Boolean(settings[s]),
    disabled: (s: string) => !settings[s],
    route: (path: PathParams) => app.router.route(path),
    listen: () => {
      throw new Error('app.listen() is not available in the browser edition; use dispatch()');
    },
    handle(req: Request, res: Response, callback?: NextFunction) {
      const done = callback ?? finalHandler(req, res);
      if (settings['x-powered-by']) res.setHeader('X-Powered-By', 'Express');
      req.res = res;
      res.req = req;
      req.app = app;
      res.app = app;
      if (!res.locals) res.locals = Object.create(null);
      app.router.handle(req, res, done);
    },
    use(...args: unknown[]) {
      const { path, handlers } = splitPathArgs(args);
      for (const fn of flattenHandlers(handlers)) {
        const sub = fn as unknown as Partial<Express>;
        if (typeof sub.handle !== 'function' || typeof sub.set !== 'function') {
          app.router.use(path, fn as RequestHandler);
          continue;
        }
        // Mounted sub-application.
        (sub as Express).mountpath = path as string;
        app.router.use(path, function mountedApp(req: Request, res: Response, next: NextFunction) {
          const orig = req.app;
          (sub as Express).handle(req, res, (err) => {
            req.app = res.app = orig;
            next(err);
          });
        });
      }
      return app;
    },
    all(path: PathParams, ...handlers: HandlerArgument[]) {
      app.router.route(path).all(...handlers);
      return app;
    },
  };
  for (const method of HTTP_METHODS) {
    props[method] = (path: PathParams, ...handlers: HandlerArgument[]) => {
      if (method === 'get' && handlers.length === 0) return set(path as string);
      app.router.route(path)[method](...handlers);
      return app;
    };
  }
  Object.assign(app, props);
  Object.defineProperty(app, 'router', {
    configurable: true,
    enumerable: true,
    get() {
      router ??= Router({ caseSensitive: Boolean(settings['case sensitive routing']), strict: Boolean(settings['strict routing']) });
      return router;
    },
  });

  set('x-powered-by', true);
  set('etag', 'weak'); // recorded for app.get(); ETags are not generated by the shim
  set('env', 'production');
  set('query parser', 'simple');
  set('subdomain offset', 2);
  set('trust proxy', false);
  set('jsonp callback name', 'callback');
  return app;
}

// ---------------------------------------------------------------------------
// Middleware factories
// ---------------------------------------------------------------------------

const rawBodies = new WeakMap<object, string>();
const consumedBodies = new WeakSet<object>();

export interface JsonOptions {
  limit?: string | number;
  strict?: boolean;
  type?: string | string[] | ((req: Request) => boolean);
  reviver?: (key: string, value: unknown) => unknown;
}

/** body-parser@2 json(): parses `application/json` bodies with the same errors (400 entity.parse.failed, 413 entity.too.large). */
export function json(options: JsonOptions = {}): RequestHandler {
  const limit = options.limit == null ? 102400 : parseBytes(options.limit);
  const strict = options.strict !== false;
  const type = options.type ?? 'application/json';
  const shouldParse = typeof type === 'function' ? type : (req: Request) => typeIs(req.headers['content-type'], Array.isArray(type) ? type : [type]);

  const parse = (body: string): unknown => {
    if (body.length === 0) return {};
    if (strict) {
      const first = /^[\x20\x09\x0a\x0d]*([^\x20\x09\x0a\x0d]|$)/.exec(body)?.[1];
      if (first !== '{' && first !== '[') {
        const index = first ? body.indexOf(first) : -1;
        // Reproduce JSON.parse's message for the offending character, as body-parser does.
        try {
          JSON.parse(index === -1 ? '' : body.slice(0, index) + '#'.repeat(body.length - index));
        } catch (e) {
          const err = e as SyntaxError;
          err.message = err.message.replace(/#+/g, (m) => body.slice(index, index + m.length));
          throw err;
        }
        throw new SyntaxError('strict violation');
      }
    }
    return JSON.parse(body, options.reviver);
  };

  return function jsonParser(req: Request, _res: Response, next: NextFunction) {
    if (consumedBodies.has(req)) return next();
    if (!hasBody(req) || !shouldParse(req)) return next();
    consumedBodies.add(req);

    const charset = (parseContentType(req.headers['content-type'])?.params.charset ?? 'utf-8').toLowerCase();
    if (charset.slice(0, 4) !== 'utf-') {
      return next(httpError(415, `unsupported charset "${charset.toUpperCase()}"`, { charset, type: 'charset.unsupported' }));
    }
    const encoding = String(req.headers['content-encoding'] ?? 'identity').toLowerCase();
    if (encoding !== 'identity') {
      return next(httpError(415, `unsupported content encoding "${encoding}"`, { encoding, type: 'encoding.unsupported' }));
    }
    const raw = rawBodies.get(req) ?? '';
    const length = byteLength(raw);
    const declared = Number.parseInt(String(req.headers['content-length']), 10);
    if (length > limit || (!Number.isNaN(declared) && declared > limit)) {
      return next(httpError(413, 'request entity too large', { expected: Number.isNaN(declared) ? length : declared, length, limit, type: 'entity.too.large' }));
    }
    try {
      req.body = parse(raw);
    } catch (err) {
      return next(httpError(400, err as Error, { body: raw, type: 'entity.parse.failed' }));
    }
    next();
  };
}

/** express.static(): there are no files to serve in the browser edition, so this always falls through. */
function serveStatic(_root?: string, _options?: Record<string, unknown>): RequestHandler {
  return function serveStatic(_req, _res, next) {
    next();
  };
}

// ---------------------------------------------------------------------------
// Transport entry point
// ---------------------------------------------------------------------------

/**
 * Run one request through `app` in-process. Resolves once the response has
 * ended (including after async handlers); it never rejects for HTTP errors.
 *
 * `app` must be an application created by this shim. The parameter is typed
 * loosely so callers compile whether 'express' resolves to these types or to
 * @types/express (e.g. the return type of server/src/app.ts createApp()).
 */
export function dispatch(appLike: Express | ((...args: never[]) => unknown), input: DispatchRequest): Promise<DispatchResult> {
  const app = appLike as Express;
  if (typeof app !== 'function' || typeof app.handle !== 'function' || typeof app.set !== 'function') {
    return Promise.reject(new TypeError('dispatch() expects an application created by the browser Express shim'));
  }
  return new Promise((resolve) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(input.headers ?? {})) headers[k.toLowerCase()] = String(v);
    const method = input.method.toUpperCase();
    let body = input.body;
    if (body === undefined && (method === 'POST' || method === 'PUT' || method === 'PATCH')) body = '';
    if (body !== undefined && headers['content-length'] === undefined && headers['transfer-encoding'] === undefined) {
      headers['content-length'] = String(byteLength(body));
    }
    // Keep only path + query from absolute URLs.
    const url = input.url.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i, '') || '/';

    const req = new ShimRequest(app, { method, url: url.startsWith('/') ? url : `/${url}`, headers, ip: input.ip ?? '127.0.0.1' });
    if (body !== undefined) rawBodies.set(req, body);
    const res = new ShimResponse((r) => resolve(r.toResult()));
    res.req = req;
    res.app = app;
    try {
      app.handle(req, res);
    } catch (err) {
      finalHandler(req, res)(err);
    }
  });
}

// ---------------------------------------------------------------------------
// Default export
// ---------------------------------------------------------------------------

export interface ExpressFactory {
  (): Express;
  json: typeof json;
  static: typeof serveStatic;
  Router: typeof Router;
}

const express: ExpressFactory = Object.assign(createApplication, { json, static: serveStatic, Router });

export default express;
