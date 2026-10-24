/**
 * Browser smoke test for the single-file browser edition.
 *
 *   npm run build:browser && npm run e2e:browser
 *
 * Serves dist/browser/securegate.html the way the Artifact publisher wraps it, then with Chromium:
 *  - boots the in-page server under a permissive policy (WebAssembly engine) and under a strict
 *    content security policy with no network access (asm.js fallback engine),
 *  - signs in through the demo role selector,
 *  - opens every major screen at desktop, tablet and mobile widths, failing on page errors,
 *    console errors, missing headings or horizontal overflow,
 *  - exports a report as CSV through a stand-in for the platform downloads capability,
 *  - clicks through the gate flow and confirms the recorded event survives a reload,
 *  - checks that the page made no network requests other than loading itself.
 * Screenshots are written to ./screenshots/browser (git-ignored).
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  console.error('Playwright is not installed. Run: npm i -D playwright && npx playwright install chromium');
  process.exit(2);
}

const PORT = Number(process.env.E2E_BROWSER_PORT ?? 4311);
const STRICT_PORT = PORT + 1;
const OUT = path.resolve('screenshots/browser');
const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'tablet', width: 820, height: 1180 },
  { name: 'mobile', width: 390, height: 844 },
];
const PAGES = [
  '/dashboard', '/presence', '/register', '/waiting-list', '/visitors', '/visitors/new', '/approvals', '/personnel', '/personnel/new',
  '/credentials', '/contractors', '/temporary-access', '/vehicles', '/deliveries', '/alerts', '/manual-reviews', '/exceptions',
  '/handover', '/reports', '/reports/daily-movement', '/audit', '/notifications', '/account',
  '/admin/users', '/admin/roles', '/admin/locations', '/admin/settings', '/admin/system',
];
const DETAIL_SOURCES = [
  ['/personnel?pageSize=1', '/personnel'],
  ['/credentials?pageSize=1', '/credentials'],
  ['/visits?pageSize=1&status=APPROVED', '/visitors'],
  ['/contractors?pageSize=1', '/contractors/people'],
  ['/temporary-access?pageSize=1', '/temporary-access'],
  ['/vehicles?pageSize=1', '/vehicles'],
  ['/deliveries?pageSize=1', '/deliveries'],
  ['/alerts?pageSize=1', '/alerts'],
  ['/exceptions?pageSize=1', '/exceptions'],
  ['/events?pageSize=1', '/events'],
  ['/personnel?pageSize=1', '/personnel', '/edit'],
];

/** Stand-in for the claude.ai viewer: exposes only `use()`, resolving the downloads capability. */
function installViewerStub() {
  const saved = [];
  window.__savedFiles = saved;
  const downloads = Object.freeze({
    async save({ filename, data }) {
      const size = typeof data === 'string' ? data.length : (data.size ?? data.byteLength ?? 0);
      const text = typeof data === 'string' ? data : data instanceof Blob ? await data.text() : '';
      saved.push({ filename, size, head: text.slice(0, 200) });
      return { status: 'saved' };
    },
  });
  window.claude = Object.freeze({ use: (name) => new Promise((r) => setTimeout(() => r(name === 'downloads' ? downloads : null), 50)) });
}

function serve(port, csp) {
  const proc = spawn(process.execPath, ['scripts/serve-browser.mjs', '--port', String(port), '--csp', csp], { stdio: ['ignore', 'pipe', 'pipe'] });
  proc.stderr.on('data', (d) => process.stderr.write(`[serve] ${d}`));
  return new Promise((resolve, reject) => {
    proc.stdout.on('data', (d) => /Browser edition at/.test(String(d)) && resolve(proc));
    proc.on('exit', (code) => reject(new Error(`serve exited with ${code}`)));
  });
}

