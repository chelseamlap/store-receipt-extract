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
  parseCostcoReceiptList,
  parseCostcoReceiptDetail,
  channelFromCostcoReceiptType,
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

// Write the final scan_state on clean completion: set latest_order_id_seen to
// this scan's newest order and clear any resume cursor (setScanState replaces
// the record wholesale, so omitting `resume` drops it).
async function finishScan(retailer, prevState, newest) {
  await db.setScanState(retailer, {
    last_scan_at: new Date().toISOString(),
    latest_order_id_seen: newest?.id ?? prevState?.latest_order_id_seen ?? null,
    latest_order_date_seen: newest?.date ?? prevState?.latest_order_date_seen ?? null,
  });
}

// ---------------------------------------------------------------------------
// Target scan
// ---------------------------------------------------------------------------

const TARGET_ORDER_HISTORY = 'https://api.target.com/guest_order_aggregations/v1/order_history';
const TARGET_ORDER_DETAIL = 'https://api.target.com/post_orders/v1';

function targetHistoryUrl(pageNumber, purchaseType = 'ONLINE') {
  const p = new URLSearchParams({
    page_number: String(pageNumber),
    page_size: '10',
    order_purchase_type: purchaseType,
    pending_order: 'true',
    shipt_status: 'true',
  });
  return `${TARGET_ORDER_HISTORY}?${p}`;
}

// Enrich one order with per-line price/tax/category from the order-detail
// endpoint. Online and in-store use different detail URLs but the same response
// shape. Non-fatal: on failure the order keeps its order_history fields.
async function enrichTargetOrder(order, headers) {
  const id = encodeURIComponent(order.order_id);
  const url =
    order.order_channel === 'in_store'
      ? `${TARGET_ORDER_DETAIL}/orders/${id}/store`
      : `${TARGET_ORDER_DETAIL}/${id}`;
  try {
    const detail = await throttledFetchJson(url, { headers });
    mergeTargetDetail(order, detail);
  } catch (err) {
    console.warn('[sre] detail enrichment failed for', order.order_id, err.message);
  }
}

// Pull Target in-store orders (order_purchase_type=STORE). Incremental skips
// receipts already stored (order-independent; no cursor). Returns count stored.
async function scanTargetStore(mode, headers) {
  let page = 1;
  let totalPages = Infinity;
  let stored = 0;
  while (page <= totalPages) {
    let envelope;
    try {
      envelope = await throttledFetchJson(targetHistoryUrl(page, 'STORE'), { headers });
    } catch (err) {
      console.warn('[sre] target STORE page', page, err.message);
      break;
    }
    totalPages = Number.isFinite(envelope?.total_pages) ? envelope.total_pages : page;
    const { orders } = parseTargetOrderHistory(envelope);
    if (orders.length === 0) break;
    for (const order of orders) {
      if (mode !== 'full' && (await db.getOrder('target', order.order_id))) continue;
      await enrichTargetOrder(order, headers);
      await db.upsertOrder(order);
      stored += 1;
    }
    page += 1;
  }
  return stored;
}

async function scanTarget(mode, config) {
  const apiKey = config?.target?.api_key;
  if (!apiKey) return { ok: false, error: 'No Target API key available.' };
  const headers = { 'x-api-key': apiKey };

  const scanState = await db.getScanState('target');
  const stopId = mode === 'full' ? null : scanState?.latest_order_id_seen ?? null;
  const resuming = mode === 'full' && scanState?.resume?.mode === 'full';

  let page = resuming ? scanState.resume.page : 1;
  let newest = resuming ? scanState.resume.newest : null;
  let totalPages = Infinity;
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
    // Checkpoint a full scan so an interrupted run resumes instead of restarting.
    // latest_order_id_seen is left untouched (it marks the last *complete* scan).
    if (mode === 'full') {
      await db.setScanState('target', {
        ...scanState,
        last_scan_at: new Date().toISOString(),
        resume: { mode: 'full', page, newest },
      });
    }
  }

  await finishScan('target', scanState, newest);

  // Also pull in-store orders (order_purchase_type=STORE).
  let storeStored = 0;
  try {
    storeStored = await scanTargetStore(mode, headers);
  } catch (err) {
    console.warn('[sre] target in-store scan failed:', err.message);
  }
  return { ok: true, stored: stored + storeStored };
}

// ---------------------------------------------------------------------------
// Costco scan (GraphQL over POST, on session cookies)
// ---------------------------------------------------------------------------

