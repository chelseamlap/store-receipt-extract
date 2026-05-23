// background.js — MV3 service worker. Owns the entire scan: it fetches the
// retailer APIs directly (host_permissions + credentials:'include' ride on the
// logged-in session cookies, and extension-worker fetches bypass page CORS),
// parses via common.js, and writes to IndexedDB. No content script / tab is
// needed — the cookies live in the jar whether or not a retailer tab is open.

import * as db from './db.js';
import {
  parseTargetOrderHistory,
  mergeTargetDetail,
  parseCostcoOnlineOrders,
  mergeCostcoDetail,
  throttledFetchJson,
} from './content/common.js';

console.log('[sre] background service worker loaded');

// Public, non-sensitive defaults — documented as safe to commit in
// docs/endpoints.md (the Target key + Costco clientId are public frontend
// identifiers). Location-revealing values (store_id, zip, warehouse) are NOT
// here — they come only from the gitignored config.local.json when present.
const PUBLIC_CONFIG_DEFAULTS = {
  target: { api_key: 'ff457966e64d5e877fdbad070f276d18ecec4a01' },
  costco: { client_id: '4900eb1f-0c10-4bd9-99c3-c59e6c1ecebf', locale: ['en-US'] },
};

function mergeConfig(base, override) {
  const out = { ...base };
  for (const key of Object.keys(override || {})) {
    out[key] = { ...(base[key] || {}), ...(override[key] || {}) };
  }
  return out;
}

// Runtime config: public defaults overlaid with the optional gitignored
// config.local.json (location IDs). Loaded once, cached. The file is optional —
// if it can't be read, the public defaults still let Target scan.
let configPromise = null;
async function loadConfig() {
  if (!configPromise) {
    configPromise = (async () => {
      let fileCfg = {};
      try {
        const res = await fetch(chrome.runtime.getURL('config.local.json'));
        if (res.ok) fileCfg = await res.json();
        else console.warn('[sre] config.local.json status', res.status);
      } catch (err) {
        console.warn('[sre] config.local.json unreadable; using public defaults:', err.message);
      }
      return mergeConfig(PUBLIC_CONFIG_DEFAULTS, fileCfg);
    })();
  }
  return configPromise;
}

// ---------------------------------------------------------------------------
// Target scan
// ---------------------------------------------------------------------------

const TARGET_ORDER_HISTORY = 'https://api.target.com/guest_order_aggregations/v1/order_history';
const TARGET_ORDER_DETAIL = 'https://api.target.com/post_orders/v1';

function targetHistoryUrl(pageNumber) {
  const p = new URLSearchParams({
    page_number: String(pageNumber),
    page_size: '10',
    order_purchase_type: 'ONLINE',
    pending_order: 'true',
    shipt_status: 'true',
  });
  return `${TARGET_ORDER_HISTORY}?${p}`;
}

// Enrich one order with per-line price/tax/category from the order-detail
// endpoint. Non-fatal: on failure the order keeps its order_history fields.
async function enrichTargetOrder(order, headers) {
  const url = `${TARGET_ORDER_DETAIL}/${encodeURIComponent(order.order_id)}`;
  try {
    const detail = await throttledFetchJson(url, { headers });
    mergeTargetDetail(order, detail);
  } catch (err) {
    console.warn('[sre] detail enrichment failed for', order.order_id, err.message);
  }
}

async function scanTarget(mode, config) {
  const apiKey = config?.target?.api_key;
  if (!apiKey) return { ok: false, error: 'No Target API key available.' };
  const headers = { 'x-api-key': apiKey };

  const scanState = await db.getScanState('target');
  const stopId = mode === 'full' ? null : scanState?.latest_order_id_seen ?? null;

  let page = 1;
  let totalPages = Infinity;
  let newest = null;
  let stored = 0;

  while (page <= totalPages) {
    let envelope;
    try {
      envelope = await throttledFetchJson(targetHistoryUrl(page), { headers });
    } catch (err) {
      return { ok: false, error: `order_history page ${page}: ${err.message}`, stored };
    }
    totalPages = Number.isFinite(envelope?.total_pages) ? envelope.total_pages : page;

    const { orders } = parseTargetOrderHistory(envelope);
    if (orders.length === 0) break;

    let reachedKnown = false;
    for (const order of orders) {
      if (!newest) newest = { id: order.order_id, date: order.ordered_at };
      if (stopId && order.order_id === stopId) {
        reachedKnown = true;
        break;
      }
      await enrichTargetOrder(order, headers);
      await db.upsertOrder(order);
      stored += 1;
    }
    if (reachedKnown) break;
    page += 1;
  }

  if (newest) {
    await db.setScanState('target', {
      last_scan_at: new Date().toISOString(),
      latest_order_id_seen: newest.id,
      latest_order_date_seen: newest.date,
    });
  }
  return { ok: true, stored };
}

// ---------------------------------------------------------------------------
// Costco scan (GraphQL over POST, on session cookies)
// ---------------------------------------------------------------------------

const COSTCO_ORDER_GQL = 'https://ecom-api.costco.com/ebusiness/order/v1/orders/graphql';
const COSTCO_PAGE_SIZE = 10;
const COSTCO_WINDOW_DAYS = 90; // Costco limits the date range; page in windows
const COSTCO_LOOKBACK_DAYS = 1095; // ~3 years for a full scan
const DAY_MS = 86400000;

