# Retailer API Endpoints

Reference documentation for the internal APIs used by target.com and costco.com,
captured from authenticated DevTools HAR sessions. All sample payloads have been
sanitized — real responses contain PII (name, address, phone, email, card last
four, membership number, order IDs).

**Do not commit raw HAR files or unsanitized responses.** Add `*.har`,
`scratch/`, and `*.raw.json` to `.gitignore`.

---

## Target

### Hosts and auth

- `https://api.target.com` — primary order/receipt API
- `https://redsky.target.com` — Redsky aggregation layer (product enrichment, recommendations)
- `https://sapphire-api.target.com` — server-rendered page data; mirrors api.target.com responses but adds page-level context. **Skip this for our purposes** — go straight to `api.target.com`.

Auth is via session cookies on `target.com`. A content script running on
`target.com/orders/*` can call `api.target.com/*` and `redsky.target.com/*`
directly with `credentials: 'include'`. No bearer token, no API key in headers.

A public `key` query param appears on redsky and `cdui-orchestrations`
URLs — it's a long-lived integration key that target.com's own frontend uses,
not a credential. Captured value from this session:

```
ff457966e64d5e877fdbad070f276d18ecec4a01
```

It's safe to commit since it's in every target.com page request, but prefer
extracting it at runtime from a live page's network calls — keys can rotate.

### Order ID formats

- **Online orders**: 15-digit numeric string, e.g. `912003436491306`
- **In-store orders** (called `store_receipt_id`): four 4-digit segments
  hyphenated, e.g. `6136-1776-0171-6535` (last segment may be 4 digits or a
  longer form like `6535`). The middle segments encode store number.

### List endpoints

Target separates online and in-store order lists by `order_purchase_type`.
You need to call both to get a complete history.

#### Online orders

```
GET https://api.target.com/guest_order_aggregations/v1/order_history
    ?page_number=1
    &page_size=10
    &order_purchase_type=ONLINE
    &pending_order=true
    &shipt_status=true
```

Sanitized response shape:

```json
{
  "metadata": { "total_time": 105, "guest_type": "R" },
  "guest_id": "<numeric>",
  "total_orders": 98,
  "total_pages": 10,
  "orders": [
    {
      "tenant_key": "Target.com",
      "placed_date": "2026-05-16T00:24:06-05:00",
      "order_type": "Sales",
      "source": "OMS",
      "summary": { "grand_total": "62.76" },
      "address": [
        {
          "address_id": "<uuid>",
          "first_name": "<nickname>",
          "state": "CO",
          "zip_code": "<zip>"
        }
      ],
      "order_lines": [
        {
          "order_line_key": "<long_id>",
          "original_quantity": 1,
          "grouping": {
            "key": "STOREPICKUP_STOREPICKUP_1776_STAT_ORDER_PICKED_UP",
            "name": "ORDER_PICKED_UP"
          },
          "item": {
            "tcin": "89152875",
            "description": "Eucerin Age Defense Face Sunscreen ...",
            "images": { "...": "..." }
          },
          "fulfillment_spec": {
            "fulfillment_type": "StorePickup",
            "fulfillment_method": "Store Pickup",
            "node_id": "1776",
            "status": { "key": "STAT_ORDER_PICKED_UP", "date": "..." }
          }
        }
      ],
      "order_number": "<15_digit>",
      "order_purchase_type": "ONLINE"
    }
  ]
}
```

**Critical:** the list endpoint includes the items array with TCIN and
description, but **does not include per-item prices or per-order tax/fees**.
For price detail you must call the order-detail endpoint.

#### In-store orders

```
GET https://api.target.com/guest_order_aggregations/v1/order_history
    ?page_number=1
    &page_size=10
    &order_purchase_type=STORE
    &pending_order=true
    &shipt_status=true
```

Same shape as online except the order object has `store_receipt_id` instead of
`order_number`, `order_type: "STORES"`, and the address records have
`type: "STORE"` with a `store_id`. Example trimmed entry:

