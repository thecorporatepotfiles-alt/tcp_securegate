# Architecture

## Overview

```
┌──────────────────────────── Browser (React SPA) ────────────────────────────┐
│  Management workspace (desktop/tablet)        Gate interface (touch, /gate)  │
│  TanStack Query · React Router · Tailwind     Camera QR (jsQR) · mock reader │
└───────────────────────────────┬──────────────────────────────────────────────┘
                                │ HTTPS · JSON · httpOnly SameSite=Strict cookie
┌───────────────────────────────▼──────────────────────────────────────────────┐
│  Express 5 API  ── helmet/CSP · rate limits · CSRF header · session resolver   │
│   routes/ (thin)  →  services/ (business rules, authorization, transactions)  │
│   ├─ verification  (resolvers per record type → result code, allowed action)   │
│   ├─ movement      (append-only events → derived presence, corrections)        │
│   ├─ visits · deliveries · vehicles · contractors · personnel/credentials      │
│   ├─ alerts · exceptions/handover · notifications · dashboard · reports        │
│   ├─ audit (hash-chained) · settings (configurable rules) · scheduler          │
│   └─ integrations/credentialReader (mock adapter boundary)                     │
└───────────────────────────────┬──────────────────────────────────────────────┘
                                │ better-sqlite3 (synchronous, transactional)
                         SQLite (WAL) — SQL migrations in server/src/db/migrations
```

A single Node.js process serves both the API (`/api/*`) and the built client. All business rules and authorization run on the server; the client only reflects what the server permits.

## Repository layout

| Path | Contents |
|---|---|
| `shared/constants.ts` | Roles, permissions and default grants, statuses, transitions, result codes, alert types — shared by server and client |
| `server/src/db/` | Connection, migration runner, `migrations/0001_initial_schema.sql` |
| `server/src/auth/` | Actor/context model, sessions, permission cache, scope helpers |
| `server/src/services/` | Domain services (one per module) |
| `server/src/routes/` | `auth.ts` (sign-in, config), `api.ts` (all endpoints), `middleware.ts` |
| `server/src/seed/demo.ts` | Idempotent synthetic dataset, demo reset, baseline roles/permissions |
| `server/src/integrations/` | Credential-reader integration boundary (mock only) |
| `server/test/` | Acceptance and business-rule tests |
| `client/src/` | React app: `pages/`, `gate/`, `components/`, `lib/` |
| `docs/` | This documentation |

## Data model

Normalized schema with foreign keys, CHECK constraints, partial unique indexes and triggers (`0001_initial_schema.sql`):

- **Organization structure:** `organizations`, `locations` (HQ + locations), `gates`.
- **Identity & access:** `users`, `user_locations`, `roles`, `permissions`, `role_permissions`, `sessions`, `settings`.
- **People:** `personnel`, `personnel_locations` (authorized locations), `visitors` (reusable identities), `contractor_companies`, `contractors`, `temporary_access`.
- **Credentials:** `credentials` (personnel or contractor holder; one active permanent + one active temporary per holder via partial unique indexes), `credential_history`.
- **Visits:** `visits`, `visit_status_history`, `visit_approvals` (one decision per visit — prevents duplicate approvals), `visit_passes` (one active pass per visit).
- **Vehicles & deliveries:** `vehicles`, `vehicle_locations`, `deliveries`, `delivery_status_history`.
- **Gate operations:** `verification_attempts`, `manual_reviews`, `movement_events`, `event_corrections`, `presence`.
- **Oversight:** `alerts`, `alert_history`, `admin_exceptions`, `admin_exception_history`, `handovers`, `notifications`, `audit_events`.
- **Housekeeping:** `ref_sequences` (human-readable references such as `VR-2026-00042`), `app_meta`, `schema_migrations`.

Shared entities are reused rather than duplicated: a visitor identity spans visits; a vehicle is registered once per organization and linked to visits/deliveries; movement events reference the subject (`subject_type`, `subject_id`) plus any related credential, pass, temporary access, delivery or vehicle.

## Key design decisions

### Verification is separate from movement
`POST /api/gate/verify` resolves the presented credential/QR/reference, applies every rule, logs a `verification_attempts` row and returns a result code plus the **allowed next action** (entry or exit) based on current presence. Nothing about a person's status changes. `POST /api/gate/events` then records the movement **only** if that attempt permits it, is recent (configurable TTL), belongs to the same operator, and the state is still consistent (re-checked inside the transaction). A QR scan alone never authorizes entry.

### Append-only events, derived presence
`movement_events`, `event_corrections` and `audit_events` reject `UPDATE`/`DELETE` via SQLite triggers. The `presence` table is a cache recomputed from the latest **valid** (non-voided) event for a subject; no API edits it. Corrections either void an event (a separate `event_corrections` row — the original remains) or add a clearly marked `CORRECTION_ENTRY` with the operator-reported time, while the server timestamp stays authoritative.

### Duplicate and inconsistent events
Client-generated idempotency keys (unique index) make retries return the original event. Each verification attempt can produce at most one event (unique `verification_attempt_id`). An entry while already inside, or an exit with no entry, is refused and raises an *inconsistent event* alert; the documented manual-review path is the only way to proceed, and it creates an administrative exception for follow-up.

### Visitor workflow and configurable transitions
Statuses: Expected → (Arrived → Host Notified → Waiting) → Approved → Inside → Exited, plus Overdue, Rejected, Cancelled and Expired. Permitted transitions live in settings (`visit.transitions`, `delivery.transitions`) and are enforced by the server for every change; INSIDE/EXITED are reachable only through recorded events. Approval records reviewer, time, decision and reason; requesters cannot approve their own requests unless configured.

### Opaque, signed QR tokens
A pass QR contains `SGV1.<nonce>.<mac>`: a random 128-bit nonce stored in the database and an HMAC-SHA256 (truncated) over it using a server secret. No personal data is encoded. A forged or altered code fails the MAC check before any lookup; a leaked database alone cannot mint valid codes. Contractor (`SGC1`) and temporary-access (`SGT1`) codes use the same scheme.

### Authorization model
Every request resolves an `Actor` (role, permission set from `role_permissions`, authorized location ids). Services call `requirePerm()` and filter every query by `location_id IN (actor scope)`; records outside scope return **404** (existence is not confirmed). HQ, System Administrator and Auditor roles have all-location scope; others are limited to `user_locations`. Permission and role changes apply on the next request (cached per role, invalidated on change); deactivating a user revokes their sessions.

### Time
All instants are stored as UTC ISO strings generated by the server. Calendar dates (visit dates, validity dates) and permitted hours are evaluated in the establishment's configured time zone (`APP_TIMEZONE`, default `Asia/Kolkata`).

### Scheduler
A periodic job (default every 60 s, also runnable from *System & Demo*) expires lapsed visits/passes and credentials, marks overdue visitors, and raises unclosed-visit, overstay, incomplete-delivery-acknowledgement and unresolved-exception alerts.

## Scaling and production path

The prototype targets one node with SQLite, which comfortably handles the demo and ~12,000 personnel. For an approved deployment:

- **Database:** the SQL is deliberately portable; move to PostgreSQL (row-level security can add defense-in-depth for location scoping), replace SQLite triggers with equivalent PostgreSQL triggers, and use proper sequences.
- **Sessions & rate limiting:** move from the in-process store/limiter to a shared store (e.g. Redis) for multiple nodes.
- **Real-time:** the UI polls (15–30 s); Server-Sent Events can replace polling without API changes.
- **Hardware:** connect approved readers through the integration boundary (see [INTEGRATIONS.md](INTEGRATIONS.md)).
