# Design decisions (ADR-style)

Short, dated notes capturing *why* a choice was made. Newest first.

---

## ADR-001 — No build step, vanilla ES modules

**Date:** 2026-05-22
**Status:** Accepted

Extension code is plain ES modules with no bundler/transpiler. Goal: read the
deployed source directly when something breaks. Trade-off: no TypeScript, no
npm packages in the shipped extension. `fake-indexeddb` is permitted as a
dev-only test dependency and is never imported by extension code.

## ADR-002 — Items denormalized inline on the order record

**Date:** 2026-05-22
**Status:** Accepted

Line items are stored inline on the `orders` record rather than in a separate
object store. A scan/export always works with whole orders, and wholesale
upsert (to capture status changes) is simpler when items live with the order.
CSV export flattens items into a second file at serialization time.

## ADR-003 — Proportional allocation is downstream, not here

**Date:** 2026-05-22
**Status:** Accepted

Line items will not reconcile to the penny against the order total (tax,
shipping, promos, loyalty discounts apply at the order level). This tool only
captures and exports raw line + order data. The join against Simplifi's
authoritative total and proportional allocation happens downstream (DuckDB /
Sheets), out of scope here.

## ADR-005 — Endpoint reality vs. original spec (from HAR mining)

**Date:** 2026-05-22
**Status:** Accepted

HAR captures confirmed several deviations from the original spec; see
`endpoints.md` for detail:

- **Target order_history is on `api.target.com`**, not `redsky.target.com`.
  Auth is the `x-api-key` public key header + session cookies (no bearer).
  Real fields are `order_number` / `placed_date` / `order_lines[].item`, and
  `summary` only carries `grand_total` (subtotal/tax/shipping stay null).
- **Target enrichment endpoint was not captured** — its response shape stays
  unconfirmed until step 5.
- **Costco needs two order calls**: `getOnlineOrders` (paginated history, no
  prices) then `getOrderDetails` (per-line `unitPrice` + order totals, nested
  under `orderShipTos[].orderLineItems[]`). `getOrderDetails` is PII-heavy
  (name/address/email/card/membership) — the parser must extract only money +
  item fields and never persist PII.
- **Costco has no category field** in the captured `products` query, so
  `category_native` is null for Costco until the schema field is confirmed or a
  coarse fallback (`itemTypeId`/`programType`) is adopted.
- `receiptsWithCounts` is the in-warehouse/gas path — out of scope for v1.

## ADR-004 — Incremental scans via `scan_state`

**Date:** 2026-05-22
**Status:** Accepted

Pagination stops when it reaches `latest_order_id_seen`. A separate
"rescan all" action ignores `scan_state` for a full refresh. Scan progress is
persisted so an MV3 service-worker sleep does not lose state.
