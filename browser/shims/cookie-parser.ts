/**
 * cookie-parser stand-in for the browser edition (aliased as 'cookie-parser').
 * Parses the Cookie header into req.cookies with cookie@0.7 semantics
 * (first occurrence wins, %-decoding, quoted values, `j:` JSON cookies).
 * Signed cookies need a server secret and are not supported.
 */

interface CookieRequest {
  headers: Record<string, string | string[] | undefined>;
  cookies?: Record<string, any>;
  signedCookies?: Record<string, any>;
  secret?: string;
}

export interface CookieParseOptions {
  decode?: (value: string) => string;
}

export type CookieParserMiddleware = (req: CookieRequest, res: unknown, next: (err?: unknown) => void) => void;

const isBlank = (code: number) => code === 0x20 || code === 0x09;

function decode(value: string): string {
  return value.includes('%') ? decodeURIComponent(value) : value;
}

/** cookie.parse() */
export function parseCookieHeader(str: string, options: CookieParseOptions = {}): Record<string, string> {
  const obj: Record<string, string> = Object.create(null);
  const dec = options.decode ?? decode;
  const len = str.length;
  if (len < 2) return obj;
  let index = 0;
  do {
    const eqIdx = str.indexOf('=', index);
    if (eqIdx === -1) break;
    let endIdx = str.indexOf(';', index);
    if (endIdx === -1) endIdx = len;
    else if (eqIdx > endIdx) {
      index = str.lastIndexOf(';', eqIdx - 1) + 1;
      continue;
    }
    let keyStart = index;
    while (keyStart < eqIdx && isBlank(str.charCodeAt(keyStart))) keyStart++;
    let keyEnd = eqIdx;
    while (keyEnd > keyStart && isBlank(str.charCodeAt(keyEnd - 1))) keyEnd--;
    const key = str.slice(keyStart, keyEnd);
    if (!Object.prototype.hasOwnProperty.call(obj, key)) {
      let valStart = eqIdx + 1;
      while (valStart < endIdx && isBlank(str.charCodeAt(valStart))) valStart++;
      let valEnd = endIdx;
      while (valEnd > valStart && isBlank(str.charCodeAt(valEnd - 1))) valEnd--;
      if (str.charCodeAt(valStart) === 0x22 && str.charCodeAt(valEnd - 1) === 0x22) {
        valStart++;
        valEnd--;
      }
      const raw = str.slice(valStart, valEnd);
      try {
        obj[key] = dec(raw);
      } catch {
        obj[key] = raw;
      }
    }
    index = endIdx + 1;
  } while (index < len);
  return obj;
}

function jsonCookies(obj: Record<string, unknown>): Record<string, unknown> {
  for (const key of Object.keys(obj)) {
    const val = obj[key];
    if (typeof val !== 'string' || !val.startsWith('j:')) continue;
    try {
      const parsed = JSON.parse(val.slice(2));
      if (parsed) obj[key] = parsed;
    } catch {
      /* not a JSON cookie: keep the raw value */
    }
  }
  return obj;
}

export default function cookieParser(secret?: string | string[], options: CookieParseOptions = {}): CookieParserMiddleware {
  if (secret && (!Array.isArray(secret) || secret.length > 0)) {
    throw new Error('Signed cookies are not supported by the browser cookie-parser shim');
  }
  return function cookieParserMiddleware(req, _res, next) {
    if (req.cookies) return next();
    req.secret = undefined;
    req.cookies = Object.create(null);
    req.signedCookies = Object.create(null);
    const header = req.headers.cookie;
    if (!header) return next();
    req.cookies = jsonCookies(parseCookieHeader(Array.isArray(header) ? header.join('; ') : header, options));
    next();
  };
}
