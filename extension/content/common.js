// content/common.js — shared library: pure parsers + a token-bucket throttle +
// a throttled fetch wrapper. ES module imported by the service worker
// (background.js) and by node tests. Not a content script (see ADR-008).

// ---------------------------------------------------------------------------
// Throttle: token bucket, 2 req/sec per upstream host, with small jitter.
// ---------------------------------------------------------------------------

export const REQS_PER_SEC = 2;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class TokenBucket {
  constructor(ratePerSec = REQS_PER_SEC, now = () => Date.now()) {
    this.capacity = ratePerSec;
    this.tokens = ratePerSec;
    this.ratePerSec = ratePerSec;
    this.now = now;
    this.last = now();
  }

  _refill() {
    const t = this.now();
    const elapsed = (t - this.last) / 1000;
    if (elapsed > 0) {
      this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.ratePerSec);
      this.last = t;
    }
  }

  // Time in ms to wait before a token is available (0 if one is ready now).
  msUntilAvailable() {
    this._refill();
    if (this.tokens >= 1) return 0;
    return Math.ceil(((1 - this.tokens) / this.ratePerSec) * 1000);
  }

  async take() {
    let wait = this.msUntilAvailable();
    while (wait > 0) {
      await sleep(wait);
      wait = this.msUntilAvailable();
    }
    this.tokens -= 1;
  }
}

const buckets = new Map();
function bucketForHost(host) {
  if (!buckets.has(host)) buckets.set(host, new TokenBucket());
  return buckets.get(host);
}

