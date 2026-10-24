/**
 * Browser replacement for server/src/lib/crypto.ts (swapped in by resolved path).
 *
 * Same exports, formats and semantics as the Node implementation, built on
 * @noble/hashes and crypto.getRandomValues instead of node:crypto/Buffer, so
 * password hashes and access tokens are interchangeable between the two.
 */
import { scrypt } from '@noble/hashes/scrypt.js';
import { sha256 as sha256Hash } from '@noble/hashes/sha2.js';
import { hmac } from '@noble/hashes/hmac.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 64;
/** Node's scryptSync default memory cap (32 MiB), so oversized parameters are rejected the same way. */
const SCRYPT_MAXMEM = 32 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Byte helpers (Node's Buffer equivalents)
// ---------------------------------------------------------------------------

const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const DECODE = new Int8Array(256).fill(-1);
for (let i = 0; i < 64; i++) DECODE[B64URL.charCodeAt(i)] = i;
// Node's base64url decoder also accepts the standard alphabet.
DECODE['+'.charCodeAt(0)] = 62;
DECODE['/'.charCodeAt(0)] = 63;

/** `Buffer.from(bytes).toString('base64url')`: URL-safe alphabet, no padding. */
function toBase64Url(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += B64URL[n >> 18] + B64URL[(n >> 12) & 63] + B64URL[(n >> 6) & 63] + B64URL[n & 63];
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = bytes[i] << 16;
    out += B64URL[n >> 18] + B64URL[(n >> 12) & 63];
  } else if (rest === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out += B64URL[n >> 18] + B64URL[(n >> 12) & 63] + B64URL[(n >> 6) & 63];
  }
  return out;
}

/**
 * `Buffer.from(str, 'base64url')`, including Node's leniency: characters outside
 * the (standard or URL-safe) alphabet are skipped, decoding stops at the first
 * '=', and a dangling single sextet is dropped. Like Node's decoder, each UTF-16
 * code unit is read by its low byte only (so e.g. U+0141 counts as 'A' and the
 * high surrogate U+D83D as '=').
 */
function fromBase64Url(str: string): Uint8Array {
  const out = new Uint8Array(Math.floor((str.length * 3) / 4) + 3);
  let len = 0;
  let acc = 0;
  let bits = 0;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i) & 0xff;
    if (c === 61 /* '=' */) break;
    const v = DECODE[c];
    if (v < 0) continue;
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[len++] = (acc >> bits) & 0xff;
      acc &= (1 << bits) - 1;
    }
  }
  return out.slice(0, len);
}

function randomBytes(size: number): Uint8Array {
  const out = new Uint8Array(size);
  // getRandomValues fills at most 65536 bytes per call; Node's randomBytes has no such cap.
  for (let i = 0; i < size; i += 65536) globalThis.crypto.getRandomValues(out.subarray(i, Math.min(size, i + 65536)));
  return out;
}

/** Constant-time equality for equal-length inputs (callers check lengths first, as with timingSafeEqual). */
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

function scryptBytes(password: string, salt: Uint8Array, dkLen: number, N: number, r: number, p: number): Uint8Array {
  return scrypt(utf8ToBytes(password), salt, { N, r, p, dkLen, maxmem: SCRYPT_MAXMEM });
}

// ---------------------------------------------------------------------------
// Passwords & general-purpose helpers
// ---------------------------------------------------------------------------

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptBytes(password, salt, KEY_LEN, SCRYPT_N, SCRYPT_R, SCRYPT_P);
  return ['scrypt', SCRYPT_N, SCRYPT_R, SCRYPT_P, toBase64Url(salt), toBase64Url(hash)].join('$');
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, saltB64, hashB64] = parts;
  const expected = fromBase64Url(hashB64);
  // A zero-length key cannot be derived (RFC 7914); never treat an empty stored hash as a match.
  if (expected.length === 0) return false;
  const actual = scryptBytes(password, fromBase64Url(saltB64), expected.length, Number(n), Number(r), Number(p));
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/** Used to equalise timing when a username does not exist. */
export const DUMMY_PASSWORD_HASH = hashPassword(bytesToHex(randomBytes(12)));

export function randomToken(bytes = 32): string {
  return toBase64Url(randomBytes(bytes));
}

export function sha256(input: string): string {
  return bytesToHex(sha256Hash(utf8ToBytes(input)));
}

// ---------------------------------------------------------------------------
// Opaque access tokens (QR payloads); see server/src/lib/crypto.ts for the design.
// token = <prefix>.<nonce>.<mac>; mac = HMAC-SHA256(secret, prefix.nonce)[0..16)
// ---------------------------------------------------------------------------

export const TOKEN_PREFIX = {
  VISIT_PASS: 'SGV1',
  TEMPORARY_ACCESS: 'SGT1',
  CONTRACTOR: 'SGC1',
} as const;
export type TokenKind = keyof typeof TOKEN_PREFIX;

export function newNonce(): string {
  return toBase64Url(randomBytes(16));
}

function mac(secret: string, prefix: string, nonce: string): string {
  return toBase64Url(hmac(sha256Hash, utf8ToBytes(secret), utf8ToBytes(`${prefix}.${nonce}`)).subarray(0, 16));
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
  const expected = utf8ToBytes(mac(secret, prefix, nonce));
  const provided = utf8ToBytes(providedMac);
  if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) {
    return { kind: null, reason: 'BAD_SIGNATURE' };
  }
  return { kind, nonce };
}

export function looksLikeAccessToken(raw: string): boolean {
  return /^SG[VTC]1\./.test(raw.trim());
}
