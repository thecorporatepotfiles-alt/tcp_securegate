import type { SqlJsStatic } from 'sql.js';
import initWasm from 'sql.js/dist/sql-wasm-browser.js';
import initAsm from 'sql.js/dist/sql-asm.js';
import wasmBase64 from 'virtual:sqljs-wasm';

export type Engine = 'wasm' | 'asm';

function decodeBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${what} timed out`)), ms))]);
}

/**
 * Load SQLite. The WebAssembly build is faster; pages whose content security
 * policy forbids compiling WebAssembly fall back to the pure-JavaScript
 * (asm.js) build of the same SQLite version.
 */
export async function loadSqlEngine(): Promise<{ SQL: SqlJsStatic; engine: Engine }> {
  if (typeof WebAssembly === 'object') {
    try {
      const wasmBinary = decodeBase64(wasmBase64);
      const SQL = await withTimeout(initWasm({ wasmBinary: wasmBinary.buffer as ArrayBuffer }), 20_000, 'SQLite (WebAssembly) start-up');
      return { SQL, engine: 'wasm' };
    } catch {
      /* fall through to asm.js */
    }
  }
  const SQL = await withTimeout(initAsm(), 60_000, 'SQLite (JavaScript) start-up');
  return { SQL, engine: 'asm' };
}