const COSTCO_ORDER_GQL = 'https://ecom-api.costco.com/ebusiness/order/v1/orders/graphql';

// Costco's GraphQL requires a short-lived session JWT (costco-x-authorization)
// plus client headers that the site mints via OAuth — they can't be hardcoded.
// We sniff them from the page's own requests to ecom-api.costco.com and replay
// them in our worker fetches. Cached in memory + storage.session (survives the
// worker sleeping; cleared when the browser closes).
const COSTCO_AUTH_HEADER_NAMES = new Set([
  'costco-x-authorization',
  'client-identifier',
  'costco-x-wcs-clientid',
  'costco.env',
  'costco.service',
]);
let costcoAuth = null; // { headers: {name:value}, capturedAt }

chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    const grabbed = {};
    for (const h of details.requestHeaders || []) {
      if (COSTCO_AUTH_HEADER_NAMES.has(h.name.toLowerCase())) grabbed[h.name] = h.value;
    }
    const hasAuth = Object.keys(grabbed).some((n) => n.toLowerCase() === 'costco-x-authorization');
    if (hasAuth) {
      costcoAuth = { headers: grabbed, capturedAt: Date.now() };
      chrome.storage.session.set({ costcoAuth }).catch(() => {});
      console.log('[sre] captured Costco auth headers:', Object.keys(grabbed).join(', '));
    }
  },
  { urls: ['https://ecom-api.costco.com/*'] },
  ['requestHeaders', 'extraHeaders']
);

// Costco's API also checks Origin/Referer, which a worker fetch() can't set.
// A declarativeNetRequest rule stamps them onto requests to ecom-api. (Harmless
// for the page's own requests — they already send these exact values.)
async function ensureCostcoHeaderRule() {
  try {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [1],
      addRules: [
        {
          id: 1,
          priority: 1,
          action: {
            type: 'modifyHeaders',
            requestHeaders: [
              { header: 'origin', operation: 'set', value: 'https://www.costco.com' },
              { header: 'referer', operation: 'set', value: 'https://www.costco.com/' },
            ],
          },
          condition: {
            urlFilter: '||ecom-api.costco.com/',
            resourceTypes: ['xmlhttprequest', 'other'],
          },
        },
      ],
    });
  } catch (err) {
    console.warn('[sre] could not set Costco header rule:', err.message);
  }
}
ensureCostcoHeaderRule();

async function getCostcoAuth() {
  if (costcoAuth?.headers) return costcoAuth;
  const { costcoAuth: stored } = await chrome.storage.session.get('costcoAuth');
  if (stored?.headers) costcoAuth = stored;
  return costcoAuth;
}
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

// receiptsWithCounts uses a DIFFERENT format: M/DD/YYYY (e.g. 3/01/2026).
function costcoReceiptDateStr(d) {
  return `${d.getMonth() + 1}/${String(d.getDate()).padStart(2, '0')}/${d.getFullYear()}`;
}

function docTypeForChannel(channel) {
  if (channel === 'gas') return 'gas';
  if (channel === 'carwash') return 'carwash';
  return 'warehouse';
}

// In-warehouse / gas / car-wash receipts. List mode returns barcodes for a date
// range; barcode mode returns the full receipt (line items + dept codes). PII
// fields are not requested.
const RECEIPTS_LIST = `query receiptsWithCounts($startDate:String!,$endDate:String!,$documentType:String!,$documentSubType:String!){
  receiptsWithCounts(startDate:$startDate,endDate:$endDate,documentType:$documentType,documentSubType:$documentSubType){
    inWarehouse gasStation carWash gasAndCarWash
    receipts{ warehouseName receiptType documentType transactionDateTime transactionBarcode transactionType total totalItemCount }
  }
}`;

const RECEIPTS_DETAIL = `query receiptsWithCounts($barcode:String!,$documentType:String!){
  receiptsWithCounts(barcode:$barcode,documentType:$documentType){
    receipts{
      receiptType documentType transactionDateTime transactionDate transactionBarcode warehouseNumber warehouseName
      total subTotal taxes instantSavings totalItemCount
      itemArray{ itemNumber itemDescription01 itemDescription02 itemDepartmentNumber unit amount itemUnitPriceAmount taxFlag fuelGradeDescription fuelUnitQuantity }
    }
  }
}`;