```json
{
  "placed_date": "2026-05-16T15:18:06-05:00",
  "order_type": "STORES",
  "summary": { "grand_total": "32.40" },
  "address": [
    {
      "first_name": "<store_label>",
      "address_line1": "9390 W Cross Dr",
      "city": "Littleton",
      "state": "CO",
      "type": "STORE",
      "store_id": "1776"
    }
  ],
  "order_lines": [
    {
      "line_number": 1,
      "original_quantity": 1,
      "item": {
        "tcin": "94886701",
        "description": "Women's Neida Sandals - Shade & Shore Black 9"
      }
    }
  ],
  "store_receipt_id": "6136-1776-0171-6535",
  "store_id": "1776",
  "order_purchase_type": "STORE"
}
```

The in-store list **also lacks per-line prices**. Detail endpoint required.

### Active orders search (probably skip)

```
GET https://api.target.com/guest_order_aggregations/v1/orders/search
    ?page_number=1&page_size=10&active_order=true&order_purchase_type=ONLINE
```

Returns only currently-active orders (in-flight pickups, in-flight ships).
Not needed for historical extraction.

### Order detail — online

```
GET https://api.target.com/post_orders/v1/{order_number}
```

This is where the money lives. Returns the full order including per-line
prices, adjustments, taxes, regional fees, and fulfillment status. Sanitized
shape, abridged to the fields you actually want:

```json
{
  "order_number": "<15_digit>",
  "order_key": "<longer_internal_key>",
  "order_date": "2026-05-16T05:24:06.000Z",
  "order_type": "Sales",
  "order_sub_type": "Regular",
  "guest_profile": {
    "guest_id": "<numeric>",
    "first_name": "<first>",
    "last_name": "<last>",
    "email_id": "<email>"
  },
  "payments": [
    {
      "amount": 62.76,
      "card_number": "<last4>",
      "payment_type": "VISA",
      "guest_display_payment_type": "Visa"
    }
  ],
  "summary": {
    "total_items": 4,
    "grand_total": 62.76,
    "total_adjustments": 3.20,
    "total_giftwrap_charges": 0.0,
    "total_product_price": 61.76,
    "total_shipping_adjustments": 0.0,
    "total_shipping_charges": 0.0,
    "total_taxes": 4.10,
    "total_regional_fees": 0.10,
    "adjustments": [
      {
        "promo_id": "403307995",
        "promo_description": "Buy 1, get 1 25% off select sunscreen & skin care",
        "promo_value": 3.20,
        "short_description": "Buy1Get1 25%off"
      }
    ],
    "regional_fees": [
      { "type": "BAG_FEE", "name": "Bag Fee", "value": 0.10 }
    ],
    "fulfillment_charges": [
      { "type": "STORE_PICKUP", "name": "Pickup", "value": 0.0 }
    ],
    "taxes": [
      { "type": "Price", "name": "SALES TAX", "value": 4.10 }
    ]
  },
  "packages": [
    {
      "fulfillment": {
        "fulfillment_type": "StorePickup",
        "fulfillment_method": "Store Pickup",
        "status": { "key": "STAT_ORDER_PICKED_UP", "date": "..." }
      },
      "order_lines": [
        {
          "order_line_id": "<uuid>",
          "original_quantity": 1.0,
          "quantity": 1.0,
          "line_number": 4,
          "item": {
            "tcin": "83695782",
            "dpci": "037-11-9248",
            "upc": "072140032227",
            "description": "Eucerin Age Defense Face Sunscreen Lotion - SPF 50 - 2.5 fl oz",
            "original_unit_price": 15.99,
            "unit_price": 15.99,
            "list_price": 15.99
          }
        }
      ]
    }
  ]
}
```

**Note:** `dpci` (Department/Class/Item) is Target's internal merchandising
taxonomy and is a useful category signal — first 3 digits are the department
(e.g. `037` is health/beauty). Capture this, don't throw it away.

### Order detail — in-store

```
GET https://api.target.com/post_orders/v1/orders/{store_receipt_id}/store
```

