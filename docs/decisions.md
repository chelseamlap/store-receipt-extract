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

## ADR-011 — In-person receipts + order_channel

**Date:** 2026-05-24
**Status:** Accepted (Costco in-warehouse/gas/car-wash done; Target in-store next)

Online-only data isn't useful when much spend is in person. Added an
`order_channel` field (`online` | `in_store` | `in_warehouse` | `gas` |
`carwash`) to every order record + the orders CSV, so in-person vs online spend
is separable downstream. `order_id` is the order_number / store_receipt_id /
transactionBarcode depending on channel.

**Costco in-warehouse/gas/car-wash** (`receiptsWithCounts`): list mode (date
window, `M/DD/YYYY` format, documentType `all`) → barcodes → barcode mode →
full receipt. The Costco scan now runs this after the online flow.
`itemDepartmentNumber` becomes `category_native` — the only category Costco
actually exposes (online has none). `membershipNumber` is stripped.
Incremental skips barcodes already stored (order-independent; no cursor), so it
stays correct without relying on result ordering. Detail `documentType` is
derived from the receipt type (`warehouse`/`gas`/`carwash`); gas/car-wash values
are unverified (none in the capture) and fail non-fatally.

## ADR-010 — Review hardening: PII strip + resumable full scans

**Date:** 2026-05-24
**Status:** Accepted

From a code review:

- **PII in `raw`:** parsers now strip identifying fields before persisting raw
  (Target `address`, Costco `emailAddress`) so the JSON export / IndexedDB don't
  retain name/ZIP/email. Detail-endpoint PII was already excluded.
- **Resumable full scans:** `scan_state` gains a `resume` cursor written after
  each page (Target) / window (Costco) of a *full* scan, so an interrupted run
  (e.g. MV3 worker termination on a multi-minute scan) resumes instead of
  restarting. `latest_order_id_seen` is set only on clean completion, so the
  incremental stop point always references the last *complete* scan — avoiding
  the trap where checkpointing the newest id mid-scan would make incremental
  permanently skip not-yet-stored older orders. Incremental scans are short and
  simply restart (no cursor).
- **CSV formula-injection guard** on free-text columns only (names, categories);
  numeric columns keep legitimate negatives. Removed unused `*Blob` export
  helpers and the unused `redsky.target.com` host permission.

## ADR-009 — Costco auth capture + export download mechanism

**Date:** 2026-05-24
**Status:** Accepted

**Costco auth:** the GraphQL API requires a short-lived session JWT
(`costco-x-authorization`) plus client headers, minted by costco.com's OAuth —
not hardcodable. A `webRequest` listener sniffs these headers from the page's
own requests to `ecom-api.costco.com` and caches them (storage.session); the
worker replays them. Costco also checks `Origin`/`Referer`, which a worker
`fetch()` can't set, so a `declarativeNetRequest` session rule stamps them on
requests to that host. Requirement: open the Costco orders page before scanning
so the token is captured.

**Downloads:** exports use a **blob URL** + `chrome.downloads.download` from the
popup (`saveAs:false`, `conflictAction:'uniquify'`, time-stamped filenames).
`data:` URLs were tried first but hang at `in_progress`. The real blocker was
Chrome's **"Ask where to save each file"** setting: with it on, the save prompt
is orphaned when the popup closes and the download stalls forever with no
filename. We require that setting off (documented in README) and surface a hint
if a download stalls. A fully setting-agnostic fix would move the download into
an **offscreen document** (persistent DOM context for blob creation) — deferred
as overkill for a monthly personal tool.

## ADR-008 — Scan runs in the service worker, not content scripts

**Date:** 2026-05-22
**Status:** Accepted (supersedes ADR-006)

In browser testing, fetching from the page/content-script context was blocked
(`Failed to fetch`, including for the extension's own packaged config file), and
content-script injection added a pile of timing/tab-selection failure modes.
Moving all network work into the **service worker** fixed it: with
`host_permissions` for the API hosts + `credentials: 'include'`, the worker's
fetches ride on the logged-in session cookies and bypass page CORS, and no tab
needs to be open. `background.js` now fetches order_history + order-detail
directly, parses via `common.js` (imported as a normal ES module — no
`web_accessible_resources` needed), and writes IndexedDB.

Consequences: deleted the `content/target.js` / `content/costco.js` content
scripts; dropped the `scripting`/`activeTab` permissions and
`web_accessible_resources`. `common.js` is now a shared library used by the
worker (still node-testable). The public Target key is a built-in default
(safe per endpoints.md); location IDs still come from the optional gitignored
`config.local.json`. ADR-006 (content-script dynamic import) no longer applies.

## ADR-007 — Target enrichment uses the order-detail endpoint, not product_summary

**Date:** 2026-05-22
**Status:** Accepted (supersedes the earlier product_summary plan)

The authoritative `docs/endpoints.md` shows per-line prices, full tax/fee
breakdown, and `dpci` all come from `GET api.target.com/post_orders/v1/
{order_number}`. So `target.js` fetches that detail per order and merges it:
detail is authoritative for `unit_price` / `line_total` / totals
(`subtotal`=`total_product_price`, `tax`=`total_taxes`,
`shipping`=`total_shipping_charges`), and `category_native` = the DPCI
department (first segment of e.g. `037-11-9248`). The full DPCI is kept on each
item; the money-only `summary` is kept as `order.raw_summary` for full-fidelity
export.

PII in the detail (`guest_profile`, `payments`, addresses) is **never read or
persisted** — `parseTargetOrderDetail` only touches `summary` + `packages`.
A failed detail fetch is non-fatal: the order is stored with order_history
fields (null prices). No separate product_cache call is needed since DPCI rides
along on the order detail.

## ADR-006 — Content scripts load shared code via dynamic import

**Date:** 2026-05-22
**Status:** Superseded by ADR-008 (scanning moved to the service worker; no
content scripts)

No build step means no bundler to inline shared parser/throttle code. MV3
content scripts can't use static `import` of other extension files, so the
retailer content scripts (steps 5/6) will pull in `content/common.js` and
`db.js` via `await import(chrome.runtime.getURL(...))`. Those files are listed
in `web_accessible_resources` for the retailer hosts so the dynamic import
resolves. Keeps `common.js` a real ES module that node tests can import
directly. The service worker and popup use normal static `import` (extension
pages allow it).

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
