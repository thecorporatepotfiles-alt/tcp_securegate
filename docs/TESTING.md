# Testing

## How to run

```bash
npm test             # 87 API & business-logic tests (Vitest + Supertest, in-memory SQLite, frozen clock)
npm run typecheck    # server + client TypeScript
npm run build && npm run e2e   # browser smoke test at desktop/tablet/mobile widths (Playwright + Chromium)
```

Tests run against a fresh in-memory database seeded with the synthetic dataset and a frozen clock (`2026-10-24 11:30 IST`), so time-based rules (expiry, overdue, session timeout) are tested deterministically by advancing the clock.

## Acceptance scenarios → tests

| # | Scenario | Where it is verified |
|---|---|---|
| 1 | Administrator creates a synthetic personnel record | `personnel-credentials.test.ts` › scenario 1 |
| 2 | Credential assigned and blocked | `personnel-credentials.test.ts` › scenario 2 (also asserts alert + audit) |
| 3 | Inactive credential rejected | `personnel-credentials.test.ts` › scenario 3 (inactive credential and inactive personnel) |
| 4 | Host creates a visitor request | `visitors.test.ts` › scenarios 4–6, 8, 9 |
| 5 | Officer approves or rejects | `visitors.test.ts` › approval flow; *rejected requests require a reason and never produce a valid pass* |
| 6 | Approved request generates a valid QR pass | `visitors.test.ts` › token is opaque `SGV1.<nonce>.<mac>`, verifies as *Verified* |
| 7 | Expired and cancelled passes rejected | `visitors.test.ts` › scenario 7 |
| 8 | Gate operator records an authorized visitor entry | `visitors.test.ts` › scenarios 4–6, 8, 9 |
| 9 | Recorded exit updates current status | `visitors.test.ts`; `gate-events.test.ts` › *verification alone does not change status…* |
| 10 | Duplicate entry/exit submissions handled safely | `gate-events.test.ts` › scenario 10 (idempotency key, reused attempt, second entry) |
| 11 | Temporary credential expires correctly | `personnel-credentials.test.ts` › scenario 11; temporary access in `vehicles-deliveries-contractors.test.ts` |
| 12 | Contractor searched and history viewed | `vehicles-deliveries-contractors.test.ts` › scenario 12 |
| 13 | Delivery arrival registered | `vehicles-deliveries-contractors.test.ts` › scenarios 13 & 14 |
| 14 | Delivery receipt acknowledged and audited | `vehicles-deliveries-contractors.test.ts` › scenarios 13 & 14 |
| 15 | Vehicle registered, entry and exit recorded | `vehicles-deliveries-contractors.test.ts` › scenario 15 |
| 16 | Vehicle movement separate from occupant movement | `vehicles-deliveries-contractors.test.ts` › scenario 16 |
| 17 | Waiting list shows pending visitors | `visitors.test.ts` › scenario 17 |
| 18 | HQ views consolidated summaries | `auth-rbac.test.ts` › *HQ sees consolidated summaries* |
| 19 | Local users cannot access other locations | `auth-rbac.test.ts` › *local users only see their location*, *guards cannot operate gates of another location* |
| 20 | Alerts acknowledged and resolved | `oversight-reports-audit.test.ts` › scenario 20 |
| 21 | Administrative exceptions created and resolved | `oversight-reports-audit.test.ts` › scenario 21 (+ handover) |
| 22 | Reports and CSV exports return accurate filtered records | `oversight-reports-audit.test.ts` › *dashboard counts match report totals*, *CSV export returns exactly the filtered rows* |
| 23 | Important actions appear in the audit trail | `oversight-reports-audit.test.ts` › scenario 23 (+ tamper detection, no secrets logged) |
| 24 | Refreshing preserves database-backed changes | `oversight-reports-audit.test.ts` › scenario 24 (file database reopened); e2e › reload after recording |
| 25 | Major screens work on desktop, tablet and mobile | `npm run e2e` (28 management screens × 3 viewports + gate flow; fails on errors or horizontal overflow) |
| 26 | Every role completes its permitted workflow | `role-workflows.test.ts` (per-role endpoints; every simulated-scanner sample yields its advertised result) |
| 27 | Invalid input, expired sessions, permission changes | `auth-rbac.test.ts` › invalid input, idle-session expiry, permission change on next request, deactivated users |
| 28 | Demo seeding does not create duplicates | `oversight-reports-audit.test.ts` › scenario 28 |

## Additional behaviour covered

- Segregation of duties (requester cannot approve), single decision per request, configurable transitions enforced server-side.
- Security-verification step gating pass issue; overdue detection and overstay alerts; exit always possible for an overdue visitor.
- Manual review: denied results cannot be bypassed; eligible results can be referred; reviewer cannot be the requester; approved review permits exactly one movement.
- Corrections void events without deleting them; missing movements are added as marked correction entries; presence always equals the latest valid event; database triggers block updates/deletes of movement and audit records.
- Verification TTL, operator binding of verifications, repeated-failure alerts, configurable alert rules.
- CSV formula-injection neutralization; auditors read-only; demo login/reset disabled in production mode; CSRF header enforcement; account lockout.
- Partial updates never reset omitted fields (regression for Zod default behaviour).

## Performance check

Seeded with 12,000 personnel and ~100,000 movement events, typical API responses on a development container: dashboard 0.10 s (7-day range 0.23 s), Who Is Inside 0.01–0.03 s, personnel search 0.02 s, unified register search 0.28 s, 7-day reports 0.05–0.09 s.
