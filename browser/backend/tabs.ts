/**
 * One active tab per browser. Each tab runs its own in-memory database and
 * saves whole snapshots, so two active tabs would silently overwrite each
 * other's changes. A starting tab therefore asks any active tab to save and
 * stand down before it reads the saved data.
 */

const CHANNEL = 'tcp-securegate-browser-edition';
/** How long a starting tab waits for an active tab to answer at all. */
const ANSWER_MS = 250;
/** Upper bound for an active tab to finish saving. */
const YIELD_MS = 5000;

type Message = { type: 'takeover'; from: string } | { type: 'yielding' | 'yielded'; to: string };

export interface TabCoordinator {
  /** Ask other tabs to save and stand down; resolves when they have, or when none answers. */
  takeOver(): Promise<void>;
  /** Register what this (now active) tab does when another tab takes over. */
  onTakeover(handler: () => Promise<void>): void;
}

function tabId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function createTabCoordinator(): TabCoordinator {
  let channel: BroadcastChannel | null = null;
  try {
    channel = new BroadcastChannel(CHANNEL);
  } catch {
    channel = null;
  }
  const id = tabId();
  let handler: (() => Promise<void>) | null = null;
  let yielding = 0;
  let yielded = 0;
  let onAnswer: () => void = () => {};

  if (channel) {
    const ch = channel;
    ch.onmessage = (event: MessageEvent<Message>) => {
      const msg = event.data;
      if (msg?.type === 'takeover' && msg.from !== id && handler) {
        const run = handler;
        handler = null;
        ch.postMessage({ type: 'yielding', to: msg.from } satisfies Message);
        void run().finally(() => ch.postMessage({ type: 'yielded', to: msg.from } satisfies Message));
      } else if ((msg?.type === 'yielding' || msg?.type === 'yielded') && msg.to === id) {
        if (msg.type === 'yielding') yielding += 1;
        else yielded += 1;
        onAnswer();
      }
    };
  }

  return {
    async takeOver() {
      if (!channel) return;
      channel.postMessage({ type: 'takeover', from: id } satisfies Message);
      const started = Date.now();
      await new Promise<void>((resolve) => {
        const check = () => {
          const elapsed = Date.now() - started;
          const settled = yielding > 0 ? yielded >= yielding : elapsed >= ANSWER_MS;
          if (settled || elapsed >= YIELD_MS) {
            clearInterval(poll);
            resolve();
          }
        };
        onAnswer = check;
        const poll = setInterval(check, 50);
      });
      onAnswer = () => {};
    },
    onTakeover(fn) {
      handler = fn;
    },
  };
}
