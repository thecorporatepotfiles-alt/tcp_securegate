import crypto from 'node:crypto';

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 64;

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, KEY_LEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return ['scrypt', SCRYPT_N, SCRYPT_R, SCRYPT_P, salt.toString('base64url'), hash.toString('base64url')].join('$');
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, saltB64, hashB64] = parts;
  const expected = Buffer.from(hashB64, 'base64url');
  // A zero-length key would compare two empty buffers as equal and accept any password.
  if (expected.length === 0) return false;
  const actual = crypto.scryptSync(password, Buffer.from(saltB64, 'base64url'), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
  });
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

/** Used to equalise timing when a username does not exist. */
export const DUMMY_PASSWORD_HASH = hashPassword(crypto.randomBytes(12).toString('hex'));

export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function sha256(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

// ---------------------------------------------------------------------------
// Opaque access tokens (QR payloads)
//
// token = <prefix>.<nonce>.<mac>
//   nonce: 128 random bits stored in the database (lookup key)
//   mac:   HMAC-SHA256(secret, prefix.nonce) truncated to 128 bits
// The QR therefore carries no personal information. A leaked database alone
// cannot be used to mint valid tokens without the server secret, and the
// server can re-render a pass QR without storing the token itself.
// ---------------------------------------------------------------------------

export const TOKEN_PREFIX = {
  VISIT_PASS: 'SGV1',
  TEMPORARY_ACCESS: 'SGT1',
  CONTRACTOR: 'SGC1',
} as const;
export type TokenKind = keyof typeof TOKEN_PREFIX;

export function newNonce(): string {
  return crypto.randomBytes(16).toString('base64url');
}

function mac(secret: string, prefix: string, nonce: string): string {
  return crypto.createHmac('sha256', secret).update(`${prefix}.${nonce}`).digest().subarray(0, 16).toString('base64url');
}

export function makeAccessToken(kind: TokenKind, nonce: string, secret: string): string {
  const prefix = TOKEN_PREFIX[kind];
  return `${prefix}.${nonce}.${mac(secret, prefix, nonce)}`;
}

export type ParsedToken = { kind: TokenKind; nonce: string } | { kind: null; reason: 'MALFORMED' | 'BAD_SIGNATURE' };

export function parseAccessToken(raw: string, secret: string): ParsedToken {
  const parts = raw.trim().split('.');
  if (parts.length !== 3) return { kind: null, reason: 'MALFORMED' };
  const [prefix, nonce, providedMac] = parts;
  const kind = (Object.keys(TOKEN_PREFIX) as TokenKind[]).find((k) => TOKEN_PREFIX[k] === prefix);
  if (!kind || !/^[A-Za-z0-9_-]{22}$/.test(nonce) || !/^[A-Za-z0-9_-]{22}$/.test(providedMac)) {
    return { kind: null, reason: 'MALFORMED' };
  }
  const expected = Buffer.from(mac(secret, prefix, nonce));
  const provided = Buffer.from(providedMac);
  if (expected.length !== provided.length || !crypto.timingSafeEqual(expected, provided)) {
    return { kind: null, reason: 'BAD_SIGNATURE' };
  }
  return { kind, nonce };
}

export function looksLikeAccessToken(raw: string): boolean {
  return /^SG[VTC]1\./.test(raw.trim());
}
