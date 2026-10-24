// Bundles the API server for `npm start` and copies SQL migrations next to it.
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';

const outdir = path.resolve('dist/server');
fs.rmSync(outdir, { recursive: true, force: true });
await build({
  entryPoints: { index: 'server/src/index.ts', cli: 'server/src/cli.ts' },
  outdir,
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  packages: 'external',
  sourcemap: true,
  logLevel: 'info',
});
fs.cpSync('server/src/db/migrations', path.join(outdir, 'migrations'), { recursive: true });
console.log('Server bundle written to dist/server (migrations copied).');
