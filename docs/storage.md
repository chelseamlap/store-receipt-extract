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
  order_id: "912002895833290",
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
{ retailer, last_scan_at, latest_order_id_seen, latest_order_date_seen }
```

Used for incremental scans: stop pagination when we reach
`latest_order_id_seen`.

---

## Export schemas

Both formats are triggered from the popup and saved via `chrome.downloads` to
the default Downloads folder. UTF-8. RFC 4180-compliant CSV: comma-separated,
fields containing commas / quotes / newlines are wrapped in double quotes with
embedded quotes doubled.

### CSV (two files)

`orders_<retailer>_<YYYYMMDD>.csv`:

```
retailer,order_id,account_hint,ordered_at,total,subtotal,tax,shipping,fulfillment_type,item_count
```

`order_items_<retailer>_<YYYYMMDD>.csv`:

```
retailer,order_id,line_index,sku,name,quantity,unit_price,line_total,category_native
```

Both retailers go into one pair of files unless a retailer filter is selected
in the popup; in that case only that retailer's rows are exported.

### JSON (one file)

`order_history_full_<YYYYMMDD>.json`:

```json
{
  "exported_at": "2025-10-15T19:00:00Z",
  "schema_version": 1,
  "orders": [ /* full order records including raw payloads */ ]
}
```

Full-fidelity export for downstream re-processing if fields are added later.
