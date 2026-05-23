// content/target.js — runs on logged-in target.com pages. On BEGIN_SCAN it
// pages through order_history (session cookies + public x-api-key), normalizes
// via common.js, enriches each order from the order-detail endpoint
// (per-line unit_price + tax/fee totals + dpci category), then streams the
// orders to the service worker to persist. PII in the detail response
// (guest_profile, payments, addresses) is never read/persisted — see
// docs/endpoints.md and common.parseTargetOrderDetail().

const ORDER_HISTORY_URL = 'https://api.target.com/guest_order_aggregations/v1/order_history';
const ORDER_DETAIL_URL = 'https://api.target.com/post_orders/v1'; // + /{order_number}
const PAGE_SIZE = 10;

let commonPromise = null;
function loadCommon() {
  if (!commonPromise) commonPromise = import(chrome.runtime.getURL('content/common.js'));
  return commonPromise;
}

function pageUrl(pageNumber) {
  const p = new URLSearchParams({
    page_number: String(pageNumber),
    page_size: String(PAGE_SIZE),
    order_purchase_type: 'ONLINE',
    pending_order: 'true',
    shipt_status: 'true',
  });
  return `${ORDER_HISTORY_URL}?${p}`;
}

// Fetch the order-detail and merge prices/tax/category onto the order.
// A failed detail fetch is non-fatal: the order is still stored with its
// order_history fields (null prices) so the scan doesn't abort.
async function enrichOrder(common, order, headers) {
  const url = `${ORDER_DETAIL_URL}/${encodeURIComponent(order.order_id)}`;
  try {
    const detail = await common.throttledFetchJson(url, { headers });
    common.mergeTargetDetail(order, detail);
  } catch (err) {
    console.warn(`detail enrichment failed for order ${order.order_id}: ${err.message}`);
  }
}

async function runScan({ mode, scanState, config }) {
  const common = await loadCommon();
  const apiKey = config?.target?.api_key;
  if (!apiKey) return { ok: false, error: 'Missing target.api_key in config.local.json.' };

  const stopId = mode === 'full' ? null : scanState?.latest_order_id_seen ?? null;
  const headers = { 'x-api-key': apiKey };

  let page = 1;
  let totalPages = Infinity;
  let newest = null;
  let stored = 0;

  while (page <= totalPages) {
    let envelope;
    try {
      envelope = await common.throttledFetchJson(pageUrl(page), { headers });
    } catch (err) {
      return { ok: false, error: `Fetch failed on page ${page}: ${err.message}`, stored };
    }
    totalPages = Number.isFinite(envelope?.total_pages) ? envelope.total_pages : page;

    const { orders } = common.parseTargetOrderHistory(envelope);
    if (orders.length === 0) break;

    const batch = [];
    let reachedKnown = false;
    for (const order of orders) {
      if (!newest) newest = { id: order.order_id, date: order.ordered_at };
      if (stopId && order.order_id === stopId) {
        reachedKnown = true;
        break;
      }
      await enrichOrder(common, order, headers);
      batch.push(order);
    }

    if (batch.length) {
      await chrome.runtime.sendMessage({ type: 'STORE_ORDERS', orders: batch });
      stored += batch.length;
    }
    if (reachedKnown) break;
    page += 1;
  }

  if (newest) {
    await chrome.runtime.sendMessage({
      type: 'SET_SCAN_STATE',
      retailer: 'target',
      state: {
        last_scan_at: new Date().toISOString(),
        latest_order_id_seen: newest.id,
        latest_order_date_seen: newest.date,
      },
    });
  }
  return { ok: true, stored };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== 'BEGIN_SCAN' || msg.retailer !== 'target') return false;
  runScan(msg)
    .then(sendResponse)
    .catch((err) => sendResponse({ ok: false, error: String(err?.message ?? err) }));
  return true;
});
