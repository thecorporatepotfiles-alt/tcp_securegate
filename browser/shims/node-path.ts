/** node:path stand-in for the browser bundle: the POSIX implementation, with '/' as the working directory. */

export const sep = '/';
export const delimiter = ':';

function cwd(): string {
  const proc = (globalThis as { process?: { cwd?: () => string } }).process;
  try {
    return proc?.cwd?.() ?? '/';
  } catch {
    return '/';
  }
}

/** Resolve '.' and '..' segments (path.posix normalizeString). */
function normalizeSegments(path: string, allowAboveRoot: boolean): string {
  const out: string[] = [];
  for (const seg of path.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (out.length && out[out.length - 1] !== '..') out.pop();
      else if (allowAboveRoot) out.push('..');
    } else out.push(seg);
  }
  return out.join('/');
}

export function normalize(path: string): string {
  if (path.length === 0) return '.';
  const isAbsolute = path.startsWith('/');
  const trailing = path.endsWith('/');
  let out = normalizeSegments(path, !isAbsolute);
  if (out.length === 0) {
    if (isAbsolute) return '/';
    return trailing ? './' : '.';
  }
  if (trailing) out += '/';
  return isAbsolute ? `/${out}` : out;
}

export function isAbsolute(path: string): boolean {
  return path.startsWith('/');
}

export function join(...paths: string[]): string {
  const joined = paths.filter((p) => {
    if (typeof p !== 'string') throw new TypeError('The "path" argument must be of type string');
    return p.length > 0;
  });
  return joined.length === 0 ? '.' : normalize(joined.join('/'));
}

export function resolve(...paths: string[]): string {
  let resolved = '';
  let absolute = false;
  for (let i = paths.length - 1; i >= -1 && !absolute; i--) {
    const p = i >= 0 ? paths[i] : cwd();
    if (typeof p !== 'string') throw new TypeError('The "path" argument must be of type string');
    if (p.length === 0) continue;
    resolved = `${p}/${resolved}`;
    absolute = p.startsWith('/');
  }
  const out = normalizeSegments(resolved, !absolute);
  return absolute ? `/${out}` : out || '.';
}

export function dirname(path: string): string {
  if (path.length === 0) return '.';
  const hasRoot = path.startsWith('/');
  let end = -1;
  let matchedSlash = true;
  for (let i = path.length - 1; i >= 1; i--) {
    if (path[i] === '/') {
      if (!matchedSlash) {
        end = i;
        break;
      }
    } else matchedSlash = false;
  }
  if (end === -1) return hasRoot ? '/' : '.';
  if (hasRoot && end === 1) return '//';
  return path.slice(0, end);
}

export function basename(path: string, suffix?: string): string {
  let end = path.length;
  while (end > 1 && path[end - 1] === '/') end--;
  const trimmed = path.slice(0, end);
  let base = trimmed.slice(trimmed.lastIndexOf('/') + 1);
  if (base === '' && trimmed === '/') base = '';
  if (suffix && base !== suffix && base.endsWith(suffix)) base = base.slice(0, -suffix.length);
  return base;
}

export function extname(path: string): string {
  const base = basename(path);
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? '' : base.slice(dot);
}

export function relative(from: string, to: string): string {
  if (from === to) return '';
  const f = resolve(from).split('/').filter(Boolean);
  const t = resolve(to).split('/').filter(Boolean);
  let i = 0;
  while (i < f.length && i < t.length && f[i] === t[i]) i++;
  return [...Array(f.length - i).fill('..'), ...t.slice(i)].join('/');
}

export interface ParsedPath {
  root: string;
  dir: string;
  base: string;
  ext: string;
  name: string;
}

export function parse(path: string): ParsedPath {
  const root = path.startsWith('/') ? '/' : '';
  const base = basename(path);
  const ext = extname(path);
  const dir = path.includes('/') ? dirname(path) : '';
  return { root, dir, base, ext, name: ext ? base.slice(0, -ext.length) : base };
}

export function format(p: Partial<ParsedPath>): string {
  const dir = p.dir || p.root || '';
  const base = p.base || `${p.name ?? ''}${p.ext ? (p.ext.startsWith('.') ? '' : '.') + p.ext : ''}`;
  if (!dir) return base;
  return dir === p.root ? `${dir}${base}` : `${dir}/${base}`;
}

export function toNamespacedPath(path: string): string {
  return path;
}

const posixPath = { sep, delimiter, normalize, isAbsolute, join, resolve, dirname, basename, extname, relative, parse, format, toNamespacedPath };
export const posix = posixPath;

export default { ...posixPath, posix: posixPath };
