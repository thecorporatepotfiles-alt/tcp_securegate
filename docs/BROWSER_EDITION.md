# Browser edition

The browser edition runs the whole of TCP SecureGate inside one web page. It contains the same React client and the **same server code**: routes, services, validation, RBAC, gate rules, audit trail, demo seed and scheduler. No server is involved. It exists so the prototype can be tried from a link without installing anything.

```bash
npm run build:browser      # → dist/browser/securegate.html (single self-contained file)
npm run serve:browser      # → http://127.0.0.1:4310 (also writes dist/browser/index.html, which opens from disk)
npm run e2e:browser        # browser smoke test of the built file
```

## How it works

| Server piece | In the browser |
|---|---|
| `better-sqlite3` (native SQLite) | `browser/shims/better-sqlite3.ts`: the same API over [sql.js](https://sql.js.org) (SQLite compiled to WebAssembly). If the page's security policy forbids WebAssembly, it falls back to sql.js's pure-JavaScript build. |
| Express 5 HTTP server | `browser/shims/express.ts`: an Express-compatible router that runs `server/src/app.ts` and `server/src/routes/*` unmodified. The client's `/api/*` fetches are intercepted in the page (`browser/backend/transport.ts`) and dispatched to it. The httpOnly session cookie is held in an in-page cookie jar. |
| `node:crypto` (scrypt, HMAC, random) | `browser/platform/crypto.ts`: @noble/hashes and `crypto.getRandomValues`. The output is byte-compatible with the Node implementation, and an equivalence test cross-checks the two. |
| Migrations read from disk | Bundled at build time (`browser/platform/migrationSource.ts`). |
| Data directory | IndexedDB on the viewer's device (`browser/backend/persistence.ts`). Changes made by user actions are saved within a fraction of a second. If IndexedDB is unavailable (some private windows), the data lives only as long as the page. |

The substitutions are listed in one place, `browser/build/stack.ts`. The full server test suite also runs through them in Node:

```bash
npx vitest run -c vitest.browser.config.ts   # the 101 server tests through the browser stack
```

## What differs from the server edition

- **Data stays on the device.** Each browser has its own synthetic dataset, generated the first time the page opens. *Start over with fresh demo data* on the sign-in page, or *Reset demo data* under System, regenerates it. Nothing is sent over the network.
- **Camera scanning is not available** inside the embedded page. Use *Scan from photo*: choose an image of a pass QR, for example one saved with *Save QR image* on a visitor pass. The simulated scanner and manual reference entry also remain. As in the server edition, a scan only identifies the pass, and verification and an explicit recording step are still required.
- **Printing is not available** in the embedded page. CSV exports and QR images are offered through the viewer's download prompt.
- **No real security boundary.** Role-based access, scoping and audit rules are enforced by the same code, but the viewer controls the entire runtime, including the database in their own browser. The browser edition demonstrates behaviour and **must never hold real data**. It is not a deployment option.

Everything in [LIMITATIONS.md](LIMITATIONS.md) also applies. The prototype is not security-certified or approved for operational use.
