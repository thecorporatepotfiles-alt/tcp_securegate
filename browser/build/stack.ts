/**
 * Module substitutions that let the unmodified server code run in a browser.
 *
 * - `aliases` replace whole npm packages (matched exactly by import specifier).
 * - `swaps` replace individual server source files by resolved path.
 *
 * Shared by the browser bundle (vite.browser.config.ts) and by the Vitest
 * configurations that run the server test suite through the same shims.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Alias, Plugin } from 'vite';

const root = fileURLToPath(new URL('../..', import.meta.url));
const r = (p: string) => path.join(root, p);

/** Package shims, keyed by import specifier. */
export const PACKAGE_SHIMS = {
  'better-sqlite3': r('browser/shims/better-sqlite3.ts'),
  express: r('browser/shims/express.ts'),
  helmet: r('browser/shims/helmet.ts'),
  'cookie-parser': r('browser/shims/cookie-parser.ts'),
  supertest: r('browser/shims/supertest.ts'),
} as const;

/** Node built-ins referenced (but not exercised) by modules in the browser bundle. */
export const NODE_BUILTIN_STUBS = {
  'node:fs': r('browser/shims/node-fs.ts'),
  'node:path': r('browser/shims/node-path.ts'),
  'node:url': r('browser/shims/node-url.ts'),
} as const;

/** Server source files replaced by browser implementations (resolved path → replacement). */
export const SOURCE_SWAPS = {
  crypto: { from: r('server/src/lib/crypto.ts'), to: r('browser/platform/crypto.ts') },
  migrations: { from: r('server/src/db/migrationSource.ts'), to: r('browser/platform/migrationSource.ts') },
} as const;

export function packageAliases(names: (keyof typeof PACKAGE_SHIMS)[]): Alias[] {
  return names.map((n) => ({ find: new RegExp(`^${n}$`), replacement: PACKAGE_SHIMS[n] }));
}

export function builtinAliases(): Alias[] {
  return Object.entries(NODE_BUILTIN_STUBS).flatMap(([spec, file]) => [
    { find: new RegExp(`^${spec}$`), replacement: file },
    { find: new RegExp(`^${spec.slice(5)}$`), replacement: file },
  ]);
}

/** Vite/Vitest plugin redirecting resolved server source files to their browser replacements. */
export function swapSources(names: (keyof typeof SOURCE_SWAPS)[]): Plugin {
  const map = new Map(names.map((n) => [SOURCE_SWAPS[n].from, SOURCE_SWAPS[n].to]));
  return {
    name: 'securegate-swap-sources',
    enforce: 'pre',
    async resolveId(source, importer, options) {
      if (!importer || !source.startsWith('.')) return null;
      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
      const target = resolved && map.get(resolved.id.split('?')[0]);
      return target ?? null;
    },
  };
}