// Only PII-free fields are requested.
const GET_ONLINE_ORDERS = `query getOnlineOrders($startDate:String!,$endDate:String!,$pageNumber:Int,$pageSize:Int,$warehouseNumber:String!){
  getOnlineOrders(startDate:$startDate,endDate:$endDate,pageNumber:$pageNumber,pageSize:$pageSize,warehouseNumber:$warehouseNumber){
    pageNumber pageSize totalNumberOfRecords
    bcOrders{ orderHeaderId orderPlacedDate:orderedDate orderNumber:sourceOrderNumber orderTotal warehouseNumber status
      orderLineItems{ itemId itemNumber lineNumber itemDescription } }
  }
}`;

const GET_ORDER_DETAILS = `query getOrderDetails($orderNumbers:[String]){
  getOrderDetails(orderNumbers:$orderNumbers){
    warehouseNumber orderNumber:sourceOrderNumber orderPlacedDate:orderedDate status
    merchandiseTotal shippingAndHandling retailDeliveryFee grocerySurcharge frozenSurchargeFee uSTaxTotal1 orderTotal discountAmount
    shipToAddress:orderShipTos{ orderLineItems{ itemNumber itemDescription:sourceItemDescription price:unitPrice quantity:orderedTotalQuantity merchandiseTotalAmount lineNumber itemId programType } }
  }
}`;

// Costco uses YYYY-M-DD with a non-zero-padded month (e.g. 2026-3-01).
function costcoDateStr(d) {
  return `${d.getFullYear()}-${d.getMonth() + 1}-${String(d.getDate()).padStart(2, '0')}`;
}

async function costcoGraphql(query, variables) {
  return throttledFetchJson(COSTCO_ORDER_GQL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
}

// Enrich one order with prices/totals from getOrderDetails. Non-fatal.
async function enrichCostcoOrder(order) {
  try {
    const env = await costcoGraphql(GET_ORDER_DETAILS, { orderNumbers: [order.order_id] });
    if (env?.errors?.length) {
      console.warn('[sre] costco detail errors', order.order_id, env.errors[0].message);
      return;
    }
    mergeCostcoDetail(order, env);
  } catch (err) {
    console.warn('[sre] costco detail failed', order.order_id, err.message);
  }
}

async function scanCostco(mode, config) {
  const warehouse = config?.costco?.warehouse_number;
  if (!warehouse) {
    return {
      ok: false,
      error: 'Missing costco.warehouse_number — load the extension from the repo (config.local.json present).',
    };
  }

  const scanState = await db.getScanState('costco');
  const stopId = mode === 'full' ? null : scanState?.latest_order_id_seen ?? null;

  const today = new Date();
  const minDate =
    mode !== 'full' && scanState?.latest_order_date_seen
      ? new Date(new Date(scanState.latest_order_date_seen).getTime() - 7 * DAY_MS)
      : new Date(today.getTime() - COSTCO_LOOKBACK_DAYS * DAY_MS);

  let windowEnd = new Date(today);
  let newest = null;
  let stored = 0;
  let reachedKnown = false;

  // Walk newest -> oldest in date windows so incremental can stop early.
  while (windowEnd > minDate && !reachedKnown) {
    const windowStart = new Date(Math.max(windowEnd.getTime() - COSTCO_WINDOW_DAYS * DAY_MS, minDate.getTime()));
    let page = 1;
    let total = Infinity;

    while ((page - 1) * COSTCO_PAGE_SIZE < total) {
      let env;
      try {
        env = await costcoGraphql(GET_ONLINE_ORDERS, {
          startDate: costcoDateStr(windowStart),
          endDate: costcoDateStr(windowEnd),
          pageNumber: page,
          pageSize: COSTCO_PAGE_SIZE,
          warehouseNumber: String(warehouse),
        });
      } catch (err) {
        return { ok: false, error: `getOnlineOrders: ${err.message}`, stored };
      }
      if (env?.errors?.length) {
        return { ok: false, error: `getOnlineOrders: ${env.errors[0].message}`, stored };
      }

      const pageNode = env?.data?.getOnlineOrders?.[0];
      total = Number.isFinite(pageNode?.totalNumberOfRecords) ? pageNode.totalNumberOfRecords : 0;

      const { orders } = parseCostcoOnlineOrders(env);
      if (orders.length === 0) break;

      for (const order of orders) {
        if (!newest) newest = { id: order.order_id, date: order.ordered_at };
        if (stopId && order.order_id === stopId) {
          reachedKnown = true;
          break;
        }
        await enrichCostcoOrder(order);
        await db.upsertOrder(order);
        stored += 1;
      }
      if (reachedKnown) break;
      page += 1;
    }
    windowEnd = windowStart; // older window next (overlap is harmless — upsert is idempotent)
  }

  if (newest) {
    await db.setScanState('costco', {
      last_scan_at: new Date().toISOString(),
      latest_order_id_seen: newest.id,
      latest_order_date_seen: newest.date,
    });
  }
  return { ok: true, stored };
}

async function scanRetailer(retailer, mode) {
  const config = await loadConfig();
  console.log('[sre] scan', retailer, mode);
  if (retailer === 'target') return scanTarget(mode, config);
  if (retailer === 'costco') return scanCostco(mode, config);
  return { ok: false, error: `Unknown retailer: ${retailer}` };
}

async function handleMessage(msg) {
  switch (msg?.type) {
    case 'SCAN':
      return scanRetailer(msg.retailer, msg.mode);
    default:
      return { ok: false, error: `Unknown message type: ${msg?.type}` };
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  handleMessage(msg)
    .then(sendResponse)
    .catch((err) => sendResponse({ ok: false, error: String(err?.message ?? err) }));
  return true; // keep the channel open for the async response
});
