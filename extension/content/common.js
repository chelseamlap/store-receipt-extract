// content/common.js — shared helpers for the retailer content scripts.
// Pure parsers + a token-bucket throttle + a throttled fetch wrapper. ES
// module: node tests import it directly; content scripts pull it in via
// `await import(chrome.runtime.getURL('content/common.js'))` (see ADR-006).

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

// Apply product_summary enrichment (price/category) onto an order's items,
// keyed by TCIN. `byTcin` maps tcin -> { category_native, unit_price }.
export function enrichTargetItems(order, byTcin) {
  for (const item of order.items) {
    const hit = item.sku ? byTcin[item.sku] : undefined;
    if (!hit) continue;
    if (hit.category_native != null) item.category_native = hit.category_native;
    if (hit.unit_price != null) {
      item.unit_price = hit.unit_price;
      if (item.quantity != null) item.line_total = +(hit.unit_price * item.quantity).toFixed(2);
    }
  }
  return order;
}