Same general structure as online detail, but the response is keyed off the
hyphenated receipt ID. Sample variables haven't been captured at the per-line
price level — verify in DevTools whether store-purchase line items include
`unit_price` (they should — Target's in-store POS records prices).

### Invoices (online orders only)

Target generates an invoice per shipment. For most ship-to-home orders this
matches the receipt; for multi-package orders you'll have several invoices.

```
GET https://api.target.com/post_order_invoices/v1/orders/{order_number}/invoices
GET https://api.target.com/post_order_invoices/v1/orders/{order_number}/invoices/{invoice_id}
POST https://api.target.com/receipts/v1/invoice         # returns a PDF blob
```

Invoice IDs are 17-digit numeric strings, e.g. `61363991206127741`. The PDF
endpoint is **not necessary** for this project — the structured JSON detail
endpoints have everything you need.

### Pagination

Standard `page_number` (1-indexed) + `page_size` (10 in observed calls,
probably bumpable to 25 or 50). Stop when `orders` is empty or when you
encounter a known-already-stored order ID (for incremental scans). The
response includes `total_orders` and `total_pages` if you want to short-circuit.

---

## Costco

### Hosts and auth

- `https://ecom-api.costco.com` — GraphQL endpoints for orders, products, and
  receipts (this is where everything you care about lives)
- `https://gdx-api.costco.com` — REST product summary endpoint, used by
  costco.com for fast catalog lookups. Useful as an alternative to the
  GraphQL `products` operation, but not required.

Auth is via session cookies on `costco.com`. Content scripts running on
`www.costco.com/*` can call `ecom-api.costco.com` directly with
`credentials: 'include'` (same registrable domain).

The `clientId` GraphQL variable observed in this session:

```
4900eb1f-0c10-4bd9-99c3-c59e6c1ecebf
```

This is a long-lived public client identifier that costco.com's frontend
sends. Treat the same as Target's `key` param — safe to commit, prefer
extracting at runtime.

`warehouseNumber` is the user's home warehouse. In this session it was
`847` (Littleton, CO). It will vary per user and per session if the user
changes home warehouse. Either capture from a live request or read from
the user's profile request.

### All Costco order/receipt endpoints share one URL

```
POST https://ecom-api.costco.com/ebusiness/order/v1/orders/graphql
```

The operation discriminates between online orders, online order details, and
in-warehouse/gas receipts. Headers all include `Content-Type:
application/json` and the standard CORS/cookies set by the browser.

A separate URL exists for product catalog enrichment:

```
POST https://ecom-api.costco.com/ebusiness/product/v1/products/graphql
```

### Operation: `getOnlineOrders` — list online orders

```graphql
query getOnlineOrders(
  $startDate: String!
  $endDate: String!
  $pageNumber: Int
  $pageSize: Int
  $warehouseNumber: String!
) {
  getOnlineOrders(
    startDate: $startDate
    endDate: $endDate
    pageNumber: $pageNumber
    pageSize: $pageSize
    warehouseNumber: $warehouseNumber
  ) {
    pageNumber
    pageSize
    totalNumberOfRecords
    bcOrders {
      orderHeaderId
      orderPlacedDate: orderedDate
      orderNumber: sourceOrderNumber
      orderTotal
      warehouseNumber
      status
      emailAddress
      orderCancelAllowed
      orderPaymentFailed: orderPaymentEditAllowed
      orderReturnAllowed
      orderLineItems {
        orderLineItemCancelAllowed
        orderLineItemId
        orderReturnAllowed
        itemId
        itemNumber
        itemTypeId
        lineNumber
        itemDescription
        deliveryDate
        warehouseNumber
        status
        orderStatus
        parentOrderLineItemId
        isFSAEligible
        shippingType
        shippingTimeFrame
        isShipToWarehouse
        carrierItemCategory
        scheduledDeliveryDate
        scheduledDeliveryDateEnd
        shipment {
          shipmentId
          trackingNumber
          trackingSiteUrl
          carrierName
          estimatedArrivalDate
          deliveredDate
          status
        }
      }
    }
  }
}
```

Variables:
```json
{
  "pageNumber": 1,
  "pageSize": 10,
  "startDate": "2026-3-01",
  "endDate": "2026-5-31",
  "warehouseNumber": "847"
}
```

**Date format gotcha:** `getOnlineOrders` uses `YYYY-M-DD` with **no
zero-padding on the month** (`2026-3-01`, not `2026-03-01`). Match exactly
what the live site sends; the server may or may not be strict about this.

**Note:** this list endpoint includes line items with descriptions, but **no
prices**. For price/tax detail you must call `getOrderDetails`.

### Operation: `getOrderDetails` — online order detail with prices

```graphql
query getOrderDetails($orderNumbers: [String]) {
  getOrderDetails(orderNumbers: $orderNumbers) {
    warehouseNumber
    orderNumber: sourceOrderNumber
    orderPlacedDate: orderedDate
    status
    merchandiseTotal
    retailDeliveryFee
    shippingAndHandling
    grocerySurcharge
    frozenSurchargeFee
    uSTaxTotal1
    orderTotal
    discountAmount
    nonMemberSurchargeAmount
    membershipNumber
    orderPayment {
      paymentType
      totalCharged
      cardNumber
      isGOMPayment
    }
    shipToAddress: orderShipTos {
      orderLineItems {
        orderStatus
        orderNumber
        orderedDate
        itemNumber
        itemDescription: sourceItemDescription
        price: unitPrice
        quantity: orderedTotalQuantity
        merchandiseTotalAmount
        lineItemId
        lineNumber
        itemId
        programType
        orderedShipMethodDescription
        shippingChargeAmount
        returnStatus
        itemWeight
        isPerishable
        itemStatus {
          orderPlaced { quantity transactionDate }
          shipped { quantity transactionDate }
          delivered { quantity transactionDate }
          cancelled { quantity transactionDate }
          returned { quantity transactionDate }
        }
        shipment {
          trackingNumber
          carrierName
          shippedDate
          deliveredDate
        }
      }
    }
  }
}
```

Variables: `{ "orderNumbers": ["1224652813"] }` — can batch multiple.

Sanitized response shape (trimmed):

```json
{
  "data": {
    "getOrderDetails": {
      "warehouseNumber": 847,
      "orderNumber": "<10_digit>",
      "orderPlacedDate": "2025-09-16T20:40:24.903",
      "status": "Delivered",
      "merchandiseTotal": 44.97,
      "retailDeliveryFee": 0.28,
      "shippingAndHandling": 0.00,
      "grocerySurcharge": 3.00,
      "frozenSurchargeFee": 0,
      "uSTaxTotal1": 0.96,
      "orderTotal": 43.21,
      "discountAmount": 6.00,
      "membershipNumber": "<12_digit>",
      "orderPayment": [
        {
          "paymentType": "Visa",
          "totalCharged": 43.21,
          "cardNumber": "<last4>"
        }
      ],
      "shipToAddress": [
        {
          "orderLineItems": [
            {
              "orderStatus": "Backordered",
              "itemNumber": "2571",
              "itemDescription": "Tootsie Pops, Fun Flavor Assortment, 0.6 oz, 100-count",
              "price": 15.99,
              "quantity": 1,
              "merchandiseTotalAmount": 15.99,
              "lineNumber": 2,
              "programType": "2DayDelivery",
              "shippingChargeAmount": 0.00
            }
          ]
        }
      ]
    }
  }
}
```

**Reconciliation note:** `merchandiseTotal + retailDeliveryFee + shippingAndHandling + grocerySurcharge + uSTaxTotal1 - discountAmount = orderTotal`. Costco actually exposes the full bridge — much better than Target — so for Costco online orders you can attribute fees/tax/discount back to line items more cleanly if you want to.

### Operation: `products` — catalog enrichment

```graphql
query products(
  $clientId: String!
  $itemNumbers: [String]
  $locale: [String]
  $warehouseNumber: String!
) {
  products(
    clientId: $clientId
    itemNumbers: $itemNumbers
    locale: $locale
    warehouseNumber: $warehouseNumber
  ) {
    catalogData {
      itemNumber
      catEntryId: itemId
      published
      fieldData { imageName }
      description { shortDescription }
      additionalFieldData { fsa chdIndicator }
      parentData { fieldData { imageName } }
    }
  }
}
```

Variables:
```json
{
  "itemNumbers": ["311676", "2571", "1706336"],
  "clientId": "4900eb1f-0c10-4bd9-99c3-c59e6c1ecebf",
  "locale": ["en-US"],
  "warehouseNumber": "847",
  "channel": "site"
}
```

Returns `shortDescription` and image URLs. **Does not return category** —
Costco's online category taxonomy isn't exposed through this operation. For
category mix on online orders you'd need to either (a) layer your own
keyword/LLM categorizer over descriptions, or (b) skip online and rely on
the in-warehouse receipts (next section) which DO include department codes.

### Operation: `receiptsWithCounts` (list mode) — in-warehouse + gas receipts

```graphql
query receiptsWithCounts(
  $startDate: String!
  $endDate: String!
  $documentType: String!
  $documentSubType: String!
) {
  receiptsWithCounts(
    startDate: $startDate
    endDate: $endDate
    documentType: $documentType
    documentSubType: $documentSubType
  ) {
    inWarehouse
    gasStation
    carWash
    gasAndCarWash
    receipts {
      warehouseName
      receiptType
      documentType
      transactionDateTime
      transactionBarcode
      transactionType
      total
      totalItemCount
      itemArray { itemNumber }
      tenderArray {
        tenderTypeCode
        tenderDescription
        amountTender
      }
      couponArray { upcnumberCoupon }
    }
  }
}
```

Variables (list mode):
```json
{
  "startDate": "3/01/2026",
  "endDate": "5/31/2026",
  "documentType": "all",
  "documentSubType": "all"
}
```

**Date format gotcha #2:** `receiptsWithCounts` uses `M/DD/YYYY` (not the
`YYYY-M-DD` that `getOnlineOrders` uses). They're inconsistent. Match
exactly what the live site sends.

