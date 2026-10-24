/** node:url stand-in for the browser bundle (file: URL <-> POSIX path conversion only). */
import { resolve } from './node-path';

export function fileURLToPath(url: string | URL): string {
  const u = typeof url === 'string' ? new URL(url) : url;
  if (u.protocol !== 'file:') throw new TypeError('The URL must be of scheme file');
  if (u.hostname !== '' && u.hostname !== 'localhost') throw new TypeError('File URL host must be "localhost" or empty');
  if (/%2f/i.test(u.pathname)) throw new TypeError('File URL path must not include encoded / characters');
  return decodeURIComponent(u.pathname);
}

const RAW_PATH_CHAR = /^[A-Za-z0-9!$&'()*+,\-./:;=@_]$/;
const encoder = new TextEncoder();

/**
 * Like Node 22: resolve against the working directory ('/' in the browser), keep a trailing slash, and
 * percent-encode (UTF-8) every character outside the set Node leaves raw, so URL parsing changes nothing.
 */
export function pathToFileURL(path: string): URL {
  let resolved = resolve(path);
  if (path.endsWith('/') && !resolved.endsWith('/')) resolved += '/';
  // Node's URL parse drops a trailing run of C0 controls (it pre-encodes only NUL, tab, LF and CR).
  resolved = resolved.replace(/[\x01-\x08\x0b\x0c\x0e-\x1f]+$/, '');
  let encoded = '';
  for (const ch of resolved) {
    if (RAW_PATH_CHAR.test(ch)) encoded += ch;
    else for (const b of encoder.encode(ch)) encoded += `%${b.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return new URL(`file://${encoded}`);
}

export default { fileURLToPath, pathToFileURL };