function watch(page, base) {
  const errors = [];
  const requests = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && !/status of 40[134]/.test(m.text()) && errors.push(`console: ${m.text()}`));
  page.on('request', (r) => {
    const u = r.url();
    if (!u.startsWith('data:') && !u.startsWith('blob:') && u !== `${base}/`) requests.push(u);
  });
  return { errors, requests };
}

async function boot(page, base) {
  const t0 = Date.now();
  await page.goto(`${base}/`);
  await page.getByRole('button', { name: /System Administrator/ }).first().waitFor({ timeout: 90_000 });
  const host = await page.evaluate(() => ({ engine: window.__SG_BROWSER__?.engine, storage: window.__SG_BROWSER__?.storage }));
  return { ms: Date.now() - t0, ...host };
}

async function signIn(page, roleName) {
  await page.getByRole('button', { name: new RegExp(roleName) }).first().click();
  await page.locator('h1').first().waitFor({ timeout: 20_000 });
}

async function go(page, route) {
  await page.evaluate((r) => {
    window.location.hash = `#${r}`;
  }, route);
  await page.waitForTimeout(150);
  await page.locator('h1').first().waitFor({ timeout: 15_000 }).catch(() => undefined);
  await page.waitForTimeout(450);
}

const apiGet = (page, p) => page.evaluate((u) => fetch(`/api${u}`).then((r) => r.json()), p);