`documentType` values seen: `"all"`, `"warehouse"`. Likely also `"gas"` and
`"carwash"` per the response field names. `documentSubType` defaults to `"all"`.

The list response gives you barcodes; for line items you need the detail mode.

### Operation: `receiptsWithCounts` (barcode mode) — single receipt detail

Same operation, different variables:

```graphql
query receiptsWithCounts($barcode: String!, $documentType: String!) {
  receiptsWithCounts(barcode: $barcode, documentType: $documentType) {
    receipts {
      warehouseName
      receiptType
      documentType
      transactionDateTime
      transactionDate
      companyNumber
      warehouseNumber
      operatorNumber
      warehouseShortName
      registerNumber
      transactionNumber
      transactionType
      transactionBarcode
      total
      warehouseAddress1
      warehouseCity
      warehouseState
      warehouseCountry
      warehousePostalCode
      totalItemCount
      subTotal
      taxes
      invoiceNumber
      itemArray {
        itemNumber
        itemDescription01
        itemDescription02
        itemDepartmentNumber
        unit
        amount
        taxFlag
        transDepartmentNumber
        fuelUnitQuantity
        fuelGradeCode
        itemUnitPriceAmount
        fuelGradeDescription
      }
      tenderArray {
        tenderTypeCode
        tenderDescription
        amountTender
        displayAccountNumber
      }
      instantSavings
      membershipNumber
    }
  }
}
```

