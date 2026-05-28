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
| Downstream DuckDB recipe | ✅ documented (`docs/analysis.md`), not run here |

Tests: `npm test` (39 passing, pure parsers/throttle/export only — scan
orchestration is not unit-tested).

## Setup gotchas (these cost real time before)
- **Load the extension from `~/personal-repo/store-receipt-extract/extension`** —
  NOT the stale clone at `~/Desktop/personal-repo/...` (old code, no config).
- **`config.local.json`** must be present in `extension/` (gitignored; backup in
  Google Drive). Holds Target store_id/zip + **Costco `warehouse_number`**
  (online Costco scan needs it). Public keys are built-in defaults.
- **Downloads:** turn OFF "Ask where to save each file" in
  `chrome://settings/downloads`, or exports stall (ADR-009).
- **Costco:** open your *Orders & Purchases* page before scanning so the
  short-lived session token is captured (ADR-009).
- **Family / shared accounts:** Costco (and Target households) scope orders to
  each login. Scan once per person: set `<retailer>.account_name` in
  `config.local.json` (e.g. `"chelsea"`, `"spouse"`) before each scan — it
  populates `account_hint` and goes into the export filename so files don't
  mix. See README "Usage notes".
- After any code change: reload the extension on `chrome://extensions`.

## Scope
**This repo is export-only** — capture itemized Target + Costco data and emit
CSV/JSON. The Simplifi join, proportional allocation against authoritative
totals, and any reporting live in the **separate analysis repo**, which owns the
Simplifi data + merchant→retailer matching. Don't add that processing here.

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
- Repo / remote: `~/personal-repo/store-receipt-extract` → https://github.com/chelseamlap/store-receipt-extract (`main`).
- Personal config + sanitized docs backup: Google Drive folder
  "store-receipt-extract (personal)" (on the cmlapeikis@gmail.com account).
- Raw HAR captures (PII; gitignored): `~/Desktop/www.target.com.har`,
  `~/Desktop/www.costco.com.har`.
