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
| Target **in-store** (order_purchase_type=STORE + /store detail) | 🔶 built + parser-tested, **NOT browser-verified** |
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
- After any code change: reload the extension on `chrome://extensions`.

## Decision menu for next time
- **Verify Target in-store** in Chrome (the one built-but-unverified piece):
  scan Target, check `order_items_target_*.csv` for `order_channel=in_store`
  rows with prices + dpci category; watch the SW console for
  `[sre] detail enrichment failed` on `/store` IDs.
- **Costco department map** (`extension/export/costco-departments.js`) is now
  populated from a full warehouse export (depts 0,12–95). Extend it only if a
  new `Dept <n>` shows up in a future export; labels apply at export (no
  re-scan).
- **Gas / car-wash receipts:** the detail `documentType` (`gas`/`carwash`) is a
  guess (none in the capture); verify when you have fuel receipts.
- **Simplifi join** (downstream, DuckDB): swap `orders.total` for the Simplifi
  transaction amount in `docs/analysis.md` step 3.
- **Known data quirks** (not bugs): `line_total` is authoritative (not
  unit_price×qty for weighed items); online order totals can diverge from line
  sums (returns/promos — the allocation absorbs it).
- **Deferred:** offscreen-document download (to avoid the settings requirement);
  per-page resume cursor exists for full scans (ADR-010) but isn't stress-tested.

## Where things live
- Repo / remote: `~/personal-repo/store-receipt-extract` → https://github.com/chelseamlap/store-receipt-extract (`main`).
- Personal config + sanitized docs backup: Google Drive folder
  "store-receipt-extract (personal)" (on the cmlapeikis@gmail.com account).
- Raw HAR captures (PII; gitignored): `~/Desktop/www.target.com.har`,
  `~/Desktop/www.costco.com.har`.
