/**
 * Browser edition build: the React client plus the unmodified server code,
 * bundled into one page (see browser/build/stack.ts for the substitutions).
 * `npm run build:browser` runs this and inlines the result into a single
 * self-contained HTML file.
 */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { builtinAliases, packageAliases, swapSources } from './browser/build/stack';

const WASM_ID = 'virtual:sqljs-wasm';

/** Exposes the sql.js WebAssembly binary as a base64 string so the page needs no extra files. */
function sqlJsWasm(): Plugin {
  return {
    name: 'securegate-sqljs-wasm',
    resolveId: (id) => (id === WASM_ID ? `\0${WASM_ID}` : null),
    load(id) {
      if (id !== `\0${WASM_ID}`) return null;
      const file = fileURLToPath(new URL('./node_modules/sql.js/dist/sql-wasm-browser.wasm', import.meta.url));
      return `export default ${JSON.stringify(fs.readFileSync(file).toString('base64'))};`;
    },
  };
}

/** Keep only the Latin subset of the Inter font; other scripts fall back to system fonts. */
function latinFontOnly(): Plugin {
  return {
    name: 'securegate-latin-font',
    enforce: 'pre',
    transform(code, id) {
      if (!/@fontsource-variable[\\/]inter[\\/]index\.css/.test(id)) return null;
      const blocks = code.split(/(?=\/\* inter-)/);
      return blocks.filter((b) => !b.startsWith('/* inter-') || b.startsWith('/* inter-latin-wght-normal */')).join('');
    },
  };
}

export default defineConfig({
  root: 'browser',
  base: './',
  publicDir: false,
  plugins: [react(), tailwindcss(), swapSources(['crypto', 'migrations']), sqlJsWasm(), latinFontOnly()],
  resolve: {
    alias: [...packageAliases(['better-sqlite3', 'express', 'helmet', 'cookie-parser']), ...builtinAliases()],
  },
  define: {
    'import.meta.env.VITE_SG_EDITION': JSON.stringify('browser'),
  },
  build: {
    outDir: '../dist/browser-build',
    emptyOutDir: true,
    target: 'es2022',
    assetsInlineLimit: 100 * 1024 * 1024,
    cssCodeSplit: false,
    modulePreload: false,
    chunkSizeWarningLimit: 8000,
    reportCompressedSize: false,
    rollupOptions: {
      output: { inlineDynamicImports: true },
    },
  },
});