// Pull in-warehouse/gas/car-wash receipts over the lookback window. Incremental
// skips barcodes already stored (order-independent; no cursor needed). Returns
// the count stored. Non-fatal per receipt.
async function scanCostcoReceipts(mode) {
  const today = new Date();
  const minDate = new Date(today.getTime() - COSTCO_LOOKBACK_DAYS * DAY_MS);
  let windowEnd = new Date(today);
  let stored = 0;

  while (windowEnd > minDate) {
    const windowStart = new Date(Math.max(windowEnd.getTime() - COSTCO_WINDOW_DAYS * DAY_MS, minDate.getTime()));
    let listEnv;
    try {
      listEnv = await costcoGraphql(RECEIPTS_LIST, {
        startDate: costcoReceiptDateStr(windowStart),
        endDate: costcoReceiptDateStr(windowEnd),
        documentType: 'all',
        documentSubType: 'all',
      });
    } catch (err) {
      console.warn('[sre] receipts list failed:', err.message);
      break;
    }
    if (listEnv?.errors?.length) {
      console.warn('[sre] receipts list errors:', listEnv.errors[0].message);
      break;
    }

    for (const r of parseCostcoReceiptList(listEnv)) {
      if (mode !== 'full' && (await db.getOrder('costco', r.barcode))) continue;
      let detailEnv;
      try {
        detailEnv = await costcoGraphql(RECEIPTS_DETAIL, {
          barcode: r.barcode,
          documentType: docTypeForChannel(channelFromCostcoReceiptType(r.receiptType)),
        });
      } catch (err) {
        console.warn('[sre] receipt detail failed', r.barcode, err.message);
        continue;
      }
      if (detailEnv?.errors?.length) {
        console.warn('[sre] receipt detail errors', r.barcode, detailEnv.errors[0].message);
        continue;
      }
      const rec = parseCostcoReceiptDetail(detailEnv);
      if (rec) {
        await db.upsertOrder(rec);
        stored += 1;
      }
    }
    windowEnd = windowStart;
  }
  return stored;
}

async function costcoGraphql(query, variables) {
  const auth = await getCostcoAuth();
  if (!auth?.headers) {
    const err = new Error('NO_COSTCO_AUTH');
    err.code = 'NO_AUTH';
    throw err;
  }
  return throttledFetchJson(COSTCO_ORDER_GQL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...auth.headers },
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

  const auth = await getCostcoAuth();
  if (!auth?.headers) {
    return {
      ok: false,
      error: 'Open your Costco "Orders & Purchases" page first (so I can grab the session token), then click Scan.',
    };
  }
  await ensureCostcoHeaderRule();

  const scanState = await db.getScanState('costco');
  const stopId = mode === 'full' ? null : scanState?.latest_order_id_seen ?? null;
  const resuming = mode === 'full' && scanState?.resume?.mode === 'full';

  const today = new Date();
  const minDate =
    mode !== 'full' && scanState?.latest_order_date_seen
      ? new Date(new Date(scanState.latest_order_date_seen).getTime() - 7 * DAY_MS)
      : new Date(today.getTime() - COSTCO_LOOKBACK_DAYS * DAY_MS);

  let windowEnd = resuming ? new Date(scanState.resume.windowEndMs) : new Date(today);
  let newest = resuming ? scanState.resume.newest : null;
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
        if (err.code === 'NO_AUTH') {
          return { ok: false, error: 'Costco session token not captured — open your Costco orders page, then Scan.', stored };
        }
        if (/HTTP 40[13]/.test(err.message)) {
          return {
            ok: false,
            error: `Costco rejected the request (${err.message}) — your session token likely expired; reopen your Costco orders page and Scan again.`,
            stored,
          };
        }
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
    // Checkpoint a full scan so an interrupted run resumes from this window.
    if (mode === 'full') {
      await db.setScanState('costco', {
        ...scanState,
        last_scan_at: new Date().toISOString(),
        resume: { mode: 'full', windowEndMs: windowEnd.getTime(), newest },
      });
    }
  }

  await finishScan('costco', scanState, newest);

  // Also pull in-warehouse / gas / car-wash receipts (separate API, same auth).
  let receiptsStored = 0;
  try {
    receiptsStored = await scanCostcoReceipts(mode);
  } catch (err) {
    console.warn('[sre] costco receipts scan failed:', err.message);
  }
  return { ok: true, stored: stored + receiptsStored };
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
