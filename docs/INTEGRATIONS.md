# Future integrations (RFID/NFC and other devices)

The prototype is **software-first**. It ships no device drivers, does not require any physical reader, and contains **no barrier, turnstile or door commands and no automatic admission**. Hardware compatibility must not be claimed until a specific, approved device has been integrated and tested.

## What exists today

- `server/src/integrations/credentialReader.ts` defines the integration boundary (`CredentialReaderAdapter`, `CredentialRead`, `ReaderStatus`) and a single `MockReaderAdapter`.
- `GET /api/integrations/readers` lists one **simulated** mock reader per gate (`simulated: true`).
- In the gate interface, "Mock reader (tap card)" fills in a sample credential number and sends it with `method: "MOCK_READER"`. Manual entry sends `method: "CREDENTIAL"`.

## Design principle

A real device must feed the **same verification pipeline** the gate UI already uses. Every rule (credential state, personnel status, validity, location, presence), alert, audit record and manual-review path then applies unchanged. A reader is an *input device for the guard's workstation*, never an independent authority.

```
Card/tag ──► Reader ──► Adapter (normalize UID) ──► POST /api/gate/verify ──► result shown to guard
                                                                         └─► guard confirms ──► POST /api/gate/events
```

## Expected interface

### 1. Credential input

The credential carries only an **opaque identifier** (card/tag UID). Personal information stays in the protected database.

```ts
interface CredentialRead {
  readerId: string;          // configured reader identifier, bound to one gate
  credentialNumber: string;  // UID as reported by the device
  technology: 'RFID_125KHZ' | 'MIFARE_13_56MHZ' | 'NFC' | 'MANUAL';
  deviceReadAt?: string;     // informational; server time is authoritative
}
```

`adapter.normalize(raw)` converts the device payload (e.g. hex UID with separators) to the stored `credential_number` format.

### 2. Verification request

```http
POST /api/gate/verify
Content-Type: application/json
X-SG-Request: 1
Cookie: sg_session=…   (the signed-in guard's session)

{ "gateId": 3, "mode": "PERSONNEL", "input": "RF-8F3A21C4", "method": "MOCK_READER" }
```

A hardware adapter would use a new method value (e.g. `"READER"`) and a reader-to-gate binding verified server-side.

### 3. Verification response

```json
{
  "attemptId": 10412,
  "result": "VERIFIED",                  // or INVALID_CREDENTIAL, BLOCKED_CREDENTIAL, EXPIRED_CREDENTIAL, WRONG_LOCATION, …
  "label": "Verified",
  "message": "Credential and personnel record are valid for this location.",
  "subject": { "type": "PERSONNEL", "id": 52, "name": "Nk Aarav Bhat", "reference": "TCP-H-10068", "lines": [ … ] },
  "presence": { "state": "OUTSIDE", "since": "…", "locationName": "…" },
  "allowedActions": ["ENTRY"],
  "manualReviewEligible": false,
  "expiresAt": "2026-10-24T06:05:00.000Z",
  "simulated": true
}
```

### 4. Event recording

Recording remains a separate, operator-confirmed step:

```http
POST /api/gate/events
{ "attemptId": 10412, "eventType": "ENTRY", "idempotencyKey": "ik-…" }
```

### 5. Error handling

| Situation | Behaviour |
|---|---|
| Unknown / blocked / lost / expired credential | `200` with the failure `result`; alert raised per configured rules; no movement possible |
| Repeated failures | `REPEATED_FAILED_VERIFICATION` alert after the configured threshold |
| Reader floods requests | `429` from the per-operator gate rate limit |
| Verification older than the TTL | `422 VERIFICATION_EXPIRED` on record |
| Device offline | Adapter reports `online: false`; guards fall back to manual entry (method `CREDENTIAL`), which is recorded as such |

### 6. Device status (where supported)

```ts
interface ReaderStatus {
  readerId: string; gateId: number; label: string; technology: ReaderTechnology;
  simulated: boolean; online: boolean; lastSeenAt: string | null; note: string;
}
```

## Integration checklist for an approved device

1. Obtain written approval for the device model, firmware and network placement.
2. Implement an adapter that only reads UIDs (no write-back, no relay control).
3. Authenticate the reader (mutual TLS or a signed device key) and bind it to a gate on the server.
4. Add a `READER` verification method and record the reader id on `verification_attempts`.
5. Test against the full automated suite plus device-specific tests (tamper, replay, offline, latency).
6. Document results before claiming compatibility.

Out of scope until separately approved: biometrics, automatic number-plate recognition, physical barrier commands, automatic admission, and any connection to live personnel or operational systems.
