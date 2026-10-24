/**
 * Browser smoke test for TCP SecureGate.
 *
 *   npm run build && npm run e2e
 *
 * Starts the built server on a throw-away demo database, then with Chromium:
 *  - signs in through the demo role selector,
 *  - opens every major screen at desktop (1440), tablet (820) and mobile (390) widths,
 *    failing on page errors, console errors or horizontal overflow,
 *  - clicks through the gate flow: simulated QR scan → verify → record entry,
 *  - reloads to confirm database-backed changes persist.
 * Screenshots are written to ./screenshots (git-ignored).
 *
 * Requires Playwright with Chromium (`npm i -D playwright && npx playwright install chromium`
 * if it is not already available globally).
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  console.error('Playwright is not installed. Run: npm i -D playwright && npx playwright install chromium');
  process.exit(2);
}

const PORT = Number(process.env.E2E_PORT ?? 3911);
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = path.resolve('screenshots');
const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'tablet', width: 820, height: 1180 },
  { name: 'mobile', width: 390, height: 844 },
];
const ADMIN_PAGES = [
  '/dashboard', '/presence', '/register', '/waiting-list', '/visitors', '/visitors/new', '/approvals', '/personnel', '/personnel/new',
  '/credentials', '/contractors', '/temporary-access', '/vehicles', '/deliveries', '/alerts', '/manual-reviews', '/exceptions',
  '/handover', '/reports', '/reports/daily-movement', '/audit', '/notifications', '/account',
  '/admin/users', '/admin/roles', '/admin/locations', '/admin/settings', '/admin/system',
];

async function waitForServer() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('Server did not start');
}

async function main() {
  if (!fs.existsSync('dist/server/index.js') || !fs.existsSync('dist/client/index.html')) {
    console.error('Build first: npm run build');
    process.exit(2);
  }
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'securegate-e2e-'));
  fs.mkdirSync(OUT, { recursive: true });
  const server = spawn(process.execPath, ['dist/server/index.js'], {
    env: { ...process.env, APP_MODE: 'demo', DATA_DIR: dataDir, PORT: String(PORT), HOST: '127.0.0.1', DEMO_PERSONNEL_COUNT: '600' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));
  const failures = [];
  let checked = 0;
  const browser = await chromium.launch();
  try {
    await waitForServer();

    for (const vp of VIEWPORTS) {
      const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
      const page = await ctx.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
      page.on('console', (m) => m.type() === 'error' && !/status of 40[134]/.test(m.text()) && errors.push(`console: ${m.text()}`));

      // Sign in through the demo role selector (real UI).
      await page.goto(`${BASE}/login`);
      await page.getByRole('button', { name: /System Administrator/ }).first().click();
      await page.waitForURL(/\/dashboard/, { timeout: 15000 });

      for (const route of ADMIN_PAGES) {
        errors.length = 0;
        await page.goto(`${BASE}${route}`);
        await page.waitForLoadState('networkidle').catch(() => undefined);
        await page.waitForTimeout(400);
        const h1 = await page.locator('h1').first().isVisible().catch(() => false);
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        if (!h1) failures.push(`${vp.name} ${route}: no page heading`);
        if (overflow > 1) failures.push(`${vp.name} ${route}: horizontal overflow ${overflow}px`);
        if (errors.length) failures.push(`${vp.name} ${route}: ${errors.join(' | ')}`);
        await page.screenshot({ path: path.join(OUT, `${vp.name}${route.replace(/\//g, '_')}.png`) });
        checked++;
      }
      await ctx.close();
    }

    // Gate flow as a guard on a tablet-sized screen.
    const ctx = await browser.newContext({ viewport: { width: 820, height: 1180 } });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.request.post(`${BASE}/api/auth/demo-login`, { data: { username: 'alpha.guard' }, headers: { 'X-SG-Request': '1' } });
    await page.goto(`${BASE}/gate`);
    await page.getByRole('link', { name: /Scan Visitor QR/ }).click();
    await page.getByRole('button', { name: /Visitor pass —/ }).first().click();
    await page.getByText('Verified', { exact: true }).first().waitFor({ timeout: 10000 });
    await page.screenshot({ path: path.join(OUT, 'gate_verified.png') });
    await page.getByRole('button', { name: /Record Entry/ }).click();
    await page.getByText('Recorded at (server time)').waitFor({ timeout: 10000 });
    await page.screenshot({ path: path.join(OUT, 'gate_recorded.png') });
    const ref = (await page.locator('text=/EV-\\d{4}-\\d{7}/').first().textContent())?.match(/EV-\d{4}-\d{7}/)?.[0];
    if (!ref) failures.push('gate: no event reference shown after recording');
    // Persistence across reload.
    await page.goto(`${BASE}/gate/recent`);
    await page.reload();
    await page.waitForLoadState('networkidle').catch(() => undefined);
    if (ref && !(await page.getByText(ref).first().isVisible().catch(() => false))) failures.push(`gate: recorded event ${ref} not visible after reload`);
    if (errors.length) failures.push(`gate: ${errors.join(' | ')}`);
    checked += 3;
    await ctx.close();
  } finally {
    await browser.close();
    server.kill();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }

  console.log(`\nE2E smoke: ${checked} checks across ${VIEWPORTS.length} viewports; screenshots in ${OUT}`);
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