async function main() {
  if (!fs.existsSync('dist/browser/securegate.html')) {
    console.error('Build first: npm run build:browser');
    process.exit(2);
  }
  fs.mkdirSync(OUT, { recursive: true });
  const servers = [await serve(PORT, 'none'), await serve(STRICT_PORT, 'strict')];
  const BASE = `http://127.0.0.1:${PORT}`;
  const STRICT = `http://127.0.0.1:${STRICT_PORT}`;
  const failures = [];
  const notes = [];
  let checked = 0;
  const browser = await chromium.launch();
  try {
    // ---- Strict policy: no eval, no WebAssembly, no network → asm.js engine must still work.
    {
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
      const page = await ctx.newPage();
      const w = watch(page, STRICT);
      const b = await boot(page, STRICT);
      notes.push(`strict CSP boot: ${b.ms} ms, engine ${b.engine}, storage ${b.storage}`);
      if (b.engine !== 'asm') failures.push(`strict CSP: expected asm.js engine, got ${b.engine}`);
      await signIn(page, 'Security Guard');
      await page.screenshot({ path: path.join(OUT, 'strict_guard_home.png') });
      const errs = w.errors.filter((e) => !/WebAssembly|wasm/i.test(e));
      if (errs.length) failures.push(`strict CSP: ${errs.join(' | ')}`);
      if (w.requests.length) failures.push(`strict CSP: unexpected network requests: ${w.requests.join(', ')}`);
      checked += 1;
      await ctx.close();
    }

    // ---- Every screen at three widths.
    for (const vp of VIEWPORTS) {
      const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
      await ctx.addInitScript(installViewerStub);
      const page = await ctx.newPage();
      const w = watch(page, BASE);
      const b = await boot(page, BASE);
      notes.push(`${vp.name} boot (fresh dataset): ${b.ms} ms, engine ${b.engine}, storage ${b.storage}`);
      if (b.engine !== 'wasm') failures.push(`${vp.name}: expected WebAssembly engine, got ${b.engine}`);
      await signIn(page, 'System Administrator');

      const detailRoutes = [];
      for (const [api, route, suffix] of DETAIL_SOURCES) {
        const body = await apiGet(page, api).catch(() => ({}));
        const first = (body.items ?? body)[0];
        if (first?.id) detailRoutes.push(`${route}/${first.id}${suffix ?? ''}`);
      }
      for (const route of [...PAGES, ...detailRoutes]) {
        w.errors.length = 0;
        await go(page, route);
        const h1 = await page.locator('h1').first().isVisible().catch(() => false);
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        if (!h1) failures.push(`${vp.name} ${route}: no page heading`);
        if (overflow > 1) failures.push(`${vp.name} ${route}: horizontal overflow ${overflow}px`);
        if (w.errors.length) failures.push(`${vp.name} ${route}: ${w.errors.join(' | ')}`);
        await page.screenshot({ path: path.join(OUT, `${vp.name}${route.replace(/\//g, '_')}.png`) });
        checked++;
      }

      if (vp.name === 'desktop') {
        // CSV export through the downloads capability.
        await go(page, '/reports/daily-movement');
        const exportBtn = page.getByRole('button', { name: /Export CSV/i }).first();
        if (await exportBtn.isVisible().catch(() => false)) {
          await exportBtn.click();
          await page.waitForTimeout(1200);
          const saved = await page.evaluate(() => window.__savedFiles ?? []);
          const csv = saved.find((f) => /\.csv$/.test(f.filename));
          if (!csv || csv.size === 0) failures.push(`CSV export: no file handed to the downloads capability (${JSON.stringify(saved)})`);
          else notes.push(`CSV export: ${csv.filename} (${csv.size} chars)`);
        } else failures.push('CSV export: no Export CSV button with the downloads capability available');
        checked++;
      }
      if (w.requests.length) failures.push(`${vp.name}: unexpected network requests: ${[...new Set(w.requests)].join(', ')}`);
      await ctx.close();
    }

    // ---- Gate flow as a guard, then persistence across reloads.
    {
      const ctx = await browser.newContext({ viewport: { width: 820, height: 1180 } });
      const page = await ctx.newPage();
      const w = watch(page, BASE);
      await boot(page, BASE);
      await signIn(page, 'Security Guard');
      await go(page, '/gate');
      await page.getByRole('link', { name: /Scan Visitor QR/ }).click();
      await page.getByRole('button', { name: /Visitor pass —/ }).first().click();
      await page.getByText('Verified', { exact: true }).first().waitFor({ timeout: 10_000 });
      await page.screenshot({ path: path.join(OUT, 'gate_verified.png') });
      await page.getByRole('button', { name: /Record Entry/ }).click();
      await page.getByText('Recorded at (server time)').waitFor({ timeout: 10_000 });
      await page.screenshot({ path: path.join(OUT, 'gate_recorded.png') });
      const ref = (await page.locator('text=/EV-\\d{4}-\\d{7}/').first().textContent())?.match(/EV-\d{4}-\d{7}/)?.[0];
      if (!ref) failures.push('gate: no event reference shown after recording');
      await page.waitForTimeout(800);
      await page.reload();
      await page.locator('h1').first().waitFor({ timeout: 60_000 });
      const signedIn = !(await page.getByRole('button', { name: /System Administrator/ }).first().isVisible().catch(() => false));
      if (!signedIn) failures.push('reload: session was not kept');
      await go(page, '/gate/recent');
      if (ref && !(await page.getByText(ref).first().isVisible().catch(() => false))) failures.push(`reload: recorded event ${ref} not visible after reload`);
      const presence = await apiGet(page, `/events?q=${ref}`).catch(() => null);
      if (ref && !(presence?.items ?? []).some((e) => e.reference === ref)) failures.push(`reload: event ${ref} missing from the register after reload`);
      if (w.errors.length) failures.push(`gate: ${w.errors.join(' | ')}`);
      if (w.requests.length) failures.push(`gate: unexpected network requests: ${[...new Set(w.requests)].join(', ')}`);
      checked += 3;
      await ctx.close();
    }
  } finally {
    await browser.close();
    servers.forEach((s) => s.kill());
  }

  console.log(notes.map((n) => `  · ${n}`).join('\n'));
  console.log(`\nBrowser edition smoke: ${checked} checks; screenshots in ${OUT}`);
  if (failures.length) {
    console.error(`\n${failures.length} problem(s):\n - ${failures.join('\n - ')}`);
    process.exit(1);
  }
  console.log('All checks passed.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
