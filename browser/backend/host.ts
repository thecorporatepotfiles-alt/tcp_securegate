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
import { openSnapshotStore, StorageTimeoutError, type Snapshot } from './persistence.js';
import { CookieJar, installFetchInterceptor, type Dispatch, type ServerResponse } from './transport.js';
import { createTabCoordinator } from './tabs.js';

/** Which build of the page is running; set at build time by scripts/build-browser.mjs. */
export interface BuildStamp {
  /** Short git commit the page was built from ('unknown' when built outside a git checkout). */
  commit: string;
  /** The working tree had uncommitted changes when the page was built. */
  dirty: boolean;
  /** When the page was built (ISO time). */
  builtAt: string;
}

export interface BrowserHost {
  engine: Engine;
  /** Live: 'memory' when this device's storage cannot be used or saving to it fails. */
  readonly storage: 'indexeddb' | 'memory';
  /** Why the latest save failed, or null while saves succeed. */
  readonly saveError: string | null;
  /** When the synthetic dataset now in use was generated. */
  dataCreatedAt: string;
  /** Set when saved data could not be restored and a fresh dataset was generated instead. */
  restoreNotice: string | null;
  readonly build: Readonly<BuildStamp>;
  /** Erase this browser's saved data; the next page load generates a fresh dataset. */
  resetLocalData(): Promise<void>;
}

declare global {
  interface Window {
    __SG_BROWSER__?: BrowserHost;
  }
}

/** Fired on window whenever `storage` or `saveError` changes (see client/src/lib/edition.ts). */
export const STORAGE_EVENT = 'sg:storage';

export const BUILD: Readonly<BuildStamp> = Object.freeze({ ...__SG_BUILD__ });

export type BootStep = 'engine' | 'restore' | 'seed' | 'start';

export interface SupersededInfo {
  /** This tab served a request that may have changed the data (sign-in included). */
  changedHere: boolean;
  /** Changes made in this tab may not have been saved before the other tab took over. */
  unsavedChanges: boolean;
}

