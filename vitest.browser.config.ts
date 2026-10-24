/**
 * Runs the server test suite through the browser edition's substitutions
 * (sql.js, the Express shim, the noble-based crypto) instead of the native
 * Node stack. See browser/build/stack.ts and docs/BROWSER_EDITION.md.
 */
import { defineConfig, mergeConfig } from 'vitest/config';
import base from './vitest.config';
import { packageAliases, swapSources } from './browser/build/stack';

export default mergeConfig(
  base,
  defineConfig({
    plugins: [swapSources(['crypto', 'migrations'])],
    resolve: { alias: packageAliases(['better-sqlite3', 'express', 'helmet', 'cookie-parser', 'supertest']) },
    test: {
      include: ['server/test/**/*.test.ts'],
      setupFiles: ['browser/test/setup-sqljs.ts'],
    },
  }),
);
