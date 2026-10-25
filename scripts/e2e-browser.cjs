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
 *  - confirms a change survives an immediate reload and that only one tab at a time stays active,
 *  - checks that the page made no network requests other than loading itself.
 * Before any of that it checks the file's build stamp: it fails when the file was not built from
 * the current HEAD, or when bundled sources changed after it was built (SG_E2E_ALLOW_STALE=1
 * reports this as a warning instead).
 * Screenshots are written to ./screenshots/browser (git-ignored).
 */
const { execFileSync, spawn } = require('node:child_process');
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

const FILE = 'dist/browser/securegate.html';
/** Files that end up in the bundle; a change to any of them after the build makes the file stale. */
const BUNDLE_INPUTS = /^(browser\/(?!test\/)|client\/|server\/src\/|shared\/|vite\.browser\.config\.ts$|scripts\/build-browser\.mjs$|package(-lock)?\.json$)/;

/** The stamp scripts/build-browser.mjs writes into the file, and why it does not match this checkout. */
function checkBuildStamp() {
  const m = /<!-- sg-build commit=(\S+) dirty=(yes|no) built=(\S+) -->/.exec(fs.readFileSync(FILE, 'utf8'));
  if (!m) return { stamp: null, problems: [`${FILE} carries no build stamp; rebuild with npm run build:browser`] };
  const stamp = { commit: m[1], dirty: m[2] === 'yes', builtAt: m[3] };
  const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  let head;
  try {
    head = git('rev-parse', 'HEAD');
  } catch {
    return { stamp, problems: [], note: 'not a git checkout: build stamp not compared' };
  }
  const problems = [];
  if (stamp.commit === 'unknown' || !head.startsWith(stamp.commit)) problems.push(`built from commit ${stamp.commit}, but HEAD is ${head.slice(0, 7)}`);
  const builtAt = Date.parse(stamp.builtAt);
  const newer = git('status', '--porcelain', '--untracked-files=all')
    .split('\n')
    .filter(Boolean)
    .map((line) => line.slice(3).replace(/^.* -> /, '').replace(/^"|"$/g, ''))
    .filter((file) => BUNDLE_INPUTS.test(file))
    .filter((file) => {
      try {
        return fs.statSync(file).mtimeMs > builtAt;
      } catch {
        return true; // deleted since: cannot tell when
      }
    });
  if (newer.length) problems.push(`sources changed after the build: ${newer.slice(0, 6).join(', ')}${newer.length > 6 ? `, and ${newer.length - 6} more` : ''}`);
  return { stamp, problems };
}

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
  const host = await page.evaluate(() => ({
    engine: window.__SG_BROWSER__?.engine,
    storage: window.__SG_BROWSER__?.storage,
    build: window.__SG_BROWSER__?.build,
    lang: document.documentElement.lang,
  }));
  return { ms: Date.now() - t0, ...host };
}

/** Wait until a tab has started, or shows that another tab took over. */
async function settled(page) {
  await page.waitForFunction(() => !!window.__SG_BROWSER__ || !!document.querySelector('[role=alertdialog]'), null, { timeout: 90_000 });
  return page.evaluate(() => ({ superseded: !!document.querySelector('[role=alertdialog]'), notice: document.querySelector('[role=alertdialog] p')?.textContent ?? '' }));
}

const apiCall = (page, method, p, body) =>
  page.evaluate(
    ({ method, p, body }) =>
      fetch(`/api${p}`, { method, headers: { 'content-type': 'application/json', 'x-sg-request': '1' }, body: body === undefined ? undefined : JSON.stringify(body) }).then(async (r) => ({
        status: r.status,
        body: await r.json().catch(() => null),
      })),
    { method, p, body },
  );
const graceMinutes = async (page) => (await apiCall(page, 'GET', '/admin/settings')).body?.find?.((x) => x.key === 'visit.passGraceMinutes')?.value;

