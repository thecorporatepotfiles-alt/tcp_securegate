/**
 * Starts the TCP SecureGate server inside the page: the same server modules
 * that run under Node (routes, services, demo seed, scheduler) on an
 * in-memory SQLite database, reached through an intercepted fetch.
 */
import Database, { setSqlJs } from '../shims/better-sqlite3.js';
import { dispatch } from '../shims/express.js';
import type { AppConfig } from '../../server/src/config.js';
import { openDatabase, type DB } from '../../server/src/db/connection.js';
import { migrate } from '../../server/src/db/migrate.js';
import { createApp } from '../../server/src/app.js';
import { startScheduler } from '../../server/src/services/scheduler.js';
import { ensureBaseline, seedDemo } from '../../server/src/seed/demo.js';
import { randomToken } from '../../server/src/lib/crypto.js';
import { loadSqlEngine, type Engine } from './engine.js';
import { openSnapshotStore, type Snapshot } from './persistence.js';
import { CookieJar, installFetchInterceptor, type Dispatch, type ServerResponse } from './transport.js';
import { createTabCoordinator } from './tabs.js';

export interface BrowserHost {
  engine: Engine;
  storage: 'indexeddb' | 'memory';
  /** When the synthetic dataset now in use was generated. */
  dataCreatedAt: string;
  /** Set when saved data could not be restored and a fresh dataset was generated instead. */
  restoreNotice: string | null;
  /** Erase this browser's saved data; the next page load generates a fresh dataset. */
  resetLocalData(): Promise<void>;
}

declare global {
  interface Window {
    __SG_BROWSER__?: BrowserHost;
  }
}

export type BootStep = 'engine' | 'restore' | 'seed' | 'start';

export interface BootOptions {
  onStep?: (step: BootStep) => void;
  /** Another tab took over: this tab has saved its data and stopped. */
  onSuperseded?: () => void;
}

const SUPERSEDED: ServerResponse = {
  status: 503,
  headers: { 'content-type': 'application/json; charset=utf-8' },
  body: JSON.stringify({ error: { code: 'TAB_SUPERSEDED', message: 'SecureGate is open in another tab. Reload this tab to continue here.' } }),
};

const DEMO_PERSONNEL = 1200;
/** Changes made by user actions are saved almost immediately; incidental writes (session activity, scheduled checks) are batched. */
const SAVE_AFTER_ACTION_MS = 150;
const SAVE_DEBOUNCE_MS = 2500;
const SAVE_MAX_WAIT_MS = 15_000;

function browserConfig(tokenSecret: string): AppConfig {
  return {
    mode: 'demo',
    port: 0,
    host: 'browser',
    databaseFile: ':memory:',
    dataDir: '',
    tokenSecret,
    timezone: 'Asia/Kolkata',
    sessionIdleMinutes: 60,
    sessionAbsoluteHours: 12,
    secureCookies: false,
    trustProxy: false,
    autoSeed: true,
    demoPersonnelCount: DEMO_PERSONNEL,
    schedulerIntervalSeconds: 60,
    serveClient: false,
    clientDir: '',
  };
}

/** Yield to the browser so progress updates paint before long synchronous work. */
const paint = () => new Promise<void>((r) => setTimeout(r, 30));

function restore(snapshot: Snapshot): DB | null {
  let db: DB | null = null;
  try {
    db = new Database(snapshot.bytes) as unknown as DB;
    db.pragma('foreign_keys = ON');
    migrate(db);
    ensureBaseline(db);
    return db;
  } catch {
    try {
      db?.close();
    } catch {
      /* ignore */
    }
    return null;
  }
}

let resolveDispatch!: (d: Dispatch) => void;
let rejectDispatch!: (err: unknown) => void;
const dispatchReady = new Promise<Dispatch>((resolve, reject) => {
  resolveDispatch = resolve;
  rejectDispatch = reject;
});
// Requests that arrive after a failed start-up must not stay pending forever.
dispatchReady.catch(() => {});

const jar = new CookieJar();
let afterRequest: (method: string) => void = () => {};

/**
 * Route `/api` fetches to the in-page server. Called before the client
 * module is evaluated: the bundle evaluates every module up front, so the
 * client may issue requests while the server is still starting.
 */
export function interceptApiRequests(): void {
  installFetchInterceptor(dispatchReady, jar, (method) => afterRequest(method));
}

export async function bootBrowserBackend(options: BootOptions = {}): Promise<BrowserHost> {
  try {
    return await boot(options);
  } catch (err) {
    rejectDispatch(err);
    throw err;
  }
}

