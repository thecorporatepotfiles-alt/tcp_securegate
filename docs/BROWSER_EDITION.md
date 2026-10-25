# Browser edition

The browser edition runs the whole of TCP SecureGate inside one web page. It contains the same React client and the **same server code**: routes, services, validation, RBAC, gate rules, audit trail, demo seed and scheduler. No server is involved. It exists so the prototype can be tried from a link without installing anything.

```bash
npm run build:browser      # → dist/browser/securegate.html (single self-contained file)
npm run serve:browser      # → http://127.0.0.1:4310 (also writes dist/browser/index.html, which opens from disk)
npm run e2e:browser        # browser smoke test of the built file
```

Each build is stamped with the git commit, whether the working tree had uncommitted changes, and the build time. The stamp is an HTML comment at the top of the file (`<!-- sg-build commit=… dirty=… built=… -->`) and `window.__SG_BROWSER__.build` at runtime. `serve:browser` prints it. `e2e:browser` fails when the file was not built from the current HEAD, or when bundled sources changed after the build. Set `SG_E2E_ALLOW_STALE=1` to report this as a warning instead. Always publish a file that passed this check.

## How it works

| Server piece | In the browser |
|---|---|
| `better-sqlite3` (native SQLite) | `browser/shims/better-sqlite3.ts`: the same API over [sql.js](https://sql.js.org) (SQLite compiled to WebAssembly). If the page's security policy forbids WebAssembly, it falls back to sql.js's pure-JavaScript build. |
| Express 5 HTTP server | `browser/shims/express.ts`: an Express-compatible router that runs `server/src/app.ts` and `server/src/routes/*` unmodified. The client's `/api/*` fetches are intercepted in the page (`browser/backend/transport.ts`) and dispatched to it. The session cookie, which is httpOnly in the server edition, is held in an in-page cookie jar instead. Page script can read it, and it is copied to this tab's sessionStorage (`sg:cookies`) so that a reload keeps you signed in. Signing out or erasing the demo data clears it, and it is gone when the tab closes. |
| `node:crypto` (scrypt, HMAC, random) | `browser/platform/crypto.ts`: @noble/hashes and `crypto.getRandomValues`. The output is byte-compatible with the Node implementation, and an equivalence test cross-checks the two. |
| Migrations read from disk | Bundled at build time (`browser/platform/migrationSource.ts`). |
| Data directory | IndexedDB on the viewer's device (`browser/backend/persistence.ts`). It holds the serialized database and the pass-signing secret, unencrypted. Changes made by user actions are saved within a fraction of a second, and any unsaved change is written when the page is hidden or closed. If IndexedDB is unavailable (some private windows), refuses writes (storage full), or does not answer in time, the data lives only as long as the page and the banner says so. |

The substitutions are listed in one place, `browser/build/stack.ts`. The full server test suite also runs through them in Node:

```bash
npx vitest run -c vitest.browser.config.ts   # the server test suite through the browser stack
```

## What differs from the server edition

- **Data stays on the device.** Each browser has its own synthetic dataset, generated the first time the page opens. *Start over with fresh demo data* on the sign-in page, or *Reset demo data* under System, regenerates it. Nothing is sent over the network.
- **One active tab at a time.** Each tab runs its own copy of the database, so only one tab uses the saved data. When the page opens in another tab, the older tab saves its changes, stops, and shows *SecureGate is open in another tab*. The active tab also holds an exclusive Web Lock, which a new tab takes over. A tab that cannot hand over in time (still starting, frozen or busy) loses the lock and stops without saving. If changes made in that tab had not been saved yet, its notice says they may not have been kept. Without Web Locks, only the BroadcastChannel handover applies.
- **Camera scanning is not available** inside the embedded page. Use *Scan from photo*: choose an image of a pass QR, for example one saved with *Save QR image* on a visitor pass. The simulated scanner and manual reference entry also remain. As in the server edition, a scan only identifies the pass, and verification and an explicit recording step are still required.
- **Printing is not available** in the embedded page. CSV exports and QR images are offered through the viewer's download prompt.
- **No real security boundary.** Role-based access, scoping and audit rules are enforced by the same code, but the viewer controls the entire runtime, including the database in their own browser. Page script can read the session token. The pass-signing secret (the HMAC key for SGV1/SGT1/SGC1 QR codes) is stored unencrypted next to the database in this browser's IndexedDB. So anyone with access to the browser profile can reuse the open tab's session or rebuild a valid QR code for any pass in that device's dataset. This is acceptable only because the edition holds synthetic data on a single device. The browser edition demonstrates behaviour and **must never hold real data**. It is not a deployment option.

Everything in [LIMITATIONS.md](LIMITATIONS.md) also applies. The prototype is not security-certified or approved for operational use.
