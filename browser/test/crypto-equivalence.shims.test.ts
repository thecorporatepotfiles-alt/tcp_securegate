/**
 * Cross-checks the browser crypto (browser/platform/crypto.ts) against the Node
 * implementation (server/src/lib/crypto.ts).
 *
 * Run with `vitest run -c vitest.crypto.config.ts`. That config has no
 * swapSources(['crypto']) plugin; under a config that has it, the relative import
 * of the server module below would be redirected to the browser module and the
 * comparison would be vacuous, so the first test guards against exactly that.
 */
import nodeCrypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import * as nodeImpl from '../../server/src/lib/crypto.js';
import * as browserImpl from '../platform/crypto.js';

const impls = { node: nodeImpl, browser: browserImpl } as const;
const pairs = [
  ['node', 'browser'],
  ['browser', 'node'],
] as const;

const SECRET = 'test-token-secret-0123456789-abcdefghijklmnop';
const B64URL_RE = /^[A-Za-z0-9_-]*$/;

describe('crypto equivalence: node:crypto vs @noble/hashes', () => {
  it('compares two different implementations (no source swap active)', () => {
    expect(nodeImpl).not.toBe(browserImpl);
    expect(nodeImpl.hashPassword.toString()).toContain('scryptSync');
    expect(browserImpl.hashPassword.toString()).not.toContain('scryptSync');
  });

  it('exports the same names and constants', () => {
    expect(Object.keys(browserImpl).sort()).toEqual(Object.keys(nodeImpl).sort());
    expect(browserImpl.TOKEN_PREFIX).toEqual(nodeImpl.TOKEN_PREFIX);
  });

  describe('passwords', () => {
    const passwords = ['Password12345', 'p\u00e4ssw\u00f6rd \u2713 \u{1F510} \u03a9', '', ' leading and trailing ', 'x'.repeat(200)];

    it.each(pairs)('hashes from %s verify in %s (and wrong passwords fail)', (from, to) => {
      for (const pw of passwords) {
        const stored = impls[from].hashPassword(pw);
        expect(stored).toMatch(/^scrypt\$16384\$8\$1\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{86}$/);
        expect(impls[to].verifyPassword(pw, stored)).toBe(true);
        expect(impls[to].verifyPassword(`${pw}!`, stored)).toBe(false);
      }
    });

    it('derives byte-identical keys for a fixed salt', () => {
      const salt = nodeCrypto.randomBytes(16);
      const key = nodeCrypto.scryptSync('Password12345', salt, 64, { N: 16384, r: 8, p: 1 });
      const stored = ['scrypt', 16384, 8, 1, salt.toString('base64url'), key.toString('base64url')].join('$');
      expect(browserImpl.verifyPassword('Password12345', stored)).toBe(true);
      // Flip one bit of the key: both must reject.
      const tampered = Buffer.from(key);
      tampered[63] ^= 1;
      const bad = ['scrypt', 16384, 8, 1, salt.toString('base64url'), tampered.toString('base64url')].join('$');
      expect(nodeImpl.verifyPassword('Password12345', bad)).toBe(false);
      expect(browserImpl.verifyPassword('Password12345', bad)).toBe(false);
    });

    it('treats unusual but decodable stored hashes the same way (Node base64url leniency)', () => {
      const stored = nodeImpl.hashPassword('Password12345');
      const [, n, r, p, salt, hash] = stored.split('$');
      const std = (s: string) => Buffer.from(s, 'base64url').toString('base64'); // '+/' alphabet with '=' padding
      const variants = [
        [n, r, p, std(salt), std(hash)],
        [n, r, p, `${salt.slice(0, 5)}.${salt.slice(5)}`, `${hash.slice(0, 9)} ${hash.slice(9)}`],
        [n, r, p, salt, hash.slice(0, 43)], // 32-byte key: PBKDF2 output prefix, accepted by both
        [n, r, p, salt, `${hash.slice(0, 43)}=${hash.slice(43)}`], // decoding stops at '='
        [n, r, p, `${salt}A`, hash], // different salt
      ];
      for (const v of variants) {
        const s = ['scrypt', ...v].join('$');
        expect(browserImpl.verifyPassword('Password12345', s), s).toBe(nodeImpl.verifyPassword('Password12345', s));
      }
      for (const s of ['', 'scrypt', 'bcrypt$16384$8$1$a$b', `${stored}$extra`, stored.replace('scrypt', 'SCRYPT')]) {
        expect(nodeImpl.verifyPassword('Password12345', s)).toBe(false);
        expect(browserImpl.verifyPassword('Password12345', s)).toBe(false);
      }
    });

    it('decodes stored base64url exactly like Buffer.from(s, "base64url"), including non-ASCII and surrogates', () => {
      // The key is derived from Node's own decoding of the salt text, so the browser build verifies it
      // only if it decodes that text to the same bytes. Cheap cost parameters keep thousands of cases fast.
      const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
      const odd = ['=', '+', '/', ' ', '\n', '.', '\u0000', 'é', 'Ā', 'Ł', 'Ľ', '一', 'ａ', '\ud83d', '\udd10', '\u{1F510}'];
      const salts = ['QU\u{1F510}JD', 'QUŁJD', 'QUĽJD', 'QUéJD', 'QUJD\ud83d', 'Q', ''];
      for (let i = 0; i < 2000; i++) {
        let s = '';
        for (let j = i % 30; j > 0; j--) s += Math.random() < 0.6 ? alphabet[nodeCrypto.randomInt(64)] : odd[nodeCrypto.randomInt(odd.length)];
        salts.push(s);
      }
      for (const salt of salts) {
        const key = nodeCrypto.scryptSync('pw', Buffer.from(salt, 'base64url'), 16, { N: 2, r: 1, p: 1 });
        const stored = ['scrypt', 2, 1, 1, salt, key.toString('base64url')].join('$');
        expect(nodeImpl.verifyPassword('pw', stored)).toBe(true);
        expect(browserImpl.verifyPassword('pw', stored), JSON.stringify(salt)).toBe(true);
      }
    });

    it('rejects invalid cost parameters in both (throws), e.g. N not a power of two or over the memory cap', () => {
      const [, , , , salt, hash] = nodeImpl.hashPassword('pw').split('$');
      for (const params of [
        [3, 8, 1],
        [32768, 8, 1],
      ]) {
        const s = ['scrypt', ...params, salt, hash].join('$');
        expect(() => nodeImpl.verifyPassword('pw', s)).toThrow();
        expect(() => browserImpl.verifyPassword('pw', s)).toThrow();
      }
    });

    it('a stored hash with an empty key never verifies in either build', () => {
      const [, , , , salt] = nodeImpl.hashPassword('pw').split('$');
      const s = ['scrypt', 16384, 8, 1, salt, ''].join('$');
      expect(nodeImpl.verifyPassword('anything', s)).toBe(false);
      expect(browserImpl.verifyPassword('anything', s)).toBe(false);
    });

    it('DUMMY_PASSWORD_HASH is a well-formed hash that matches no ordinary password', () => {
      for (const impl of Object.values(impls)) {
        expect(impl.DUMMY_PASSWORD_HASH).toMatch(/^scrypt\$16384\$8\$1\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{86}$/);
      }
      expect(nodeImpl.verifyPassword('Password12345', browserImpl.DUMMY_PASSWORD_HASH)).toBe(false);
      expect(browserImpl.verifyPassword('Password12345', nodeImpl.DUMMY_PASSWORD_HASH)).toBe(false);
    });
  });

  describe('hashing and random values', () => {
    it('sha256 hex digests are identical', () => {
      const inputs = ['', 'abc', 'p\u00e4ssw\u00f6rd \u2713 \u{1F510}', '\u0000\uffff', 'x'.repeat(10_000), 'lone surrogate \ud800 here'];
      for (let i = 0; i < 50; i++) inputs.push(nodeCrypto.randomBytes(i * 7).toString('latin1'));
      for (const s of inputs) expect(browserImpl.sha256(s)).toBe(nodeImpl.sha256(s));
      expect(browserImpl.sha256('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    });

    it('randomToken and newNonce have identical lengths and alphabet', () => {
      expect(browserImpl.randomToken()).toHaveLength(nodeImpl.randomToken().length);
      expect(browserImpl.randomToken()).toHaveLength(43);
      for (let n = 0; n <= 70; n++) {
        const t = browserImpl.randomToken(n);
        expect(t).toHaveLength(nodeImpl.randomToken(n).length);
        expect(t).toMatch(B64URL_RE);
      }
      expect(browserImpl.randomToken(100_000)).toHaveLength(nodeImpl.randomToken(100_000).length);
      expect(browserImpl.newNonce()).toMatch(/^[A-Za-z0-9_-]{22}$/);
      expect(nodeImpl.newNonce()).toMatch(/^[A-Za-z0-9_-]{22}$/);
      expect(new Set(Array.from({ length: 100 }, () => browserImpl.newNonce())).size).toBe(100);
    });
  });

  describe('access tokens', () => {
    const kinds = Object.keys(nodeImpl.TOKEN_PREFIX) as nodeImpl.TokenKind[];

    it('mint identical tokens for the same nonce and secret', () => {
      for (const kind of kinds) {
        for (const secret of [SECRET, '\u00fcn\u00efc\u00f8d\u00e9 secret \u2713', 'short']) {
          const nonce = nodeImpl.newNonce();
          expect(browserImpl.makeAccessToken(kind, nonce, secret)).toBe(nodeImpl.makeAccessToken(kind, nonce, secret));
        }
      }
    });

    it.each(pairs)('tokens from %s parse in %s, tampered ones fail with the same reasons', (from, to) => {
      for (const kind of kinds) {
        const nonce = impls[from].newNonce();
        const token = impls[from].makeAccessToken(kind, nonce, SECRET);
        expect(impls[to].parseAccessToken(token, SECRET)).toEqual({ kind, nonce });
        expect(impls[to].parseAccessToken(`  ${token}\n`, SECRET)).toEqual({ kind, nonce });
        expect(impls[to].looksLikeAccessToken(token)).toBe(true);

        const [prefix, , sig] = token.split('.');
        const flipped = sig.slice(0, -1) + (sig.endsWith('A') ? 'B' : 'A');
        const cases = [
          `${prefix}.${nonce}.${flipped}`,
          impls[from].makeAccessToken(kind, nonce, `${SECRET}x`),
          `${prefix}.${impls[from].newNonce()}.${sig}`,
          token.replace(/^SG./, 'SGX'),
          `${token}.extra`,
          `${prefix}.${nonce}`,
          `${prefix}.${nonce.slice(1)}.${sig}`,
          `${prefix}.${nonce}.${sig}=`,
          `${prefix}.${nonce}.${sig.slice(0, 21)}+`,
          token.toLowerCase(),
        ];
        for (const c of cases) {
          const expected = impls[from].parseAccessToken(c, SECRET);
          expect(expected.kind).toBeNull();
          expect(impls[to].parseAccessToken(c, SECRET), c).toEqual(expected);
        }
      }
    });

    it('agree on arbitrary input', () => {
      const samples = ['', '.', '..', 'SGV1..', 'SGV1.x.y', 'sgv1.a.b', 'SGC1.', ' SGT1.abc', 'SGQ1.a', 'SG V1.'];
      for (let i = 0; i < 300; i++) {
        const raw = nodeCrypto.randomBytes(i % 60).toString(i % 2 ? 'base64url' : 'latin1');
        samples.push(raw, `SGV1.${raw}`, `SGT1.${raw.slice(0, 22)}.${raw.slice(22, 44)}`);
      }
      for (const s of samples) {
        expect(browserImpl.parseAccessToken(s, SECRET)).toEqual(nodeImpl.parseAccessToken(s, SECRET));
        expect(browserImpl.looksLikeAccessToken(s)).toBe(nodeImpl.looksLikeAccessToken(s));
      }
    });
  });
});