async function boot({ onStep = () => {}, onSuperseded = () => {} }: BootOptions): Promise<BrowserHost> {
  onStep('engine');
  await paint();
  const tabs = createTabCoordinator();
  const [{ SQL, engine }, store] = await Promise.all([loadSqlEngine(), openSnapshotStore()]);
  setSqlJs(SQL);

  onStep('restore');
  await paint();
  // Let a tab that is already running save its latest changes before reading them.
  if (store) await tabs.takeOver();
  let snapshot: Snapshot | null = null;
  let restoreNotice: string | null = null;
  try {
    snapshot = (await store?.load()) ?? null;
  } catch {
    restoreNotice = 'Saved demo data could not be read, so a fresh synthetic dataset was generated.';
  }

  let db = snapshot ? restore(snapshot) : null;
  if (snapshot && !db) restoreNotice = 'Saved demo data could not be opened, so a fresh synthetic dataset was generated.';
  const tokenSecret = db && snapshot ? snapshot.tokenSecret : randomToken(48);
  let createdAt = db && snapshot ? snapshot.createdAt : new Date().toISOString();
  const config = browserConfig(tokenSecret);

  if (!db) {
    onStep('seed');
    await paint();
    db = openDatabase(':memory:');
    migrate(db);
    ensureBaseline(db);
    seedDemo(db, config);
    createdAt = new Date().toISOString();
  }
  const liveDb = db;

  onStep('start');
  await paint();
  const app = createApp({ db: liveDb, config });
  const stopScheduler = startScheduler(liveDb, config);

  // ---- Persistence: save after changes, debounced; flush when the page is hidden.
  let savedChanges = -1;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let dueAt = 0;
  let firstDirtyAt = 0;
  let saving: Promise<void> | null = null;
  let stopped = false;

  const totalChanges = () => (liveDb.prepare('SELECT total_changes() AS n').get() as { n: number }).n;

  async function saveNow(): Promise<void> {
    if (!store || stopped) return;
    if (timer) clearTimeout(timer);
    timer = null;
    firstDirtyAt = 0;
    if (liveDb.inTransaction) {
      schedule();
      return;
    }
    if (saving) await saving;
    saving = (async () => {
      try {
        const bytes = (liveDb as unknown as { serialize(): Uint8Array }).serialize();
        // serialize() reopens the connection, which restarts SQLite's change counter.
        savedChanges = totalChanges();
        await store.save({ format: 1, savedAt: new Date().toISOString(), createdAt, tokenSecret, bytes });
      } catch {
        /* storage full or unavailable: keep running in memory */
      } finally {
        saving = null;
      }
    })();
    await saving;
  }

  function schedule(urgent = false): void {
    if (!store || stopped) return;
    if (totalChanges() === savedChanges) return;
    const now = Date.now();
    if (!firstDirtyAt) firstDirtyAt = now;
    const debounce = urgent ? SAVE_AFTER_ACTION_MS : SAVE_DEBOUNCE_MS;
    const due = Math.min(now + debounce, firstDirtyAt + SAVE_MAX_WAIT_MS);
    // A pending save may be brought forward, never pushed back: background
    // polling must not delay saving a change the user just made.
    if (timer && dueAt <= due) return;
    if (timer) clearTimeout(timer);
    dueAt = due;
    timer = setTimeout(() => void saveNow(), Math.max(0, due - now));
  }

  afterRequest = (method) => schedule(method !== 'GET' && method !== 'HEAD');
  // The scheduler also writes (expiries, overdue alerts); pick those changes up periodically.
  const sweep = setInterval(() => schedule(), config.schedulerIntervalSeconds * 1000);
  const flush = () => {
    if (document.visibilityState === 'hidden') void saveNow();
  };
  document.addEventListener('visibilitychange', flush);
  window.addEventListener('pagehide', () => void saveNow());

  // A fresh dataset is saved right away so a reload does not regenerate it.
  if (store && !snapshot) await saveNow();
  else savedChanges = totalChanges();

  let superseded = false;
  if (store) {
    tabs.onTakeover(async () => {
      await saveNow();
      superseded = true;
      stopped = true;
      if (timer) clearTimeout(timer);
      clearInterval(sweep);
      stopScheduler();
      onSuperseded();
    });
  }

  const host: BrowserHost = {
    engine,
    storage: store ? 'indexeddb' : 'memory',
    dataCreatedAt: createdAt,
    restoreNotice,
    async resetLocalData() {
      stopped = true;
      if (timer) clearTimeout(timer);
      clearInterval(sweep);
      stopScheduler();
      document.removeEventListener('visibilitychange', flush);
      jar.clear();
      if (saving) await saving.catch(() => {});
      await store?.clear();
    },
  };
  window.__SG_BROWSER__ = host;
  resolveDispatch((req) => (superseded ? Promise.resolve(SUPERSEDED) : dispatch(app, req)));
  return host;
}
