import { useEffect, useState } from 'react';

/**
 * Edition switches. The standard edition is served by the Node server; the
 * browser edition runs the same server code inside the page (a sandboxed
 * claude.ai Artifact frame) where printing, `<a download>`, new tabs and the
 * camera are unavailable and files are saved through the platform instead.
 */
export const BROWSER_EDITION = import.meta.env.VITE_SG_EDITION === 'browser';

/** Bridge exposed by the in-page server once it has started (browser edition only). */
export interface BrowserHostBridge {
  engine: 'wasm' | 'asm';
  storage: 'indexeddb' | 'memory';
  resetLocalData(): Promise<void>;
}

/** The in-page server bridge, or undefined in the standard edition / before it has started. */
export function browserHost(): BrowserHostBridge | undefined {
  if (!BROWSER_EDITION) return undefined;
  try {
    // Cast rather than augment Window: the bridge's own module declares the global.
    return (window as unknown as { __SG_BROWSER__?: BrowserHostBridge }).__SG_BROWSER__;
  } catch {
    return undefined;
  }
}

/** One-line description of where the browser edition keeps its data. */
export function browserEditionNote(): string {
  const persistence = browserHost()?.storage === 'memory' ? 'changes are lost when the page is closed.' : 'changes are kept on this device.';
  return `Browser edition — runs entirely in this browser. Synthetic data only; ${persistence}`;
}

export type FileData = string | Blob | ArrayBuffer | ArrayBufferView;

interface DownloadsCapability {
  save(input: { filename: string; data: FileData }): Promise<{ status: 'saved' | 'delivered' }>;
}

let downloadsPromise: Promise<DownloadsCapability | null> | null = null;
let downloadsResolved: DownloadsCapability | null | undefined;

/** The platform "downloads" capability, or null when this page is not running inside the viewer. */
export function getDownloads(): Promise<DownloadsCapability | null> {
  if (!downloadsPromise) {
    downloadsPromise = (async () => {
      try {
        const host = (window as unknown as { claude?: { use?: (name: string) => Promise<unknown> } }).claude;
        if (!host || typeof host.use !== 'function') return null;
        // The viewer resolves null after ~10 s when unavailable; never wait forever.
        const cap = await Promise.race([host.use('downloads'), new Promise<null>((r) => setTimeout(() => r(null), 20_000))]);
        return cap && typeof (cap as DownloadsCapability).save === 'function' ? (cap as DownloadsCapability) : null;
      } catch {
        return null;
      }
    })().then((d) => (downloadsResolved = d));
  }
  return downloadsPromise;
}

/** 'declined' means the viewer chose not to save: callers show nothing. */
export type SaveResult = 'saved' | 'declined';

const SAVE_ERRORS: Record<string, string> = {
  rate_limited: 'Too many files were saved in a short time. Wait a moment and try again.',
  rejected_extension: 'This type of file cannot be saved here.',
  unavailable: 'Saving files is not available in this view.',
  not_granted: 'Saving files is not available in this view.',
};

/** Save a generated file: a browser download in the standard edition, the platform capability in the browser edition. */
export async function saveFile({ filename, data, mimeType }: { filename: string; data: FileData; mimeType?: string }): Promise<SaveResult> {
  if (!BROWSER_EDITION) {
    const blob = data instanceof Blob ? data : new Blob([data as BlobPart], mimeType ? { type: mimeType } : undefined);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return 'saved';
  }
  const downloads = await getDownloads();
  if (!downloads) throw new Error(SAVE_ERRORS.unavailable);
  try {
    await downloads.save({ filename, data });
    return 'saved';
  } catch (e) {
    const code = (e as { code?: unknown })?.code;
    if (code === 'declined') return 'declined';
    throw new Error((typeof code === 'string' && SAVE_ERRORS[code]) || 'The file could not be saved. Try again.');
  }
}

/** Whether file-saving affordances should be shown (browser edition: once the capability is confirmed). */
export function useCanSaveFiles(): boolean {
  const [can, setCan] = useState(() => !BROWSER_EDITION || !!downloadsResolved);
  useEffect(() => {
    if (!BROWSER_EDITION) return;
    let live = true;
    getDownloads().then((d) => live && setCan(!!d));
    return () => {
      live = false;
    };
  }, []);
  return can;
}
