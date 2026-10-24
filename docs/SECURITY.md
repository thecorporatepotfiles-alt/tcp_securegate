# Security, privacy and reliability

This prototype applies secure-by-default engineering, but it **has not been penetration-tested, accredited or certified**, and it is **not approved for operational use**. The authorized establishment must approve the final deployment architecture, hosting, networking, data retention, integrations, backups and security controls.

## Controls implemented

| Area | Implementation |
|---|---|
| Authentication | Username + password; passwords hashed with scrypt (N=16384, per-user salt, constant-time compare; dummy hash for unknown users). Account lockout after 8 failures for 15 minutes. Login rate limited per IP. |
| Sessions | 256-bit random tokens; only SHA-256 hashes stored. `httpOnly`, `SameSite=Strict`, `Secure` in production. Idle timeout (60 min demo / 15 min production) and 12 h absolute limit. Revoked on logout, password change, password reset and user deactivation. |
| CSRF | SameSite=Strict cookie plus a mandatory `X-SG-Request` header on state-changing requests (cannot be sent cross-site without a CORS preflight, which the API never grants). |
| Authorization | Role permissions stored in the database and checked server-side on every endpoint; location scope applied to every query; out-of-scope records return 404. Role assignment limited by the actor's role (e.g. Location Administrators can create only Host/Guard users in their own locations). Auditor role is enforced read-only. Permission changes take effect on the next request. |
| Input validation | Zod schemas on every request (types, lengths, formats, enumerations); JSON body limit 100 KB; parameterized SQL only; sort keys whitelisted. Partial updates apply only the fields actually sent. |
| Output safety | React escapes rendered data; CSV exports neutralize spreadsheet formulas (`= + - @`); strict Content-Security-Policy (`default-src 'self'`, no inline scripts, `frame-ancestors 'none'`), `nosniff`, `no-referrer`, HSTS when secure cookies are on. |
| QR / access tokens | Opaque `prefix.nonce.mac` tokens; HMAC-SHA256 with a server secret; no personal data in codes; tokens are never written to logs or audit metadata. Pass display restricted to host, requester, approving officer and visitor administrators. |
| Credentials | Credential numbers only identify a record; personal data stays in the database. Credential numbers are masked in lists, logs and reports. |
| Audit | Append-only, hash-chained audit trail (tamper detection via *Verify integrity*). Covers sign-in/out (including failures), personnel, credentials, visits, approvals, passes, verification, movement, corrections, vehicles, deliveries, alerts, exceptions, handovers, settings, roles, users, exports and denied access. Metadata is scrubbed of passwords, tokens, nonces and session data. |
| Data integrity | Foreign keys, CHECK constraints, partial unique indexes, transactions for multi-step operations, append-only triggers on movement events, corrections and audit records. Server timestamps are authoritative. |
| Rate limiting | Global API limit per IP, sign-in limit per IP, gate verification/recording limit per operator. |
| Secrets | No secrets in source control. `TOKEN_SECRET` is required in production; in demo mode a random secret is generated into the (git-ignored) data directory. |
| Demo safeguards | Demo login, demo seeding and demo reset are disabled when `APP_MODE=production`; demo reset additionally requires `demo.reset` permission and typed confirmation in the UI. A persistent banner marks demo mode and simulated verification. |

## Privacy

- Only fictional data is used; never load real personnel, credentials or operational records into the prototype.
- Visitor records hold name, organization and optional contact details only; no identity-document numbers are collected.
- The handover form warns against recording sensitive operational instructions.
- Data retention periods are **not** implemented and must be defined by the establishment.

## Backup and recovery

- `npm run db:backup [file]` takes an online, consistent SQLite backup (better-sqlite3 backup API).
- SQLite runs in WAL mode with foreign keys enforced.
- A production deployment should schedule encrypted, off-host backups and test restores; with PostgreSQL use point-in-time recovery.

## Dependency hygiene

- `npm audit` reported 0 known vulnerabilities at the time of writing (zod and vitest were upgraded to patched versions).
- Run `npm audit` and update dependencies before any deployment.

## Review

The server code was independently reviewed for authorization and data-exposure issues; all confirmed findings were fixed and covered by regression tests (see [TESTING.md](TESTING.md#independent-security-review)). This is not a substitute for a professional penetration test.

## Known gaps before operational use

- TLS termination and certificate management (deploy behind an approved reverse proxy).
- Multi-factor authentication and integration with the establishment's identity provider.
- Centralized logging/SIEM export, log retention and monitoring.
- Shared session and rate-limit stores for multi-node deployments.
- Formal threat model, penetration test and accreditation.
- Manual reference entry (typing a visit/contractor/temporary-access reference instead of scanning the signed QR) is enabled for demonstrations; references are sequential and should be disabled or restricted by policy for operational use.
- Data-retention and archival policy enforcement.