// Throttled JSON fetch on session cookies. Throws on non-OK so callers can
// decide whether to skip or abort.
export async function throttledFetchJson(url, options = {}) {
  const host = new URL(url).host;
  await bucketForHost(host).take();
  await sleep(Math.floor(Math.random() * 150)); // jitter
  const res = await fetch(url, { credentials: 'include', ...options });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} for ${url}`);
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// Defensive parsing helper.
// ---------------------------------------------------------------------------

export function logUnexpectedShape(path, orderId) {
  console.warn(`unexpected shape at ${path} for order ${orderId ?? '<unknown>'}`);
}

function toNumberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : parseFloat(value);
  return Number.isFinite(n) ? n : null;
}

// ---------------------------------------------------------------------------
// Target: normalize one order_history page into storage records.
// Returns { orders: [...normalized], skipped: n }. Pure — no I/O.
// ---------------------------------------------------------------------------

export function parseTargetOrderHistory(envelope) {
  const out = { orders: [], skipped: 0 };
  const orders = envelope?.orders;
  if (!Array.isArray(orders)) {
    logUnexpectedShape('$.orders', undefined);
    return out;
  }

  for (const order of orders) {
    const orderId = order?.order_number;
    if (!orderId) {
      logUnexpectedShape('$.orders[].order_number', order?.order_number);
      out.skipped += 1;
      continue;
    }

    const lines = Array.isArray(order.order_lines) ? order.order_lines : [];
    const items = lines.map((line, i) => ({
      line_index: i,
      sku: line?.item?.tcin ?? null,
      name: line?.item?.description ?? null,
      quantity: toNumberOrNull(line?.original_quantity) ?? line?.original_quantity ?? null,
      unit_price: null, // enrichment fills these (product_summary)
      line_total: null,
      category_native: null,
      raw_item: line,
    }));

    out.orders.push({
      retailer: 'target',
      order_id: String(orderId),
      account_hint: null,
      ordered_at: order.placed_date ?? null,
      total: toNumberOrNull(order?.summary?.grand_total),
      subtotal: null, // Target order_history doesn't expose these
      tax: null,
      shipping: null,
      fulfillment_type: lines[0]?.fulfillment_spec?.fulfillment_type ?? null,
      raw: order,
      items,
    });
  }
  return out;
}

// Target's DPCI (Department-Class-Item, e.g. "037-11-9248") encodes the native
// merchandising taxonomy; the first segment is the department. We expose the
// department code as category_native and keep the full DPCI on the item.
export function departmentFromDpci(dpci) {
  if (typeof dpci !== 'string') return null;
  const dept = dpci.split('-')[0]?.trim();
  return dept ? dept : null;
}

// Parse the post_orders/v1/{order_number} detail response into the money +
// line fields we keep. Strips PII (guest_profile, payments, addresses are
// never read). Returns null on an unexpected shape so the caller can fall back
// to the order_history-only record.
export function parseTargetOrderDetail(detail, orderId) {
  const summary = detail?.summary;
  const packages = detail?.packages;
  if (!summary || !Array.isArray(packages)) {
    logUnexpectedShape('$.summary / $.packages', orderId ?? detail?.order_number);
    return null;
  }

  const items = [];
  for (const pkg of packages) {
    for (const line of pkg?.order_lines ?? []) {
      const it = line?.item ?? {};
      const quantity = toNumberOrNull(line?.quantity) ?? toNumberOrNull(line?.original_quantity);
      const unitPrice = toNumberOrNull(it.unit_price);
      items.push({
        line_index: items.length,
        sku: it.tcin ?? null,
        name: it.description ?? null,
        quantity,
        unit_price: unitPrice,
        line_total:
          unitPrice != null && quantity != null ? +(unitPrice * quantity).toFixed(2) : null,
        category_native: departmentFromDpci(it.dpci),
        dpci: it.dpci ?? null,
        raw_item: line,
      });
    }
  }

  return {
    totals: {
      total: toNumberOrNull(summary.grand_total),
      subtotal: toNumberOrNull(summary.total_product_price),
      tax: toNumberOrNull(summary.total_taxes),
      shipping: toNumberOrNull(summary.total_shipping_charges),
    },
    fulfillment_type: packages[0]?.fulfillment?.fulfillment_type ?? null,
    items,
    // PII-free money breakdown kept for full-fidelity JSON export.
    raw_summary: summary,
  };
}

// Merge a parsed detail onto an order_history record. Detail is authoritative
// for prices/category/totals; order_history is kept as `raw`. No-op if detail
// failed to parse (leaves null prices). Does NOT persist PII from the detail.
export function mergeTargetDetail(order, detail) {
  const parsed = detail && !detail.totals ? parseTargetOrderDetail(detail, order.order_id) : detail;
  if (!parsed) return order;

  order.total = parsed.totals.total ?? order.total;
  order.subtotal = parsed.totals.subtotal ?? order.subtotal;
  order.tax = parsed.totals.tax ?? order.tax;
  order.shipping = parsed.totals.shipping ?? order.shipping;
  order.fulfillment_type = parsed.fulfillment_type ?? order.fulfillment_type;
  if (parsed.items.length) order.items = parsed.items;
  order.raw_summary = parsed.raw_summary;
  return order;
}

// ---------------------------------------------------------------------------
// Costco: getOnlineOrders -> storage records (no prices; those come from
// getOrderDetails). Response is array-wrapped: data.getOnlineOrders[0].bcOrders.
// We never request PII fields, but defensively drop emailAddress from raw.
// ---------------------------------------------------------------------------

export function parseCostcoOnlineOrders(envelope) {
  const out = { orders: [], skipped: 0 };
  const wrapper = envelope?.data?.getOnlineOrders;
  const page = Array.isArray(wrapper) ? wrapper[0] : wrapper;
  const bcOrders = page?.bcOrders;
  if (!Array.isArray(bcOrders)) {
    logUnexpectedShape('$.data.getOnlineOrders[0].bcOrders', undefined);
    return out;
  }

  for (const o of bcOrders) {
    const orderId = o?.orderNumber;
    if (!orderId) {
      logUnexpectedShape('$.bcOrders[].orderNumber', undefined);
      out.skipped += 1;
      continue;
    }
    const lines = Array.isArray(o.orderLineItems) ? o.orderLineItems : [];
    const items = lines.map((li, i) => ({
      line_index: i,
      sku: li?.itemNumber != null ? String(li.itemNumber) : null,
      name: li?.itemDescription ?? null,
      quantity: toNumberOrNull(li?.quantity),
      unit_price: null, // getOrderDetails fills these
      line_total: null,
      category_native: null, // Costco online exposes no category
      dpci: null,
      raw_item: li,
    }));
    const { emailAddress, ...rawSafe } = o; // drop the one PII field
    void emailAddress;
    out.orders.push({
      retailer: 'costco',
      order_id: String(orderId),
      account_hint: null,
      ordered_at: o.orderPlacedDate ?? null,
      total: toNumberOrNull(o.orderTotal),
      subtotal: null,
      tax: null,
      shipping: null,
      fulfillment_type: null,
      raw: rawSafe,
      items,
    });
  }
  return out;
}

// Parse getOrderDetails (data.getOrderDetails, possibly array). Line items are
// nested under orderShipTos[] (aliased shipToAddress). Money-only — the query
// requests no PII. Returns null on unexpected shape.
export function parseCostcoOrderDetail(envelope) {
  const node = envelope?.data?.getOrderDetails;
  const d = Array.isArray(node) ? node[0] : node;
  if (!d || typeof d !== 'object') {
    logUnexpectedShape('$.data.getOrderDetails', undefined);
    return null;
  }

  const items = [];
  for (const ship of Array.isArray(d.shipToAddress) ? d.shipToAddress : []) {
    for (const li of ship?.orderLineItems ?? []) {
      const qty = toNumberOrNull(li?.quantity);
      const unit = toNumberOrNull(li?.price);
      items.push({
        line_index: items.length,
        sku: li?.itemNumber != null ? String(li.itemNumber) : null,
        name: li?.itemDescription ?? null,
        quantity: qty,
        unit_price: unit,
        line_total:
          toNumberOrNull(li?.merchandiseTotalAmount) ??
          (unit != null && qty != null ? +(unit * qty).toFixed(2) : null),
        category_native: null,
        dpci: null,
        raw_item: li,
      });
    }
  }

  return {
    totals: {
      total: toNumberOrNull(d.orderTotal),
      subtotal: toNumberOrNull(d.merchandiseTotal),
      tax: toNumberOrNull(d.uSTaxTotal1),
      shipping: toNumberOrNull(d.shippingAndHandling),
    },
    items,
    raw_summary: {
      merchandiseTotal: d.merchandiseTotal ?? null,
      shippingAndHandling: d.shippingAndHandling ?? null,
      retailDeliveryFee: d.retailDeliveryFee ?? null,
      grocerySurcharge: d.grocerySurcharge ?? null,
      frozenSurchargeFee: d.frozenSurchargeFee ?? null,
      uSTaxTotal1: d.uSTaxTotal1 ?? null,
      discountAmount: d.discountAmount ?? null,
      orderTotal: d.orderTotal ?? null,
    },
  };
}

export function mergeCostcoDetail(order, detailEnvelope) {
  const parsed = parseCostcoOrderDetail(detailEnvelope);
  if (!parsed) return order;
  order.total = parsed.totals.total ?? order.total;
  order.subtotal = parsed.totals.subtotal ?? order.subtotal;
  order.tax = parsed.totals.tax ?? order.tax;
  order.shipping = parsed.totals.shipping ?? order.shipping;
  if (parsed.items.length) order.items = parsed.items;
  order.raw_summary = parsed.raw_summary;
  return order;
}
