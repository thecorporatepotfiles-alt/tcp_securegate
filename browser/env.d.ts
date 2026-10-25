/// <reference types="vite/client" />

declare module 'sql.js/dist/sql-wasm-browser.js' {
  import type initSqlJs from 'sql.js';
  const init: typeof initSqlJs;
  export default init;
}

declare module 'sql.js/dist/sql-asm.js' {
  import type initSqlJs from 'sql.js';
  const init: typeof initSqlJs;
  export default init;
}

/** The sql.js WebAssembly binary, base64-encoded at build time. */
declare module 'virtual:sqljs-wasm' {
  const base64: string;
  export default base64;
}

/** Build stamp (commit, dirty tree, build time), defined by vite.browser.config.ts / scripts/build-browser.mjs. */
declare const __SG_BUILD__: { commit: string; dirty: boolean; builtAt: string };
