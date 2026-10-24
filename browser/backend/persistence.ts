/**
 * Per-browser persistence for the browser edition: the serialized SQLite
 * database and the demo token secret are kept in IndexedDB on this device
 * only. Storage can be unavailable (private windows, blocked site data,
 * previews), so every operation degrades to "not persisted" instead of failing.
 */

const DB_NAME = 'tcp-securegate-browser-edition';
const STORE = 'state';
const KEY = 'snapshot';

export interface Snapshot {
  format: 1;
  savedAt: string;
  /** When the synthetic dataset in this snapshot was generated. */
  createdAt: string;
  tokenSecret: string;
  bytes: Uint8Array;
}

export interface SnapshotStore {
  load(): Promise<Snapshot | null>;
  save(snapshot: Snapshot): Promise<void>;
  clear(): Promise<void>;
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
  const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error('IndexedDB open timed out')), timeoutMs));
  let db: IDBDatabase;
  try {
    db = await Promise.race([open, timeout]);
  } catch {
    return null;
  }
  return {
    async load() {
      const tx = db.transaction(STORE, 'readonly');
      const value = await promisify(tx.objectStore(STORE).get(KEY));
      return isSnapshot(value) ? value : null;
    },
    async save(snapshot) {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(snapshot, KEY);
      await done(tx);
    },
    async clear() {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(KEY);
      await done(tx);
    },
  };
}
