# API reference

All endpoints are under `/api`, exchange JSON and require a session cookie unless marked *public*. State-changing requests must include the header `X-SG-Request: 1`. List endpoints accept `page`, `pageSize` (≤200), `q`, `sort`, `dir` and `locationId` (must be within the caller's scope) and return `{ items, total, page, pageSize }`.

Errors use `{ "error": { "code", "message", "details?" } }` with status 400 (validation; `details.fields`), 401 (`UNAUTHENTICATED`, `SESSION_EXPIRED`, `ACCOUNT_DISABLED`), 403 (`FORBIDDEN`, `CSRF`), 404 (not found *or out of scope*), 409 (conflict, duplicate), 422 (invalid state/transition), 429 (rate limited).

## Session

| Method | Path | Notes |
|---|---|---|
| GET | `/config` | *Public.* Mode, time zone, demo banner, demo accounts (demo mode only) |
| POST | `/auth/login` | *Public.* `{ username, password }` |
| POST | `/auth/demo-login` | *Public, demo mode only.* `{ username }` of a demo account |
| POST | `/auth/logout` | |
| GET | `/auth/me` | User, permissions, authorized locations with gates, option lists |
| POST | `/auth/change-password` | `{ currentPassword, newPassword }` |
| GET | `/health` | *Public.* Liveness |

## Gate operations (`gate.operate`)

| Method | Path | Notes |
|---|---|---|
| POST | `/gate/verify` | `{ gateId, mode: PERSONNEL\|VISITOR\|CONTRACTOR\|TEMPORARY\|VEHICLE\|DELIVERY, input, method? }` → result, subject, presence, `allowedActions`, `expiresAt` |
| POST | `/gate/events` | `{ attemptId, eventType: ENTRY\|EXIT, idempotencyKey?, notes?, driverReference?, purpose?, sponsoringDepartment?, linkedSubjectType?, linkedSubjectId? }` |
| GET | `/gate/:gateId/home` · `/recent` · `/visitors` · `/deliveries` · `/hosts` · `/recipients` · `/alerts` | Gate screens |
| GET | `/gate/:gateId/demo-samples` | *Demo mode only.* Simulated-scanner samples |
| POST | `/gate/walk-in` | Register an unannounced visitor (entry still requires authorization) |
| POST | `/gate/visits/:id/arrive` | Mark a pre-registered visitor arrived; notifies host |
| POST | `/gate/vehicles` | Register an unknown vehicle (status `PENDING`) |
| POST | `/gate/deliveries` · `/gate/deliveries/:id/arrive` · `/gate/deliveries/:id/depart` | Delivery arrival/departure |
| POST | `/gate/manual-reviews` | `{ attemptId, requestedAction, note }` — refer a denied verification |
| GET / POST | `/manual-reviews`, `/manual-reviews/:id`, `/manual-reviews/:id/decide` | Decide requires `gate.manual_review`; requesters cannot decide their own |

## Records

| Area | Endpoints | Permissions |
|---|---|---|
| Personnel | `GET/POST /personnel`, `GET/PATCH /personnel/:id`, `POST /personnel/:id/status`, `GET /personnel/units` | `personnel.view` / `personnel.manage` |
| Credentials | `GET/POST /credentials`, `GET /credentials/:id`, `POST /credentials/:id/status` (`BLOCK`, `REPORT_LOST`, `DEACTIVATE`, `REACTIVATE`), `POST /credentials/:id/replace` | `credentials.view` / `credentials.manage` |
| Visits | `GET/POST /visits`, `GET /visits/waiting-list`, `GET /visits/:id`, `GET /visits/:id/pass`, `POST /visits/:id/{approve,reject,security-check,cancel,acknowledge}` | `visitors.*` (hosts see their own visits) |
| Contractors | `GET/POST /contractor-companies`, `PATCH /contractor-companies/:id`, `GET/POST /contractors`, `GET/PATCH /contractors/:id`, `GET /contractors/:id/pass`, `POST /contractors/:id/pass/reissue` | `contractors.*` |
| Temporary access | `GET/POST /temporary-access`, `GET /temporary-access/:id`, `GET /temporary-access/:id/pass`, `POST /temporary-access/:id/revoke` | `temp_access.*` |
| Vehicles | `GET/POST /vehicles`, `GET/PATCH /vehicles/:id` | `vehicles.*` |
| Deliveries | `GET/POST /deliveries`, `GET /deliveries/:id`, `POST /deliveries/:id/{authorize,reject,cancel,acknowledge}` | `deliveries.*` (recipients may authorize/acknowledge their own) |

## Oversight

| Area | Endpoints | Permissions |
|---|---|---|
| Dashboard | `GET /dashboard?locationId&gateId&from&to&category` | `dashboard.view` |
| Who is inside | `GET /presence?category&state&gateId` | `presence.view` |
| Gate register | `GET /events`, `GET /events/:id` | `events.view` |
| Corrections | `POST /events/:id/void`, `POST /corrections/missing-event` | `events.correct` |
| Alerts | `GET /alerts`, `GET /alerts/:id`, `POST /alerts/:id/acknowledge`, `POST /alerts/:id/resolve` | `alerts.view` / `.acknowledge` / `.resolve` |
| Exceptions | `GET/POST /exceptions`, `GET /exceptions/:id`, `POST /exceptions/:id/status`, `POST /exceptions/:id/assign` | `exceptions.*` |
| Handover | `GET /handover/summary?locationId`, `GET/POST /handovers`, `POST /handovers/:id/acknowledge` | `handover.manage` |
| Reports | `GET /reports`, `GET /reports/:key`, `GET /reports/:key/export` (CSV) | `reports.view` / `reports.export` (+`audit.view`, `credentials.view` for those reports) |
| Audit | `GET /audit/record?entityType&entityId`, `GET /audit/verify` | `audit.view` |
| Notifications | `GET /notifications`, `POST /notifications/:id/read`, `POST /notifications/read-all` | own only |
| Lookups | `GET /lookups/{approvers,hosts,recipients,users}?locationId`, `GET /lookups/{personnel,visitors,contractors}?q` | context-dependent |

## Administration

| Endpoints | Permissions |
|---|---|
| `GET/POST /admin/users`, `PATCH /admin/users/:id`, `POST /admin/users/:id/password` | `users.manage` (within assignable roles and own locations) |
| `GET /admin/roles`, `PUT /admin/roles/:role` | `roles.manage` |
| `GET/POST /admin/locations`, `PATCH /admin/locations/:id`, `POST /admin/gates`, `PATCH /admin/gates/:id` | `locations.manage` (locations: System Administrator only) |
| `GET /admin/settings`, `PUT /admin/settings/:key` `{ value }` | `settings.manage` |
| `POST /admin/run-checks` | `settings.manage` or `alerts.resolve` |
| `GET /integrations/readers` | gate/credential/location managers |
| `POST /admin/demo/reset` | `demo.reset`, demo mode only |

### Report keys

`daily-movement`, `personnel-movement`, `contractor-movement`, `vendor-visits`, `vehicle-movement`, `visitor-register`, `active-visitors`, `overdue-visits`, `temporary-access`, `delivery-activity`, `denied-verifications`, `gate-activity`, `location-activity`, `credential-history`, `admin-exceptions`, `audit-history`.
