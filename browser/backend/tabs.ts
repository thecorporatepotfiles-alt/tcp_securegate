/**
 * One active tab per browser. Each tab runs its own in-memory database and
 * saves whole snapshots, so two active tabs would silently overwrite each
 * other's changes.
 *
 * - Handshake: a starting tab asks the active tab (over BroadcastChannel) to
 *   save and stand down before it reads the saved data.
 * - Lock: the active tab holds an exclusive Web Lock for as long as it runs,
 *   and a starting tab takes it with `steal`. A tab that could not hand over
 *   in time (still starting, frozen, busy) loses its lock and stops without
 *   saving, so two tabs never both keep saving, whatever the timing.
 *
 * Where Web Locks are unavailable only the handshake applies.
 */

const CHANNEL = 'tcp-securegate-browser-edition';
const LOCK = 'tcp-securegate-active-tab';
/** How long a starting tab waits for an answer when no tab holds the lock (tabs without locks still answer). */
const ANSWER_MS = 250;
/** Upper bound for an active tab to answer and finish its final save. */
const YIELD_MS = 5000;
/** Granting a stolen lock is immediate; this only keeps start-up going if the lock manager never answers. */
const LOCK_MS = 3000;

type Message = { type: 'takeover'; from: string } | { type: 'yielding' | 'yielded'; to: string };

export interface TabCoordinator {
  /** Ask the active tab to save and stand down, then become the active tab. */
  takeOver(): Promise<void>;
  /** This tab's stand-down when another tab asks: save and stop. The lock is released once it settles. */
  onTakeover(handler: () => Promise<void>): void;
  /** Called once if another tab took over without this tab handing over first (its lock was stolen). */
  onLost(handler: () => void): void;
  /** Whether this tab may still save: false once another tab holds the lock. */
  isActive(): Promise<boolean>;
}

function tabId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function lockManager(): LockManager | null {
  try {
    const locks = (navigator as Navigator & { locks?: LockManager }).locks;
    return locks && typeof locks.request === 'function' ? locks : null;
  } catch {
    return null;
  }
}

export function createTabCoordinator(): TabCoordinator {
  let channel: BroadcastChannel | null = null;
  try {
    channel = new BroadcastChannel(CHANNEL);
  } catch {
    channel = null;
  }
  const id = tabId();
  /** A second, uncontended lock that identifies this tab in `locks.query()`. */
  const selfLock = `${LOCK}:${id}`;
  let locks = lockManager();
  let held = false;
  let lost = false;
  let release: () => void = () => {};
  let lostHandler: (() => void) | null = null;
  let handler: (() => Promise<void>) | null = null;
  let standingDown: Promise<void> | null = null;
  /** Stood down and released the lock: nothing left to hand over, so later requests get no answer. */
  let finished = false;
  let yielding = 0;
  let yielded = 0;
  let onAnswer: () => void = () => {};

  const markLost = () => {
    if (lost) return;
    lost = true;
    held = false;
    lostHandler?.();
  };

  /** Run the stand-down once, then release the lock (after the final save); later requests share the run. */
  const standDown = (run: () => Promise<void>) =>
    (standingDown ??= run()
      .catch(() => {})
      .finally(() => {
        held = false;
        finished = true;
        release();
      }));

  if (channel) {
    const ch = channel;
    ch.onmessage = (event: MessageEvent<Message>) => {
      const msg = event.data;
      // Only the active tab (or one still standing down) answers: an answer from a tab that has
      // already stopped would let the starting tab go ahead before the active tab has saved.
      if (msg?.type === 'takeover' && msg.from !== id && handler && !finished && !lost) {
        ch.postMessage({ type: 'yielding', to: msg.from } satisfies Message);
        void standDown(handler).finally(() => ch.postMessage({ type: 'yielded', to: msg.from } satisfies Message));
      } else if ((msg?.type === 'yielding' || msg?.type === 'yielded') && msg.to === id) {
        if (msg.type === 'yielding') yielding += 1;
        else yielded += 1;
        onAnswer();
      }
    };
  }

  /** Whether some tab holds the lock: true/false, or null when that cannot be told. */
  async function activeTabExists(): Promise<boolean | null> {
    if (!locks?.query) return null;
    try {
      const state = await locks.query();
      return !!state.held?.some((l) => l.name === LOCK);
    } catch {
      locks = null; // e.g. an opaque origin: locks cannot be used here at all
      return null;
    }
  }

  function waitForHandover(answerMs: number): Promise<void> {
    const started = Date.now();
    return new Promise<void>((resolve) => {
      let poll: ReturnType<typeof setInterval> | undefined;
      const check = () => {
        const elapsed = Date.now() - started;
        const settled = yielding > 0 ? yielded >= yielding : elapsed >= answerMs;
        if (settled || elapsed >= YIELD_MS) {
          clearInterval(poll);
          onAnswer = () => {};
          resolve();
        }
      };
      onAnswer = check;
      poll = setInterval(check, 25);
    });
  }

  /** Take the lock, stealing it from a tab that still holds it, and keep it for this page's life. */
  function acquire(): Promise<void> {
    const lm = locks;
    if (!lm) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, LOCK_MS);
      const settle = () => {
        clearTimeout(timer);
        resolve();
      };
      try {
        lm.request(selfLock, () => new Promise<void>(() => {})).catch(() => {});
        lm.request(LOCK, { steal: true }, () => {
          if (lost) return undefined; // stolen before this callback ran
          held = true;
          settle();
          return new Promise<void>((r) => (release = r));
        }).catch((err: unknown) => {
          // AbortError: another tab stole the lock. Anything else: locks cannot be used here.
          if ((err as { name?: string } | null)?.name === 'AbortError') markLost();
          else locks = null;
          settle();
        });
      } catch {
        locks = null;
        settle();
      }
    });
  }

  return {
    async takeOver() {
      const active = await activeTabExists();
      if (channel) {
        channel.postMessage({ type: 'takeover', from: id } satisfies Message);
        // A lock holder is a running tab: give it time to save. Without one, wait briefly for
        // tabs that run without locks.
        await waitForHandover(active ? YIELD_MS : ANSWER_MS);
      }
      await acquire();
    },
    onTakeover(fn) {
      handler = fn;
    },
    onLost(fn) {
      lostHandler = fn;
      if (lost) queueMicrotask(fn);
    },
    async isActive() {
      if (lost) return false;
      // Without a lock (unavailable here) the handshake is all there is.
      if (!held || !locks?.query) return true;
      try {
        // The lock may have been stolen a moment ago, before this tab has been told.
        const state = await locks.query();
        const holder = state.held?.find((l) => l.name === LOCK);
        const self = state.held?.find((l) => l.name === selfLock);
        const mine = !holder ? false : holder.clientId && self?.clientId ? holder.clientId === self.clientId : !lost;
        if (!mine) markLost();
        return mine;
      } catch {
        return !lost;
      }
    },
  };
}
