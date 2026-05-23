# Discovered retailer endpoints + auth notes

> Ground truth for the scan/enrichment code. Confirmed from logged-in DevTools
> HAR captures (2026-05-22). Personal data (names, addresses, email, card,
> membership number, exact ZIP) has been kept out of this file deliberately.

---

## Target

Order history is served by Target's **Redsky** aggregation layer. NOTE: the
order-history call goes to **`api.target.com`**, not `redsky.target.com` as the
original spec assumed. The manifest must grant `https://api.target.com/*`.

### Auth

- Header **`x-api-key`** = `ff457966e64d5e877fdbad070f276d18ecec4a01`
  (long-lived **public** frontend key, sent on every Redsky call).
  A second public key `5622b71f...` is used by other surfaces; order_history
  uses the `ff457966...` one.
- Plus the logged-in **session cookies** (`credentials: 'include'`).
- No `Authorization`/bearer token. No per-user secret to store.

### Order history

```
GET https://api.target.com/guest_order_aggregations/v1/order_history
  ?page_number=1
  &page_size=10
  &order_purchase_type=ONLINE
  &pending_order=true
  &shipt_status=true
```

Pagination: `page_number` (1-based) + `page_size`. Response includes
`total_pages` and `total_orders`, so iterate `page_number` until
`page_number > total_pages` (or stop early at `latest_order_id_seen`).

**Response envelope:**

```jsonc
{
  "metadata": { ... },
  "guest_id": "<string>",
  "total_orders": 42,
  "total_pages": 5,
  "orders": [ /* see below */ ],
  "request": { ... }
}
```

**Per-order shape** (real field names — differs from the simplified spec):

```jsonc
{
  "order_number": "<string>",          // -> order_id
  "placed_date": "<ISO8601>",          // -> ordered_at
  "order_type": "Sales",
  "order_purchase_type": "ONLINE",
  "summary": { "grand_total": "58.78" }, // -> total (string). NO subtotal/tax/shipping
  "address": [ { ... } ],
  "order_lines": [ /* see below */ ],
  "is_more_lines": false,
  "has_adult_beverage_items": false
  // ...several boolean status flags
}
```

`summary` only exposes `grand_total` — **subtotal / tax / shipping stay
`null`** for Target.

**Per-line shape** (`order_lines[]`):

```jsonc
{
  "order_line_id": "<string>",
  "order_line_key": "<string>",
  "original_quantity": 1,              // -> quantity
  "item": {
    "tcin": "89152875",                // -> sku
    "description": "<string>",         // -> name
    "images": { ... }
    // NO price, NO category here
  },
  "fulfillment_spec": {
    "fulfillment_type": "ShipToHome",  // -> fulfillment_type (per-line; use line[0] for order-level)
    "fulfillment_method": "SCHEDULED_DELIVERY",
    "status": { "code": "...", "key": "...", "date": "...", "quantity": 1, "fulfilled_date": "..." }
  }
}
```

So `order_history` gives **TCIN + description** but **no per-line price or
category** — enrichment call still required for those.

### Product enrichment

```
GET https://redsky.target.com/redsky_aggregations/v1/web/product_summary_with_fulfillment_v1
  ?key=<public_api_key>
  &tcins=<comma_sep_list_up_to_28>
  &store_id=<id>
  &zip=<zip>
```

- `tcins`: comma-separated, **up to 28** per call.
- Cache by TCIN in `product_cache` so items aren't re-enriched across scans.
- **NOT captured in this HAR session** — the response shape (where
  `category_native` / price live) is still unconfirmed. Capture it during step
  5 by loading a product page or order detail while watching Network. Use the
  `ff457966...` key.

#### Runtime values

| Field      | Value                                      | Notes                                  |
| ---------- | ------------------------------------------ | -------------------------------------- |
| `key`      | `ff457966e64d5e877fdbad070f276d18ecec4a01` | public frontend key (safe to commit)   |
| `store_id` | see `config.local.json`                    | location-revealing — kept out of git   |
| `zip`      | see `config.local.json`                    | location-revealing — kept out of git   |

Location-revealing IDs (`store_id`, `scheduled_delivery_store_id`, `zip`) live
in the gitignored `config.local.json` (backed up to Google Drive), not here.

### Other Target endpoints seen (not used by v1)

- `api.target.com/guest_order_aggregations/v1/orders/search` — order search.

---

## Costco

Confirmed from HAR. GraphQL over POST `{ "query": "...", "variables": {...} }`
(no separate `operationName` field). Auth = same `costco.com` **session
cookies**; content scripts on `costco.com` can call `ecom-api.costco.com`
directly (same registrable domain).

Two endpoints:

- `https://ecom-api.costco.com/ebusiness/order/v1/orders/graphql`
- `https://ecom-api.costco.com/ebusiness/product/v1/products/graphql`