export interface BootOptions {
  onStep?: (step: BootStep) => void;
  /** Another tab took over: this tab has stopped saving and serving requests. */
  onSuperseded?: (info: SupersededInfo) => void;
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

/** A short, data-free reason for a failed save (shown to the viewer). */
function saveFailure(err: unknown): string {
  const name = (err as { name?: string } | null)?.name;
  if (name === 'QuotaExceededError') return 'This device has no storage space left for the demo data.';
  if (err instanceof StorageTimeoutError) return 'Saving on this device did not finish in time.';
  return 'This browser did not allow the demo data to be saved.';
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
  const [{ SQL, engine }, opened] = await Promise.all([loadSqlEngine(), openSnapshotStore()]);
  let store = opened;
  setSqlJs(SQL);

  onStep('restore');
  await paint();

  // ---- Persistence: save after changes, debounced; flush when the page is hidden or unloaded.
  // These exist before the data does, because another tab may take over while this one starts.
  let liveDb: DB | null = null;
  let tokenSecret = '';
  let createdAt = new Date().toISOString();
  let savedChanges = -1;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let dueAt = 0;
  let firstDirtyAt = 0;
  let saving: Promise<void> | null = null;
  /** No more saves: another tab took over, or the saved data is being erased. */
  let stopped = false;
  /** Another tab took over: requests are refused. */
  let superseded = false;
  /** Another tab took the lock without this tab handing over first. */
  let lockLost = false;
  let saveError: string | null = null;
  let stopBackground: () => void = () => {};
  /**
   * Requests that may change data, counted once answered, and how many of them the latest
   * finished save includes. The seeded or restored data a tab starts from is not a change made
   * here: a tab that loses the start-up race before serving anything has nothing to lose.
   */
  let actions = 0;
  let savedActions = 0;

  const storageState = (): BrowserHost['storage'] => (store && !saveError ? 'indexeddb' : 'memory');
  let announced = `${storageState()}|${saveError}`;
  /** Tell the client when `storage` or `saveError` changed. */
  function announceStorage(): void {
    const now = `${storageState()}|${saveError}`;
    if (now === announced) return;
    announced = now;
    window.dispatchEvent(new Event(STORAGE_EVENT));
  }

  const totalChanges = () => (liveDb ? (liveDb.prepare('SELECT total_changes() AS n').get() as { n: number }).n : 0);
  /** Changes not yet handed to storage. */
  const dirty = () => !!liveDb && totalChanges() !== savedChanges;

  function takeSnapshot(db: DB): Snapshot {
    const bytes = (db as unknown as { serialize(): Uint8Array }).serialize();
    // serialize() reopens the connection, which restarts SQLite's change counter.
    savedChanges = totalChanges();
    return { format: 1, savedAt: new Date().toISOString(), createdAt, tokenSecret, bytes };
  }

  async function saveNow(): Promise<void> {
    if (timer) clearTimeout(timer);
    timer = null;
    firstDirtyAt = 0;
    while (saving) await saving;
    // Nothing changed since the last save: never rewrite (an idle tab must not overwrite anything).
    if (!store || stopped || !dirty()) return;
    const run = (async () => {
      try {
        // Another tab may have taken over a moment ago, before this tab has been told.
        if (!(await tabs.isActive())) {
          lockLost = true;
          void standDown(false);
          return;
        }
        const db = liveDb;
        if (!store || stopped || !db || !dirty()) return;
        if (db.inTransaction) {
          schedule(true);
          return;
        }
        const snapshot = takeSnapshot(db);
        const included = actions;
        try {
          await store.save(snapshot);
          savedActions = Math.max(savedActions, included);
          saveError = null;
        } catch (err) {
          savedChanges = -1; // still unsaved: the next save retries
          if (!saveError) console.warn('[securegate] saving demo data on this device failed:', (err as { name?: string } | null)?.name ?? 'Error');
          saveError = saveFailure(err);
        }
        announceStorage();
      } catch {
        /* serialize failed: keep running in memory and retry on the next change */
      }
    })();
    const tracked: Promise<void> = run.finally(() => {
      if (saving === tracked) saving = null;
    });
    saving = tracked;
    await tracked;
  }

  function schedule(urgent = false): void {
    if (!store || stopped || !dirty()) return;
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

  /**
   * Last chance before the page goes away. Write now and never wait for an
   * in-flight save: callbacks no longer run once the page is unloading, and
   * IndexedDB applies writes to one store in order, so this copy lands last.
   */
  function flushOnExit(): void {
    const db = liveDb;
    if (!store || stopped || !db || db.inTransaction || !dirty()) return;
    if (timer) clearTimeout(timer);
    timer = null;
    firstDirtyAt = 0;
    try {
      void store.save(takeSnapshot(db)).catch(() => {});
    } catch {
      /* nothing more can be done while unloading */
    }
  }

  const onHidden = () => {
    if (document.visibilityState === 'hidden') void saveNow();
  };

  /** Stop saving and serving requests. `handover`: the other tab asked, so save first; otherwise it may already have read the data. */
  let standing: Promise<void> | null = null;
  function standDown(handover: boolean): Promise<void> {
    superseded = true; // refuse new requests at once, so nothing changes after the final save
    if (!handover) stopped = true;
    return (standing ??= (async () => {
      if (handover) await saveNow();
      stopped = true;
      if (timer) clearTimeout(timer);
      stopBackground();
      document.removeEventListener('visibilitychange', onHidden);
      window.removeEventListener('pagehide', flushOnExit);
      // A save still in flight when the lock was taken may land after the other tab read the data.
      const atRisk = dirty() || (lockLost && saving !== null);
      onSuperseded({ changedHere: actions > 0, unsavedChanges: actions > savedActions && atRisk });
    })());
  }

  // Let a tab that is already running save its latest changes and stand down before reading them.
  if (store) {
    await tabs.takeOver();
    tabs.onTakeover(() => standDown(true));
    tabs.onLost(() => {
      lockLost = true;
      void standDown(false);
    });
  }
  let snapshot: Snapshot | null = null;
  let restoreNotice: string | null = null;
  if (store) {
    try {
      snapshot = await store.load();
    } catch (err) {
      if (err instanceof StorageTimeoutError) {
        // The store is stuck or very slow: run in memory rather than overwrite what it may still hold.
        store = null;
        restoreNotice = 'Saved demo data on this device did not respond, so this tab uses a fresh synthetic dataset that is not saved.';
      } else {
        restoreNotice = 'Saved demo data could not be read, so a fresh synthetic dataset was generated.';
      }
    }
  }

  let db = snapshot ? restore(snapshot) : null;
  if (snapshot && !db) restoreNotice = 'Saved demo data could not be opened, so a fresh synthetic dataset was generated.';
  const restored = !!(snapshot && db);
  tokenSecret = restored ? snapshot!.tokenSecret : randomToken(48);
  const config = browserConfig(tokenSecret);

  if (!db) {
    onStep('seed');
    await paint();
    db = openDatabase(':memory:');
    migrate(db);
    ensureBaseline(db);
    seedDemo(db, config);
  }
  createdAt = restored ? snapshot!.createdAt : new Date().toISOString();
  liveDb = db;
  // Restored data is already saved: only later changes make this tab dirty.
  if (restored) savedChanges = totalChanges();

  onStep('start');
  await paint();
  const app = createApp({ db, config });

  if (!superseded) {
    const stopScheduler = startScheduler(db, config);
    // The scheduler also writes (expiries, overdue alerts); pick those changes up periodically.
    const sweep = setInterval(() => schedule(), config.schedulerIntervalSeconds * 1000);
    stopBackground = () => {
      clearInterval(sweep);
      stopScheduler();
      stopBackground = () => {};
    };
    afterRequest = (method) => schedule(method !== 'GET' && method !== 'HEAD');
    document.addEventListener('visibilitychange', onHidden);
    window.addEventListener('pagehide', flushOnExit);
  }

  // A dataset that did not come from the saved snapshot is saved right away, so a reload does not
  // regenerate it. Start-up does not wait for it: a failure is announced through `storage`.
  if (store && !restored) void saveNow();
  announceStorage();

  const host: BrowserHost = {
    engine,
    get storage() {
      return storageState();
    },
    get saveError() {
      return saveError;
    },
    dataCreatedAt: createdAt,
    restoreNotice,
    get build() {
      return BUILD;
    },
    async resetLocalData() {
      stopped = true;
      if (timer) clearTimeout(timer);
      stopBackground();
      document.removeEventListener('visibilitychange', onHidden);
      window.removeEventListener('pagehide', flushOnExit);
      jar.clear();
      // No need to wait for a save in flight: it either sees `stopped` before writing, or its write
      // transaction already exists, and IndexedDB runs this erase after it. A stuck save then makes
      // the erase time out (5 s) instead of adding its own 15 s limit first.
      await store?.clear();
    },
  };
  window.__SG_BROWSER__ = host;
  resolveDispatch(async (req) => {
    if (superseded) return SUPERSEDED;
    try {
      return await dispatch(app, req);
    } finally {
      // Counted once answered, so a save that includes this count includes the request's changes.
      if (req.method !== 'GET' && req.method !== 'HEAD') actions += 1;
    }
  });
  return host;
}
