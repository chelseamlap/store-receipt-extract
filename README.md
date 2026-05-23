# store-receipt-extract

A personal Chrome (Manifest V3) extension that pulls **itemized** order history
from **Target** and **Costco** using your already-logged-in browser session,
stores it locally in IndexedDB, and exports it to CSV / JSON.

## Why

Budget tools (e.g. Simplifi) categorize spending by *merchant*, which is
useless for mixed-category retailers — a $215 Target run might be 70% kids'
clothes / 30% household. This tool captures the line-item detail so the
breakdown can be analyzed downstream.

Allocating the authoritative transaction total across line items (line items
won't reconcile to the penny due to order-level tax/shipping/promos) happens
**downstream** (DuckDB / Sheets) and is out of scope here.

Amazon is already handled by [philipmulcahy/azad](https://github.com/philipmulcahy/azad).
This project is Target + Costco only.

## How it works

- Content scripts on the retailer's logged-in pages make authenticated XHRs
  that ride on session cookies (no credentials are ever stored).
- A service worker orchestrates scans and writes to IndexedDB.
- The popup offers per-retailer scan buttons, stats, and CSV/JSON export.
- Everything runs in the browser. Nothing leaves your machine. No server, no
  telemetry, no third-party JS in the shipped extension.

## Usage model

Manual, run once or twice a month: open popup → scan → wait → export → import
the file wherever you analyze. Scans are incremental by default (only fetch
orders newer than the latest stored); a separate "rescan all" does a full
refresh.

## Repo layout

```
extension/   MV3 extension source (vanilla ES modules, no build step)
docs/        endpoints, storage schema, design decisions
tests/       node-runnable tests + sanitized fixtures
```

## Development

```sh
npm install      # installs fake-indexeddb (dev-only, never bundled)
npm test         # runs node --test against tests/
```

## Privacy

Real-data captures (HAR files) and exports are **gitignored**. Only sanitized
fixtures live in the repo.

## Status

Early scaffold. Build order (see project spec):

1. ✅ Repo scaffold + docs
2. ✅ IndexedDB wrapper + tests
3. ✅ Extension skeleton (manifest, popup, service worker)
4. ✅ Export (CSV / JSON) + tests
5. ✅ Target content script — order_history fetch + parse + incremental, plus
   order-detail enrichment (per-line price, tax/fee totals, dpci category); tested
6. ⬜ Costco content script — GraphQL shapes captured (see endpoints.md); ready to build