Variables:
```json
{
  "barcode": "21044309200882605061741",
  "documentType": "warehouse"
}
```

Sanitized sample response (single in-warehouse receipt):

```json
{
  "data": {
    "receiptsWithCounts": {
      "receipts": [
        {
          "warehouseName": "SW DENVER",
          "warehouseShortName": "SW DENVER",
          "receiptType": "In-Warehouse",
          "documentType": "WarehouseReceiptDetail",
          "transactionDateTime": "2026-05-06T17:41:00",
          "transactionDate": "2026-05-06",
          "warehouseNumber": 443,
          "registerNumber": 92,
          "transactionNumber": 88,
          "transactionType": "Sales",
          "transactionBarcode": "21044309200882605061741",
          "total": 26.78,
          "totalItemCount": 2,
          "subTotal": 26.78,
          "taxes": 0,
          "instantSavings": 0,
          "warehouseAddress1": "7900 W QUINCY AVE",
          "warehouseCity": "LITTLETON",
          "warehouseState": "CO",
          "itemArray": [
            {
              "itemNumber": "929092",
              "itemDescription01": "VET. RX",
              "itemDepartmentNumber": 92,
              "transDepartmentNumber": 92,
              "unit": 2,
              "amount": 26.78,
              "taxFlag": "N",
              "itemUnitPriceAmount": 1
            }
          ],
          "tenderArray": [
            {
              "tenderTypeCode": "061",
              "tenderDescription": "VISA",
              "amountTender": 26.78,
              "displayAccountNumber": "<last4>"
            }
          ],
          "membershipNumber": "<12_digit>"
        }
      ]
    }
  }
}
```

