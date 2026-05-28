# Pickup from here

A running "where we are / what's next" note so you can cold-start. Last updated
**2026-05-24**.

## What this is
Chrome MV3 extension that pulls itemized Target + Costco order history (online +
in-person) on your logged-in session and exports CSV/JSON for downstream spend
analysis. Scanning runs entirely in the service worker (ADR-008). See
`README.md` for usage, `docs/endpoints.md` for the APIs, `docs/storage.md` for
schemas, `docs/decisions.md` for ADRs, `docs/analysis.md` for the DuckDB step.

## Status

| Area | State |
| --- | --- |
| Repo, IndexedDB, popup, export, throttle | ✅ done |
| Target online (order_history + post_orders detail, dpci category) | ✅ verified in Chrome |
| Costco online (getOnlineOrders + getOrderDetails) | ✅ verified |
| Costco in-warehouse / gas / car-wash (receiptsWithCounts) | ✅ verified (warehouse); gas/car-wash code paths unverified — none in test data |
| Target **in-store** (order_purchase_type=STORE + /store detail) | ✅ verified in Chrome |
| Export: order_channel, category_label (Costco dept map), is_adjustment | ✅ |
| Export: receipt_url (order-level deep-link for HSA/FSA submissions) | ✅ |
| Export: fsa_eligible (Costco online only — see below) | ⚠️ partial |
| Downstream DuckDB recipe | ✅ documented (`docs/analysis.md`), not run here |

Tests: `npm test` (39 passing, pure parsers/throttle/export only — scan
orchestration is not unit-tested).

## Setup gotchas (these cost real time before)
- **Load the extension from `~/Desktop/personal-repo/store-receipt-extract/extension`**
  (repo lives on the Desktop alongside `finance-pipeline` as of 2026-05-28).
  After any rename/move, double-check Chrome's "Load unpacked" path before
  debugging — pointing at a stale clone is a classic time sink here.
- **`config.local.json`** must be present in `extension/` (gitignored; backup in
  Google Drive). Holds Target store_id/zip + **Costco `warehouse_number`**
  (online Costco scan needs it). Public keys are built-in defaults.
- **Downloads:** turn OFF "Ask where to save each file" in
  `chrome://settings/downloads`, or exports stall (ADR-009).
- **Costco:** open your *Orders & Purchases* page before scanning so the
  short-lived session token is captured (ADR-009).
- **Family / shared accounts:** scoped per login. Scan once per person — log
  in, click Scan. The account label is **auto-detected from the live session**
  (Costco JWT given-name; Target order address first-name), populates
  `account_hint`, and appears in the export filename. No config edits per
  login. Optional `<retailer>.account_name` in `config.local.json` is a custom
  override. See README "Usage notes".
- After any code change: reload the extension on `chrome://extensions`.

## Scope
**This repo is export-only** — capture itemized Target + Costco data and emit
CSV/JSON. The Simplifi join, proportional allocation against authoritative
totals, and any reporting live in the **separate analysis repo**, which owns the
Simplifi data + merchant→retailer matching. Don't add that processing here.

## FSA eligibility — open work
`fsa_eligible` ships in the items CSV but is **only populated for Costco
online** (sourced from `isFSAEligible` on `getOnlineOrders`). Two follow-ups:
- **Costco in-warehouse** — the Orders & Purchases > **FSA Orders** page hits
  an endpoint that wasn't in the latest HAR. Capture a fresh
  `~/Desktop/www.costco.com.har` after visiting that page, then wire it up
  (likely a separate query that returns FSA-eligible receipts/items by date
  range).
- **Target** — the captured `post_orders` response has **no FSA field**; the
  receipt UI computes/fetches it elsewhere. Open Target's order detail in
  Chrome with DevTools Network open, look for a separate enrichment call (or
  a flag embedded in `additionalFieldData` / similar) and add it to the
  parser.

## Decision menu for next time
All scan paths (Target online + in-store, Costco online + in-warehouse) are now
verified end-to-end in Chrome. Remaining options:
- **Costco department map** (`extension/export/costco-departments.js`) is now
  populated from a full warehouse export (depts 0,12–95). Extend it only if a
  new `Dept <n>` shows up in a future export; labels apply at export (no
  re-scan).
- **Known data quirks** (not bugs): `line_total` is authoritative (not
  unit_price×qty for weighed items); online order totals can diverge from line
  sums (returns/promos — the downstream allocation absorbs it).
- **Deferred:** offscreen-document download (to avoid the settings requirement);
  per-page resume cursor exists for full scans (ADR-010) but isn't stress-tested.

Out of scope here (→ analysis repo): Simplifi join + category allocation.
Costco gas/car-wash reconciles cleanly via Simplifi, so no in-extension work
needed.

## Where things live
- Repo / remote: `~/Desktop/personal-repo/store-receipt-extract` → https://github.com/chelseamlap/store-receipt-extract (`main`).
- Personal config + sanitized docs backup: Google Drive folder
  "store-receipt-extract (personal)" (on the cmlapeikis@gmail.com account).
- Raw HAR captures (PII; gitignored): `~/Desktop/www.target.com.har`,
  `~/Desktop/www.costco.com.har`.