/** The client's Tailwind styles are present and applied (an unstyled bundle still renders, so check computed styles). */
async function assertStyled(page, where, failures) {
  const styled = await page.evaluate(() => {
    const flex = [...document.querySelectorAll('.flex')];
    const body = getComputedStyle(document.body);
    return { flex: flex.length, applied: flex.filter((e) => getComputedStyle(e).display === 'flex').length, font: body.fontFamily, bg: body.backgroundColor };
  });
  if (!styled.flex || styled.applied !== styled.flex) failures.push(`${where}: styles not applied (${styled.applied}/${styled.flex} .flex elements use display:flex)`);
  if (!/Inter/.test(styled.font)) failures.push(`${where}: app font not applied (${styled.font})`);
  if (/rgba\(0, 0, 0, 0\)|rgb\(255, 255, 255\)/.test(styled.bg)) failures.push(`${where}: canvas background not applied (${styled.bg})`);
}

async function signIn(page, roleName) {
  const button = page.getByRole('button', { name: new RegExp(roleName) }).first();
  await button.click();
  // Signed in once the sign-in page has gone and the app's main content shows (an h1 already
  // visible on the sign-in page would otherwise satisfy the wait before the click took effect).
  await button.waitFor({ state: 'detached', timeout: 20_000 });
  await page.locator('main').first().waitFor({ timeout: 20_000 });
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
  if (!fs.existsSync(FILE)) {
    console.error('Build first: npm run build:browser');
    process.exit(2);
  }
  fs.mkdirSync(OUT, { recursive: true });
  const failures = [];
  const notes = [];
  let checked = 0;
  const build = checkBuildStamp();
  if (build.note) notes.push(build.note);
  if (build.stamp) notes.push(`build stamp: commit ${build.stamp.commit}${build.stamp.dirty ? ' (uncommitted changes)' : ''}, built ${build.stamp.builtAt}`);
  if (build.problems.length) {
    const text = `${FILE} is stale: ${build.problems.join('; ')}. Rebuild with npm run build:browser.`;
    console.error(`\n*** ${text} ***\n`);
    if (process.env.SG_E2E_ALLOW_STALE === '1') notes.push(`WARNING (SG_E2E_ALLOW_STALE=1): ${text}`);
    else failures.push(text);
  }
  checked++;
  const servers = [await serve(PORT, 'none'), await serve(STRICT_PORT, 'strict')];
  const BASE = `http://127.0.0.1:${PORT}`;
  const STRICT = `http://127.0.0.1:${STRICT_PORT}`;
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
      if (b.lang !== 'en') failures.push(`document language is "${b.lang}", expected "en"`);
      if (build.stamp && JSON.stringify(b.build) !== JSON.stringify(build.stamp)) failures.push(`runtime build stamp ${JSON.stringify(b.build)} differs from the file's ${JSON.stringify(build.stamp)}`);
      await signIn(page, 'Security Guard');
      await assertStyled(page, 'strict CSP', failures);
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
      await page.waitForTimeout(400);
      await assertStyled(page, `${vp.name} sign-in`, failures);
      await page.screenshot({ path: path.join(OUT, `${vp.name}_login.png`) });
      await signIn(page, 'System Administrator');
      await assertStyled(page, `${vp.name} signed in`, failures);

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
      // The browser edition says "device time": its clock is this device's.
      await page.getByText(/^Recorded at \((server|device) time\)$/).waitFor({ timeout: 10_000 });
      await page.screenshot({ path: path.join(OUT, 'gate_recorded.png') });
      const ref = (await page.locator('text=/EV-\\d{4}-\\d{7}/').first().textContent())?.match(/EV-\d{4}-\d{7}/)?.[0];
      if (!ref) failures.push('gate: no event reference shown after recording');
      await page.waitForTimeout(800);
      await page.reload();
      // The start-up overlay has a heading of its own: wait for the in-page server, then for the app.
      await settled(page);
      await page.locator('main').first().waitFor({ timeout: 60_000 });
      const signedIn = !(await page.getByRole('button', { name: /System Administrator/ }).first().isVisible().catch(() => false));
      if (!signedIn) failures.push('reload: session was not kept');
      await go(page, '/gate/recent');
      if (ref && !(await page.getByText(ref).first().isVisible().catch(() => false))) failures.push(`reload: recorded event ${ref} not visible after reload`);
      if (w.errors.length) failures.push(`gate: ${w.errors.join(' | ')}`);
      if (w.requests.length) failures.push(`gate: unexpected network requests: ${[...new Set(w.requests)].join(', ')}`);
      checked += 3;
      await ctx.close();
    }

    // ---- A change survives an immediate reload; one active tab at a time.
    {
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
      const a = await ctx.newPage();
      const w = watch(a, BASE);
      await boot(a, BASE);
      await apiCall(a, 'POST', '/auth/demo-login', { username: 'admin' });
      await a.waitForTimeout(500);
      // The exit flush must commit before the page goes away, well inside the 150 ms save delay.
      const put = await apiCall(a, 'PUT', '/admin/settings/visit.passGraceMinutes', { value: 47 });
      await a.reload();
      await settled(a);
      const kept = await graceMinutes(a);
      if (put.status !== 200 || kept !== 47) failures.push(`immediate reload: setting ${put.status} → ${kept} after reload (expected 47; session kept: ${kept !== undefined})`);

      // Tab B opens: A hands over (saves, stands down, refuses writes); B sees A's change.
      await apiCall(a, 'PUT', '/admin/settings/visit.passGraceMinutes', { value: 48 });
      const b = await ctx.newPage();
      await b.goto(`${BASE}/`);
      await settled(b);
      await apiCall(b, 'POST', '/auth/demo-login', { username: 'admin' });
      const aState = await settled(a);
      const handedOver = await graceMinutes(b);
      const aWrite = await apiCall(a, 'PUT', '/admin/settings/visit.passGraceMinutes', { value: 49 });
      if (!aState.superseded || aWrite.status !== 503) failures.push(`second tab: first tab ${aState.superseded ? 'stood down' : 'kept running'}, its write answered ${aWrite.status} (expected 503)`);
      if (handedOver !== 48) failures.push(`second tab: sees ${handedOver}, expected the first tab's last change (48)`);
      if (!/were saved/.test(aState.notice)) failures.push(`second tab: the first tab handed over but its notice says: ${aState.notice}`);
      await a.screenshot({ path: path.join(OUT, 'tab_superseded.png') });

      // Two tabs started at the same moment: exactly one stays active.
      const [c, d] = [await ctx.newPage(), await ctx.newPage()];
      await Promise.all([c.goto(`${BASE}/`), d.goto(`${BASE}/`)]);
      const [sc, sd] = await Promise.all([settled(c), settled(d)]);
      await c.waitForTimeout(500);
      const statuses = await Promise.all([c, d].map((p) => apiCall(p, 'GET', '/config').then((r) => r.status)));
      const activeTabs = statuses.filter((st) => st === 200).length;
      if (activeTabs !== 1) failures.push(`two tabs at once: ${activeTabs} active (config ${statuses.join('/')}, notices ${sc.superseded}/${sd.superseded})`);
      // The tab that lost the start-up race never served a request, so it had nothing to lose.
      const loser = statuses[0] === 503 ? c : d;
      const loserNotice = await loser
        .locator('[role=alertdialog] p')
        .first()
        .textContent({ timeout: 20_000 })
        .catch(() => '(no notice shown)');
      if (!/No changes had been made/.test(loserNotice)) failures.push(`two tabs at once: the tab that stood down says: ${loserNotice}`);
      if (w.errors.length) failures.push(`tabs: ${w.errors.join(' | ')}`);
      checked += 6;
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
