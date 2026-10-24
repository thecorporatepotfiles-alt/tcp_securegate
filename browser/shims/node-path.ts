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
  let start = 0;
  let end = -1;
  let matchedSlash = true;
  if (suffix !== undefined && suffix.length > 0 && suffix.length <= path.length) {
    if (suffix === path) return '';
    let extIdx = suffix.length - 1;
    let firstNonSlashEnd = -1;
    for (let i = path.length - 1; i >= 0; --i) {
      if (path[i] === '/') {
        if (!matchedSlash) {
          start = i + 1;
          break;
        }
      } else {
        if (firstNonSlashEnd === -1) {
          matchedSlash = false;
          firstNonSlashEnd = i + 1;
        }
        if (extIdx >= 0) {
          if (path[i] === suffix[extIdx]) {
            if (--extIdx === -1) end = i;
          } else {
            extIdx = -1;
            end = firstNonSlashEnd;
          }
        }
      }
    }
    if (start === end) end = firstNonSlashEnd;
    else if (end === -1) end = path.length;
    return path.slice(start, end);
  }
  for (let i = path.length - 1; i >= 0; --i) {
    if (path[i] === '/') {
      if (!matchedSlash) {
        start = i + 1;
        break;
      }
    } else if (end === -1) {
      matchedSlash = false;
      end = i + 1;
    }
  }
  return end === -1 ? '' : path.slice(start, end);
}

export function extname(path: string): string {
  let startDot = -1;
  let startPart = 0;
  let end = -1;
  let matchedSlash = true;
  // 0: nothing seen before the dot yet, 1: only dots, -1: a regular character.
  let preDotState = 0;
  for (let i = path.length - 1; i >= 0; --i) {
    const char = path[i];
    if (char === '/') {
      if (!matchedSlash) {
        startPart = i + 1;
        break;
      }
      continue;
    }
    if (end === -1) {
      matchedSlash = false;
      end = i + 1;
    }
    if (char === '.') {
      if (startDot === -1) startDot = i;
      else if (preDotState !== 1) preDotState = 1;
    } else if (startDot !== -1) {
      preDotState = -1;
    }
  }
  if (startDot === -1 || end === -1 || preDotState === 0 || (preDotState === 1 && startDot === end - 1 && startDot === startPart + 1)) {
    return '';
  }
  return path.slice(startDot, end);
}

export function relative(from: string, to: string): string {
  if (from === to) return '';
  const f = resolve(from).split('/').filter(Boolean);
  const t = resolve(to).split('/').filter(Boolean);
  let i = 0;
  while (i < f.length && i < t.length && f[i] === t[i]) i++;
  return [...Array(f.length - i).fill('..'), ...t.slice(i)].join('/');
}

const posixPath = { sep, delimiter, normalize, isAbsolute, join, resolve, dirname, basename, extname, relative };
export const posix = posixPath;

export default { ...posixPath, posix: posixPath };
