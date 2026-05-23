// background.js — MV3 service worker. Holds scan orchestration and owns the
// IndexedDB writes. Content scripts do the authenticated fetching + parsing
// (steps 5/6) and hand normalized orders back here to persist.

import * as db from './db.js';

const RETAILER_HOST = {
  target: 'https://www.target.com/',
  costco: 'https://www.costco.com/',
};

// Find an open, logged-in retailer tab to run the scan in. Returns the tab or
// null. (We don't open one automatically — the user must be logged in.)
async function findRetailerTab(retailer) {
  const pattern = `${RETAILER_HOST[retailer]}*`;
  const tabs = await chrome.tabs.query({ url: pattern });
  return tabs[0] ?? null;
}

// Ask the content script in `tab` to run a scan. The content script streams
// normalized orders back via STORE_ORDERS messages and resolves when done.
async function delegateScan(retailer, mode) {
  const tab = await findRetailerTab(retailer);
  if (!tab) {
    return {
      ok: false,
      error: `Open and log into ${RETAILER_HOST[retailer]} in a tab, then scan.`,
    };
  }
  try {
    const result = await chrome.tabs.sendMessage(tab.id, { type: 'BEGIN_SCAN', retailer, mode });
    return result ?? { ok: false, error: 'No response from content script.' };
  } catch (err) {
    // No receiver = content script not injected (page not an orders page yet).
    return { ok: false, error: `Could not reach the ${retailer} page: ${err.message}` };
  }
}

async function handleMessage(msg) {
  switch (msg?.type) {
    case 'STORE_ORDERS': {
      // Content scripts send already-normalized order records here.
      const orders = Array.isArray(msg.orders) ? msg.orders : [];
      for (const order of orders) {
        await db.upsertOrder(order);
      }
      return { ok: true, stored: orders.length };
    }
    case 'SET_SCAN_STATE':
      await db.setScanState(msg.retailer, msg.state);
      return { ok: true };
    case 'SCAN':
      return delegateScan(msg.retailer, msg.mode);
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
