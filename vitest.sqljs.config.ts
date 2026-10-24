import { defineConfig, mergeConfig } from 'vitest/config';
import base from './vitest.config';
import { packageAliases } from './browser/build/stack';

/** The server test suite with better-sqlite3 replaced by the sql.js shim, plus the shim's own tests. */
const config = mergeConfig(
  base,
  defineConfig({
    resolve: { alias: packageAliases(['better-sqlite3']) },
    test: { setupFiles: ['browser/test/setup-sqljs.ts'] },
  }),
);
// Replace (not concatenate) the base include list.
config.test!.include = ['server/test/**/*.test.ts', 'browser/test/**/*.sqlite.test.ts'];

export default config;
