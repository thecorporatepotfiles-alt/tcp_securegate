# Demonstration walkthrough (≈15–20 minutes)

All data is synthetic and every verification is simulated — say so at the start; the yellow banner says it on every screen. Start from a clean dataset (**System & Demo → Reset demo data**, or `npm run db:reset`). Times shown are in the establishment time zone (default IST).

Tip: use two browser windows — a desktop window for management roles and a narrow/tablet window (or a real tablet on the LAN) for the guard's gate interface.

## 1. Sign-in and roles (1 min)

Open the app. The sign-in page offers one-click **demonstration roles**. Point out that each role sees a different menu and that permissions and location limits are enforced by the server, not just hidden in the UI.

## 2. HQ overview (3 min) — `hq.admin`

1. **Dashboard** — every tile is computed from stored records. Click *Personnel inside* to open the filtered **Who Is Inside?** list; return and click *Visitors awaiting authorization* to open the filtered visitor list.
2. Change the date filter to *Last 7 days*: activity, location-wise and gate-wise charts update together. Use the *Table* toggle on a chart to show the accessible table view.
3. Switch the **location selector** (top bar) from *All authorized locations* to *Location Bravo* to show location-wise drill-down.
4. **Reports → Location-wise activity** → *Export CSV*.

## 3. Visitor request and approval (4 min)

1. Sign in as **`alpha.host`** → **Visitors → New visitor request**. Search an existing visitor or enter a new one, choose **Lt Col Arjun Nair** as approving officer, set today's date and a time window, optionally add a vehicle.
2. Note that the host cannot pick themselves as approver (segregation of duties).
3. Sign in as **`alpha.officer`** — the bell shows the approval request. Open **My Approvals**, review, **Approve**. A digital pass with a QR code is generated (the QR holds only an opaque signed token).
4. Back as `alpha.host`, open the visit → **Pass** → *Print pass*.

Variants to show: **Reject** (reason required, no pass), **Cancel** (pass revoked), and **Security verification step required** (pass only after a Location Administrator records the step).

## 4. Gate operations (5 min) — `alpha.guard`

1. The guard lands on the **gate interface** (Alpha Main Gate). Large tiles, minimal typing.
2. **Scan Visitor QR** → in *Simulated scanner* pick the visitor pass (or scan the printed/onscreen QR with the device camera over HTTPS) → **Verified** → **Record Entry** → confirmation with the event reference and server time. Emphasize: verification never records movement by itself.
3. Scan the same pass again → it now offers only **Record Exit**. Record it, then scan once more → **Already Used**.
4. **Verify Personnel** → *Mock reader* → *Blocked card* → **Blocked Credential — Do not admit**; no bypass button. Then *Card not authorized here* → **Wrong Location** → **Refer for manual review** with a note.
5. Sign in as **`alpha.admin`** → **Manual Reviews** → approve with a note. Back on the gate, *My manual reviews* → record the single approved movement (outcome *Recorded after review*).
6. **Register Vehicle** → enter `DM 99 ZZ 0001` (not registered) → quick-register → re-verify → *Manual Review Required*. Then an authorized vehicle → **Record Entry**, noting the message that occupants are recorded separately.
7. **Register Delivery** → register arrival (courier, recipient *Capt Neha Sharma*) → status *Awaiting authorization*.
8. **Visitor Arrival** → register a walk-in for *Lt Col Arjun Nair* → host is notified; entry is still not permitted until authorized.

## 5. Follow-through (3 min)

1. As **`alpha.host`**: **Deliveries** → open the new delivery → **Authorize** → later **Acknowledge receipt** (who and when are recorded; authorization is not proof of inspection).
2. As **`alpha.officer`**: **Waiting List** shows the walk-in under *Awaiting host acknowledgement* → open → **Acknowledge arrival** → **Approve**.
3. As **`alpha.admin`**: **Alerts** → open the blocked-credential alert → **Acknowledge** → **Resolve** with a note. **Admin Exceptions** → create and resolve one. **Shift Handover** → record a handover.
4. **Gate Register** → open an event → **Void event** with a reason: the original stays visible (struck through) and the correction is audited; *Who Is Inside?* updates.

## 6. Governance (2 min)

1. **`auditor`** → **Audit Trail** → filter by action → **Verify integrity** (hash chain intact). Try any change — it is refused.
2. **`admin`** → **Roles & Permissions** (permission matrix), **Workflow Settings** (visitor/delivery transition rules, alert rules, thresholds), **Locations & Gates**, **System & Demo** (run time-based checks, simulated reader status, reset).
3. Show **location isolation**: as `bravo.admin` the Alpha records do not appear, and opening an Alpha record URL returns *not found*.

## Talking points

- Software-first: no hardware required; a documented integration boundary exists for future approved readers.
- Every movement is an append-only event; status is derived, never edited; corrections are auditable.
- Supports the establishment's existing procedures — it does not automate admission or replace guards' judgement.
- Not security-certified or approved for operational use; deployment requires the establishment's approval.
