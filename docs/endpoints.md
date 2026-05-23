# Discovered retailer endpoints + auth notes

> Ground truth for the scan/enrichment code. Captured from logged-in
> DevTools sessions. Do not re-research what is already documented here.

---

## Target

Order history is served by Target's internal **Redsky** aggregation API.
Redsky is Target's unified aggregation layer over ~100 internal APIs, so the
`guest_` prefix is misleading — the endpoint is auth-gated and rides on the
logged-in session cookies.

### Order history

Endpoint (capture this one):

```
guest_order_aggregations/v1/order_history
```

Order response shape (per order):

```json
{
  "orderNumber": "912002895833290",
  "orderDate": "2025-10-14T14:26:16-05:00",
  "total": "58.78",
  "orderType": "Sales",
  "items": [
    {
      "tcin": "78099947",
      "description": "Unsalted Roasted Mixed Nuts...",
      "quantity": 1,
      "fulfillmentType": "ShipToHome",
      "fulfillmentMethod": "SCHEDULED_DELIVERY",
      "status": "STAT_SHOPPER_CLAIMED",
      "statusDate": "2025-10-14T14:31:48-05:00",
      "isReturnable": false,
      "isCancellable": false
    }
  ]
}
```

The order endpoint gives **TCIN** (Target's product ID) and **description**
per line, but **not** per-line price or category. Those require a second call.

### Product enrichment

```
https://redsky.target.com/redsky_aggregations/v1/web/product_summary_with_fulfillment_v1
  ?key=<api_key>
  &tcins=<comma_sep_list_up_to_28>
  &store_id=<id>
  &zip=<zip>
```

- `tcins`: comma-separated, **up to 28** per call.
- `key`: a long-lived public API key that target.com's own frontend uses.
  Treated as a **value provided at runtime, not hardcoded**. Paste the actual
  captured value below when grabbed from DevTools.
- Cache product details by TCIN in IndexedDB (`product_cache` store) so we do
  not re-enrich the same item across scans. Items rarely change category.

#### Runtime values (fill in from DevTools / HAR capture)

| Field      | Value     |
| ---------- | --------- |
| `key`      | _TBD_     |
| `store_id` | _TBD_     |
| `zip`      | _TBD_     |

> A HAR capture (`www.target.com.har`) exists on the Desktop and contains the
> live key, store_id, zip, and real request/response shapes. Extract these
> when wiring up step 5 (Target content script). Do **not** commit the HAR.

---

## Costco

**TBD — awaiting DevTools captures.**

Known so far:

GraphQL endpoints on `ecom-api.costco.com`:

- `https://ecom-api.costco.com/ebusiness/order/v1/orders/graphql` — order history
- `https://ecom-api.costco.com/ebusiness/product/v1/products/graphql` — product details

Auth is via the same session cookies as `costco.com`. Content scripts running
on `costco.com` can call `ecom-api.costco.com` directly (same registrable
domain).

**Still needed before writing the Costco parser (step 6):**

- [ ] GraphQL **operation name(s)** for order history
- [ ] Full **query string(s)**
- [ ] Sanitized **sample response(s)**
- [ ] Pagination mechanism (cursor / page number / offset)
- [ ] Per-line price + native category field paths

> A HAR capture (`www.costco.com.har`) exists on the Desktop and likely
> contains the GraphQL POSTs needed to fill the above. Do **not** write the
> Costco parser against guessed shapes — confirm from the capture first.

Note: Costco has three receipt types — **online orders**, **in-warehouse
purchases**, **gas station transactions**. v1 is **online only**; the other
two likely use different endpoints.
