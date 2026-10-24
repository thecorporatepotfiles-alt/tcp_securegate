// Serves the single-file browser edition locally, wrapped in the same minimal
// document the Artifact publisher uses. Also writes dist/browser/index.html,
// which can be opened directly from disk.
//
//   npm run build:browser && npm run serve:browser   → http://127.0.0.1:4310
//
// Options: --port <n>   --csp strict   (strict = no eval/WebAssembly, no network; exercises the asm.js fallback)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const port = Number(opt('port', process.env.PORT ?? 4310));
const csp = opt('csp', 'none');

const content = fs.readFileSync(path.resolve('dist/browser/securegate.html'), 'utf8');
export const page =
  '<!doctype html><html><head><meta charset=utf8><meta name=viewport content="width=device-width,initial-scale=1,viewport-fit=cover">' +
  '<style>*,*::before,*::after{box-sizing:border-box}html,body{margin:0;padding:0}</style></head><body>' +
  content +
  '</body></html>';
fs.writeFileSync(path.resolve('dist/browser/index.html'), page);

const STRICT_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  'img-src data: blob:',
  'font-src data:',
  "connect-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

http
  .createServer((req, res) => {
    if (req.method !== 'GET' || (req.url !== '/' && !req.url.startsWith('/?'))) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
      return;
    }
    const headers = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' };
    if (csp === 'strict') headers['content-security-policy'] = STRICT_CSP;
    res.writeHead(200, headers).end(page);
  })
  .listen(port, '127.0.0.1', () => console.log(`Browser edition at http://127.0.0.1:${port}${csp === 'strict' ? ' (strict CSP)' : ''}`));
