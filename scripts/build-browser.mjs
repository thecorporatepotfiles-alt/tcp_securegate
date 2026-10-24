// Builds the browser edition and inlines it into one self-contained HTML file:
//   dist/browser/securegate.html
// The file is written in the shape the claude.ai Artifact publisher expects
// (title and style first, no document skeleton); scripts/serve-browser.mjs
// wraps it in a full document for local use.
import { build } from 'vite';
import fs from 'node:fs';
import path from 'node:path';

const buildDir = path.resolve('dist/browser-build');
const outDir = path.resolve('dist/browser');

await build({ configFile: path.resolve('vite.browser.config.ts'), logLevel: 'warn' });

const html = fs.readFileSync(path.join(buildDir, 'index.html'), 'utf8');
const read = (ref) => fs.readFileSync(path.join(buildDir, ref.replace(/^\.\//, '')), 'utf8');

const scripts = [...html.matchAll(/<script type="module"[^>]*src="([^"]+)"[^>]*><\/script>/g)].map((m) => m[1]);
const styles = [...html.matchAll(/<link rel="stylesheet"[^>]*href="([^"]+)"[^>]*>/g)].map((m) => m[1]);
if (scripts.length !== 1) throw new Error(`Expected one module script in the build output, found ${scripts.length}`);
const leftovers = fs.readdirSync(path.join(buildDir, 'assets')).filter((f) => !/\.(js|css)$/.test(f));
if (leftovers.length) throw new Error(`Non-inlined assets in the build output: ${leftovers.join(', ')}`);

// Inline content must not close its own element or open an HTML comment.
const js = read(scripts[0]).replace(/<\/script/gi, '<\\/script').replace(/<!--/g, '<\\!--');
const css = styles.map(read).join('\n').replace(/<\/style/gi, '<\\/style');

const page = [
  '<title>TCP SecureGate</title>',
  `<style>${css}</style>`,
  '<div id="root"></div>',
  `<script type="module">${js}</script>`,
  '',
].join('\n');

fs.mkdirSync(outDir, { recursive: true });
const file = path.join(outDir, 'securegate.html');
fs.writeFileSync(file, page);
console.log(`Browser edition written to ${path.relative(process.cwd(), file)} (${(Buffer.byteLength(page) / 1024 / 1024).toFixed(2)} MB)`);
