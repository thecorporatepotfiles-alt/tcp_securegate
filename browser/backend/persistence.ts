/**
 * Per-browser persistence for the browser edition: the serialized SQLite
 * database and the demo token secret are kept in IndexedDB on this device
 * only. Storage can be unavailable (private windows, blocked site data,
 * previews), so every operation degrades to "not persisted" instead of failing,
 * and every request has a time limit so start-up never waits on a stuck store.
 */

const DB_NAME = 'tcp-securegate-browser-edition';
const STORE = 'state';
const KEY = 'snapshot';

/** Generous: a slow device may need a while to read or write a 5-6 MB snapshot. */
const READ_TIMEOUT_MS = 10_000;
const WRITE_TIMEOUT_MS = 15_000;
const CLEAR_TIMEOUT_MS = 5_000;

export interface Snapshot {
  format: 1;
  savedAt: string;
  /** When the synthetic dataset in this snapshot was generated. */
  createdAt: string;
  tokenSecret: string;
  bytes: Uint8Array;
}

export interface SnapshotStore {
  /** The saved snapshot, or null when none is saved. Rejects when one is saved but cannot be used. */
  load(): Promise<Snapshot | null>;
  save(snapshot: Snapshot): Promise<void>;
  clear(): Promise<void>;
}

/** IndexedDB did not answer in time; the operation may still be pending in the browser. */
export class StorageTimeoutError extends Error {
  override name = 'StorageTimeoutError';
}

function withTimeout<T>(work: Promise<T>, ms: number, what: string, onTimeout?: () => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      try {
        onTimeout?.();
      } catch {
        /* the transaction may already be finished */
      }
      reject(new StorageTimeoutError(`Saved demo data on this device did not respond (${what}).`));
    }, ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

function promisify<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
  });
}

/**
 * Commit now instead of when the page next returns to its event loop: a save
 * started from `pagehide` must not be discarded with the unloading document.
 */
function commit(tx: IDBTransaction): void {
  try {
    tx.commit?.();
  } catch {
    /* already committing */
  }
}

function isSnapshot(v: unknown): v is Snapshot {
  const s = v as Snapshot | null;
  return !!s && s.format === 1 && typeof s.tokenSecret === 'string' && s.bytes instanceof Uint8Array && s.bytes.length > 0;
}

/** Open the store, or resolve null when IndexedDB cannot be used here. */
export async function openSnapshotStore(timeoutMs = 4000): Promise<SnapshotStore | null> {
  let idb: IDBFactory | undefined;
  try {
    idb = globalThis.indexedDB;
  } catch {
    return null;
  }
  if (!idb) return null;
  const open = new Promise<IDBDatabase>((resolve, reject) => {
    const req = idb!.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'));
    req.onblocked = () => reject(new Error('IndexedDB open blocked'));
  });
  let db: IDBDatabase;
  try {
    db = await withTimeout(open, timeoutMs, 'open');
  } catch {
    // Close a connection that opens after the time limit so it cannot block a later delete.
    void open.then((late) => late.close(), () => {});
    return null;
  }
  // Another tab erasing the saved data ("Erase saved demo data and retry") must not wait for this one.
  db.onversionchange = () => db.close();
  return {
    async load() {
      const tx = db.transaction(STORE, 'readonly');
      const value = await withTimeout(promisify(tx.objectStore(STORE).get(KEY)), READ_TIMEOUT_MS, 'read', () => tx.abort());
      if (value === undefined) return null;
      if (!isSnapshot(value)) throw new Error('Saved demo data is not in a recognised format.');
      return value;
    },
    async save(snapshot) {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(snapshot, KEY);
      commit(tx);
      await withTimeout(done(tx), WRITE_TIMEOUT_MS, 'write', () => tx.abort());
    },
    async clear() {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(KEY);
      commit(tx);
      await withTimeout(done(tx), CLEAR_TIMEOUT_MS, 'erase', () => tx.abort());
    },
  };
}
