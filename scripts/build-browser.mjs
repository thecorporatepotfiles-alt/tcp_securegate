// Builds the browser edition and inlines it into one self-contained HTML file:
//   dist/browser/securegate.html
// The file is written in the shape the claude.ai Artifact publisher expects
// (title and style first, no document skeleton); scripts/serve-browser.mjs
// wraps it in a full document for local use.
//
// Every build is stamped with the git commit, whether the working tree had
// other changes, and the build time: in an HTML comment at the top of the file
// and as window.__SG_BROWSER__.build at runtime. scripts/e2e-browser.cjs and
// scripts/serve-browser.mjs compare the stamp with the checkout.
import { build } from 'vite';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const buildDir = path.resolve('dist/browser-build');
const outDir = path.resolve(process.env.SG_BROWSER_OUT_DIR ?? 'dist/browser');

/** Commit, dirty flag (uncommitted changes outside dist/ and screenshots/) and build time. */
function buildStamp() {
  const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  try {
    const changed = git('status', '--porcelain', '--untracked-files=all')
      .split('\n')
      .filter((line) => line && !/^.. "?(dist|screenshots)\//.test(line));
    return { commit: git('rev-parse', '--short', 'HEAD'), dirty: changed.length > 0, builtAt: new Date().toISOString() };
  } catch {
    return { commit: 'unknown', dirty: true, builtAt: new Date().toISOString() }; // not a git checkout
  }
}

const stamp = buildStamp();
await build({ configFile: path.resolve('vite.browser.config.ts'), logLevel: 'warn', define: { __SG_BUILD__: JSON.stringify(stamp) } });

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
  `<!-- sg-build commit=${stamp.commit} dirty=${stamp.dirty ? 'yes' : 'no'} built=${stamp.builtAt} -->`,
  `<style>${css}</style>`,
  '<div id="root"></div>',
  `<script type="module">${js}</script>`,
  '',
].join('\n');

fs.mkdirSync(outDir, { recursive: true });
const file = path.join(outDir, 'securegate.html');
fs.writeFileSync(file, page);
console.log(`Browser edition written to ${path.relative(process.cwd(), file)} (${(Buffer.byteLength(page) / 1024 / 1024).toFixed(2)} MB)`);
console.log(`Build stamp: commit ${stamp.commit}${stamp.dirty ? ' with uncommitted changes' : ''}, built ${stamp.builtAt}`);
if (process.env.SG_BROWSER_OUT_DIR) {
  // dist/browser is what serve:browser and e2e:browser use; say plainly that it was not updated.
  console.warn(`\n*** SG_BROWSER_OUT_DIR is set: dist/browser/securegate.html was NOT updated by this build. ***\n`);
}
