# TCP SecureGate

**Secure gate, visitor and entry–exit management — functional prototype by The Corporate Pot.**

TCP SecureGate replaces manual gate registers with one accountable digital record of who is inside an establishment: personnel, visitors, contractors and vendors, temporary-access holders, delivery personnel and vehicles — across a headquarters and multiple locations.

> **Prototype status.** This is a demonstration build that runs on **synthetic data with simulated verification**. It is not connected to any personnel database, operational network, access-control hardware or third-party service, has not been security-certified, and is **not approved for operational use**. Final hosting, networking, integrations, retention, backups and security controls must be approved by the authorized establishment.

---

## Quick start (demo)

Requirements: **Node.js 20.11+** (tested on 22.x). No database server is needed — SQLite is embedded.

```bash
npm install
npm run build          # builds the web client and the API server bundle
npm start              # http://127.0.0.1:3000  (demo data is created on first start)
```

Open <http://127.0.0.1:3000> and pick a role on the sign-in screen. Every demo account uses the synthetic password `SecureGate-Demo-2026`.

For development with hot reload:

```bash
npm run dev            # API on :3000, web client on http://127.0.0.1:5173
```

To use the gate interface from a phone or tablet on the same network, start with `HOST=0.0.0.0 npm start` and open `http://<your-ip>:3000/gate`. Camera QR scanning in browsers requires HTTPS or `localhost`; over plain LAN HTTP use the simulated scanner or manual reference entry.

## Demo accounts

| Username | Role | Scope | Use it to show |
|---|---|---|---|
| `admin` | System Administrator | All locations | Users, roles & permissions, locations & gates, workflow settings, demo reset |
| `hq.admin` | HQ Administrator | All locations | Consolidated dashboard, location-wise reports, alerts |
| `alpha.admin` | Location Administrator | Location Alpha | Personnel & credentials, manual reviews, corrections, local users |
| `alpha.officer` | Approving Officer / Host | Location Alpha | Approval queue, walk-in acknowledgement, receipts |
| `alpha.host` | Approving Officer / Host | Location Alpha | Creating visitor requests, sharing QR passes |
| `alpha.guard` | Security Guard | Alpha Main Gate | Touch-friendly gate interface |
| `alpha.guard2` | Security Guard | Alpha Vehicle Gate | Vehicle movement |
| `bravo.*`, `charlie.*`, `delta.*`, `hq.guard`, `hq.officer` | Various | Their location | Location isolation |
| `auditor` | Auditor (read-only) | All locations | Reports, CSV export, audit-chain verification |

See **[docs/DEMO_GUIDE.md](docs/DEMO_GUIDE.md)** for a scripted 15-minute walkthrough.

## Commands

| Command | Purpose |
|---|---|
| `npm run dev` | API (tsx watch) + Vite dev server |
| `npm run build` | Production build: `dist/client` + `dist/server` |
| `npm start` | Run the built server (serves the client too) |
| `npm test` | 101 automated API/business-logic tests (Vitest + Supertest) |
| `npm run typecheck` | TypeScript checks for server and client |
| `npm run e2e` | Browser smoke test + responsive screenshots (requires Playwright/Chromium) |
| `npm run db:migrate` | Apply SQL migrations |
| `npm run db:seed` | Create the synthetic dataset (idempotent; demo mode only) |
| `npm run db:reset` | Drop and rebuild the demo dataset (demo mode only) |
| `npm run db:bootstrap -- <user> <password> [org]` | Production onboarding: first org, HQ and System Administrator |
| `npm run db:backup [file]` | Online SQLite backup |

Configuration is via environment variables — see [`.env.example`](.env.example).

## What is implemented

- **Gate interface** — verify personnel credentials (mock reader / manual entry), scan visitor QR (camera or simulated scanner), contractors, temporary access, vehicles and deliveries; explicit *verify → confirm → record* steps; duplicate-safe recording; manual-review referral; walk-in registration; recent events; alerts.
- **Visitors** — requests, approval with segregation of duties, optional security-verification step, signed QR passes, host notifications and acknowledgement, waiting list, overdue detection.
- **Personnel & credentials** — directory, records, authorized locations, credential assign/block/lost/replace/deactivate with history; inactive records are rejected at the gate.
- **Contractors, vendors & service personnel**, **temporary access**, **vehicles**, **deliveries** (with receipt acknowledgement).
- **Unified gate register** and **Who Is Inside?** derived from append-only movement events; auditable corrections.
- **Alerts** with configurable rules, **administrative exceptions**, **shift handover**.
- **Dashboard**, **16 reports** with CSV export and print, **hash-chained audit trail**.
- **Multi-location RBAC** enforced server-side; demo mode with role selector and reset.

Details: [Architecture](docs/ARCHITECTURE.md) · [API](docs/API.md) · [Security](docs/SECURITY.md) · [Integrations](docs/INTEGRATIONS.md) · [Testing](docs/TESTING.md) · [Simulated features & limitations](docs/LIMITATIONS.md)
