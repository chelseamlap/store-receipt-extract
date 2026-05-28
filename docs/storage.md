# Storage: IndexedDB schema + export file schemas

## IndexedDB

Database name: `order_history`, version `1`.

### Object store: `orders`

- **Key path:** `[retailer, order_id]` (compound)
- **Indexes:**
  - `by_retailer_date` on `[retailer, ordered_at]`
  - `by_date` on `ordered_at`

Record shape:

```js
{
  retailer: "target" | "costco",
  order_id: "912002895833290",            // order_number | store_receipt_id | transactionBarcode
  order_channel: "online",                // online | in_store | in_warehouse | gas | carwash
  account_hint: "chelsea@example.com",   // optional, for multi-account households
  ordered_at: "2025-10-14T14:26:16-05:00",
  total: 58.78,
  subtotal: null,                        // null when retailer doesn't expose
  tax: null,
  shipping: null,
  fulfillment_type: "ShipToHome",
  raw: { /* entire retailer response for this order */ },
  items: [                               // denormalized; items stored inline
    {
      line_index: 0,
      sku: "78099947",                   // TCIN for Target, item number for Costco
      name: "Unsalted Roasted Mixed Nuts...",
      quantity: 1,
      unit_price: null,
      line_total: null,
      category_native: "037",            // retailer's own category code (Target: DPCI department)
      dpci: "037-11-9248",               // Target only: full DPCI; null for Costco
      raw_item: { /* raw item subobject */ }
    }
  ],
  raw_summary: { /* Target only: PII-free money breakdown from order detail */ },
  first_seen_at: "2025-10-14T20:00:00Z", // wall-clock when first scanned
  last_updated_at: "2025-10-14T20:00:00Z"
}
```

For Target, `category_native` is the DPCI **department code** (first segment),
and `subtotal`/`tax`/`shipping`/per-line `unit_price` come from the order-detail
endpoint (see [endpoints.md](endpoints.md) and ADR-007). PII from that response
is never persisted.

**Upsert behavior:** re-scanning an already-stored order **replaces the record
wholesale** (raw, total, items). This handles status changes (e.g. shipped →
delivered). `first_seen_at` is preserved across upserts; `last_updated_at` is
refreshed on every write.

**PII in `raw`:** `raw` keeps the retailer's order payload for full-fidelity
JSON export, but identifying fields are stripped before storage — Target's
`address` (name + ZIP) and Costco's `emailAddress`. The order-detail responses'
PII (guest_profile, payments, membership, card) is never read; only the
money-only `raw_summary` is kept.

### Object store: `product_cache`

Target enrichment cache (may extend to Costco).

- **Key path:** `[retailer, sku]`

Record:

```js
{ retailer, sku, name, category_native, raw, cached_at }
```

### Object store: `scan_state`

- **Key path:** `retailer`

Record:

```js
{
  retailer, last_scan_at, latest_order_id_seen, latest_order_date_seen,
  // present only while a FULL scan is mid-flight (cleared on completion):
  resume: { mode: "full", newest, page }            // target
  resume: { mode: "full", newest, windowEndMs }     // costco
}
```

Used for incremental scans: stop pagination when we reach
`latest_order_id_seen`. `latest_order_id_seen` is updated only on **clean
completion** (it marks the last complete scan). A full scan additionally writes
a `resume` cursor after each page/window so an interrupted run continues instead
of restarting; it's dropped on completion.

---

## Export schemas

Exports are **per store** (one store at a time — no combined "both retailers"
option). Triggered from the popup and saved via `chrome.downloads` (blob URL) to
the default Downloads folder. Filenames include a timestamp so each export is a
unique file, and an account label segment auto-detected from the live session
(Costco JWT given-name; Target order address first-name), e.g.
`orders_costco_chelsea_<stamp>.csv` — keeps shared/family logins separate
without any per-scan configuration. Optionally overridable via
`<retailer>.account_name` in `config.local.json`. UTF-8. RFC 4180-compliant CSV:
comma-separated, fields containing commas / quotes / newlines are wrapped in
double quotes with embedded quotes doubled.

> Requires "Ask where to save each file before downloading" to be **off** in
> `chrome://settings/downloads` (see ADR-009).

### CSV (two files)

`orders_<retailer>_<YYYYMMDD-HHMMSS>.csv`:

```
retailer,order_channel,order_id,account_hint,ordered_at,total,subtotal,tax,shipping,fulfillment_type,item_count
```

`order_items_<retailer>_<YYYYMMDD-HHMMSS>.csv`:

```
retailer,order_channel,order_id,line_index,sku,name,quantity,unit_price,line_total,category_native,category_label,is_adjustment,adjustment_reason
```

`is_adjustment` / `adjustment_reason` flag non-product lines (derived at export
from the item name): `discount` (Costco warehouse instant-savings, named
`/<itemNumber>`, negative line_total), `deposit` (bottle deposits), `fee`
(e.g. delivery fee). Adjustments carry the same `category_native` as the line
they relate to, so they net correctly within a category; filter on
`is_adjustment` to separate products from savings/fees.

`category_label` is a human label for `category_native`: Costco POS department
codes are mapped via `extension/export/costco-departments.js` (best-effort,
user-extended — unknown codes show `Dept <n>`); Target's dpci department code
passes through unchanged. Labels are applied at export time, so editing the map
and re-exporting updates them without re-scanning.

### JSON (one file)

`order_history_<retailer>_<YYYYMMDD-HHMMSS>.json`:

```json
{
  "exported_at": "2025-10-15T19:00:00Z",
  "schema_version": 1,
  "orders": [ /* full order records including raw payloads */ ]
}
```

Full-fidelity export for downstream re-processing if fields are added later.
