import { defineConfig } from 'vitest/config';
import base from './vitest.config';

/**
 * Runs the crypto equivalence test, which imports both server/src/lib/crypto.ts
 * and browser/platform/crypto.ts. It deliberately omits swapSources(['crypto'])
 * (used by vitest.shims.config.ts), which would redirect the server import to
 * the browser module.
 */
export default defineConfig({
  ...base,
  test: { ...base.test, include: ['browser/test/crypto-equivalence.shims.test.ts'] },
});