### Online order flow (v1 = these three ops)

#### 1. `getOnlineOrders` — paginated history (no prices)

Variables: `{ startDate, endDate, pageNumber, pageSize, warehouseNumber }`
e.g. `{ "startDate":"2026-3-01", "endDate":"2026-5-31", "pageNumber":1, "pageSize":10, "warehouseNumber":"<from config.local.json>" }`
(date format is `YYYY-M-DD`, single-digit month seen).

**Response is an ARRAY-wrapped envelope** — note the `[0]`:

```jsonc
{ "data": { "getOnlineOrders": [ {
  "pageNumber": 1,
  "pageSize": 10,
  "totalNumberOfRecords": 0,
  "bcOrders": [ {
    "orderHeaderId": "...",
    "orderPlacedDate": "...",        // aliased from orderedDate -> ordered_at
    "orderNumber": "...",            // aliased from sourceOrderNumber -> order_id
    "orderTotal": ...,               // -> total
    "warehouseNumber": "...",
    "status": "...",
    "emailAddress": "...",           // PII
    "orderLineItems": [ {
      "itemId": "...",
      "itemNumber": "...",           // -> sku
      "itemDescription": "...",      // -> name
      "lineNumber": 1,
      "status": "...", "deliveryDate": "...", "shippingType": "..."
      // NO price/quantity-charged here -> needs getOrderDetails
    } ]
  } ]
} ] } }
```

Empty result confirms shape: `{"data":{"getOnlineOrders":[{"pageNumber":0,"pageSize":0,"totalNumberOfRecords":0,"bcOrders":[]}]}}`.

Pagination: `pageNumber` + `pageSize`, total via `totalNumberOfRecords`. Also
gated by a `startDate`/`endDate` window — incremental scans set `startDate`
near `latest_order_date_seen`.

#### 2. `getOrderDetails` — per-order pricing + totals

Variables: `{ orderNumbers: [String] }` (batch of order numbers).
Returns object keyed by `getOrderDetails`. Order-level money fields:

- `merchandiseTotal`   -> subtotal
- `uSTaxTotal1`        -> tax (foreignTaxTotal1..4 for non-US)
- `shippingAndHandling` (+ `retailDeliveryFee`, `grocerySurcharge`, `frozenSurchargeFee`) -> shipping
- `orderTotal`         -> total
- `discountAmount`, `nonMemberSurchargeAmount`

**Line items are nested under `orderShipTos[].orderLineItems[]`** (aliased
`shipToAddress`), NOT directly on the order:

```jsonc
"orderLineItems": [ {
  "itemNumber": "...",                       // -> sku
  "itemDescription": "...",                  // alias of sourceItemDescription -> name
  "price": ...,                              // alias of unitPrice -> unit_price
  "quantity": ...,                           // alias of orderedTotalQuantity -> quantity
  "merchandiseTotalAmount": ...,             // -> line_total
  "shippingChargeAmount": ...,
  "foreignTax1..4": ...,
  "itemTypeId": ..., "programType": "...", "carrierItemCategory": "..."
} ]
```

> **Heavy PII** in this response: `firstName/lastName`, `line1..3`, `city`,
> `state`, `postalCode`, `emailAddress`, `phoneNumber`, `membershipNumber`,
> `orderPayment.cardNumber`. The parser must extract only the order/line money
> + item fields and must NOT persist PII into IndexedDB or exports.

#### 3. `products` — enrichment by item number

Variables: `{ clientId, itemNumbers:[String], locale:[String], warehouseNumber }`.
Response: `data.products.catalogData[]` with `{ itemNumber, itemId (catEntryId),
description.shortDescription, fieldData.imageName, additionalFieldData.{fsa,chdIndicator} }`
and a parallel `data.products.fulfillmentData[]`.

> **Category gap:** the captured `products` query does **not** request any
> category/department field, so `category_native` is **unavailable** for Costco
> from these ops as-captured. Options for step 6: (a) extend the `products`
> query with a category field if the schema exposes one (confirm name first,
> don't guess), or (b) fall back to `itemTypeId` / `programType` /
> `carrierItemCategory` from the order line as a coarse category. Leave
> `category_native: null` until resolved.

### Out of scope for v1

`receiptsWithCounts` (same order graphql endpoint) is the **in-warehouse / gas**
receipts path. Variables seen: `{ documentType, documentSubType, startDate,
endDate, text }` and `{ barcode, documentType }`. Deferred to a later phase.

#### Runtime values

| Field             | Value                                  | Notes                                |
| ----------------- | -------------------------------------- | ------------------------------------ |
| `warehouseNumber` | see `config.local.json`                | location-revealing — kept out of git |
| `clientId`        | `4900eb1f-0c10-4bd9-99c3-c59e6c1ecebf` | public app id (safe to commit)       |
| `locale`          | `["en-US"]`                            | array of locale strings              |
