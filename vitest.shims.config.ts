import { mergeConfig } from 'vitest/config';
import base from './vitest.config';
import { packageAliases, swapSources } from './browser/build/stack';

/**
 * Runs the server test suite (real better-sqlite3) through the browser shims
 * for express/helmet/cookie-parser/supertest and the browser crypto module,
 * plus the shim tests. The crypto equivalence test needs both crypto modules
 * unswapped, so it runs under vitest.crypto.config.ts instead.
 */
const config = mergeConfig(base, {
  resolve: { alias: packageAliases(['express', 'helmet', 'cookie-parser', 'supertest']) },
  plugins: [swapSources(['crypto'])],
});

// mergeConfig concatenates arrays; set the file selection explicitly.
config.test = {
  ...config.test,
  include: ['server/test/**/*.test.ts', 'browser/test/**/*.shims.test.ts'],
  exclude: ['**/node_modules/**', 'browser/test/crypto-equivalence.shims.test.ts'],
};

export default config;