**Huge win for category-mix analysis:** in-warehouse receipts include
`itemDepartmentNumber` per line. That's Costco's POS department code —
e.g. `92 = pharmacy`, `1 = sundries`, `14 = candy`, etc. (You'll need to
build a department-code → category map from observation; Costco doesn't
publish a canonical list, but the codes are stable.)

Also note: `taxFlag` per line ("Y"/"N") tells you which items were taxable
vs not. And `subTotal + taxes - instantSavings = total` reconciles cleanly.

### Endpoint summary

| What you want                | Operation              | Endpoint                                                  |
|------------------------------|------------------------|-----------------------------------------------------------|
| List online orders by date   | `getOnlineOrders`      | `ecom-api.costco.com/ebusiness/order/v1/orders/graphql`   |
| Online order line detail     | `getOrderDetails`      | same                                                      |
| List warehouse/gas receipts  | `receiptsWithCounts` (date mode) | same                                            |
| Single receipt detail        | `receiptsWithCounts` (barcode mode) | same                                         |
| Product description / image  | `products`             | `ecom-api.costco.com/ebusiness/product/v1/products/graphql` |

### Pagination

`getOnlineOrders` paginates with `pageNumber` (1-indexed) + `pageSize`.
`receiptsWithCounts` does NOT appear to paginate — it returns all receipts
in the date range. Costco UI restricts the date range picker to a few
preset windows (Last 3 Months, etc.), suggesting the API may also enforce
range limits. Start with windows ≤ 3 months and widen experimentally.

---

## Auth notes (both retailers)

Both rely on session cookies. The implementation pattern is:

```js
const res = await fetch(endpoint, {
  method: 'POST',                          // or 'GET'
  credentials: 'include',                  // <-- the important one
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ query, variables })
});
```

No credential storage in the extension. If the user is logged out, the
request returns 401 (or in Costco's case, a GraphQL error in the response
body — check both).

## Things observed but not used

- `sapphire-api.target.com/sapphire/runtime/api/v1/raw/...` — Target's
  server-side page-rendering layer. Returns the same data as `api.target.com`
  wrapped in additional page metadata. Use the underlying `api.target.com`
  endpoint directly.
- `redoak.target.com/content-publish/...` — Target's CMS for page templates.
  Unrelated.
- `cdui-orchestrations.target.com/cdui_orchestrations/v1/pages/...` — Target's
  client-driven UI orchestration layer. Wraps `api.target.com` calls. Skip.
- `gdx-api.costco.com/catalog/product/product-api/v1/products/summary` —
  faster REST alternative to the GraphQL `products` query. Returns the same
  data but as a flat REST GET. Use if the GraphQL endpoint becomes flaky.
- `azure-na-graphql.contentstack.com` — Costco's CMS for localized UI
  strings and feature flags. Unrelated.

## Captured-from-this-session values (sanitize before commit)

These values appeared in the captured HARs and are tied to the capturing
user. They're listed here as reference for the format/length only — do not
commit real values.

- Target `guest_id`: 10-digit numeric (your `member_id` and `guest_id` are the same number)
- Target `visitor_id`: 32-char hex
- Target `loyalty_id`: `tly.` + 32-char hex
- Target store IDs used: `1776` (your home store), `2716` (scheduled delivery store)
- Costco `warehouseNumber`: `847` (your home warehouse — South Denver)
- Costco `membershipNumber`: 12-digit numeric
