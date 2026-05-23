// popup/popup.js — stats, scan triggers, and CSV/JSON export.
// Reads IndexedDB directly (extension contexts share the same DB) and routes
// scans through the service worker.

import * as db from '../db.js';
import { ordersCsvBlob, itemsCsvBlob } from '../export/csv.js';
import { fullJsonBlob } from '../export/json.js';

const RETAILERS = ['target', 'costco'];
const statusEl = document.getElementById('status');

function setStatus(text) {
  statusEl.textContent = text;
}

function fileStamp(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}

function fmtLastScan(state) {
  if (!state?.last_scan_at) return 'never';
  const d = new Date(state.last_scan_at);
  return Number.isNaN(d.getTime()) ? state.last_scan_at : d.toLocaleString();
}

async function refreshStats() {
  for (const retailer of RETAILERS) {
    const section = document.querySelector(`.retailer[data-retailer="${retailer}"]`);
    const [orders, state] = await Promise.all([
      db.getAllOrders(retailer),
      db.getScanState(retailer),
    ]);
    section.querySelector('[data-count]').textContent = String(orders.length);
    section.querySelector('[data-lastscan]').textContent = fmtLastScan(state);
  }
}

function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  chrome.downloads.download({ url, filename }, () => {
    // Revoke shortly after the download has been handed off.
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  });
}

async function runScan(retailer, mode) {
  setStatus(`Scanning ${retailer}…`);
  try {
    const res = await chrome.runtime.sendMessage({ type: 'SCAN', retailer, mode });
    setStatus(res?.ok ? `${retailer}: scan complete.` : `${retailer}: ${res?.error ?? 'scan failed.'}`);
  } catch (err) {
    setStatus(`${retailer}: ${err.message}`);
  }
  await refreshStats();
}

async function exportCsv() {
  const retailer = document.getElementById('export-filter').value || undefined;
  const orders = await db.getAllOrders(retailer);
  if (orders.length === 0) {
    setStatus('Nothing to export.');
    return;
  }
  const tag = retailer || 'all';
  const stamp = fileStamp();
  download(ordersCsvBlob(orders, retailer), `orders_${tag}_${stamp}.csv`);
  download(itemsCsvBlob(orders, retailer), `order_items_${tag}_${stamp}.csv`);
  setStatus(`Exported ${orders.length} orders to CSV.`);
}

async function exportJson() {
  const retailer = document.getElementById('export-filter').value || undefined;
  const orders = await db.getAllOrders(retailer);
  if (orders.length === 0) {
    setStatus('Nothing to export.');
    return;
  }
  download(fullJsonBlob(orders, retailer), `order_history_full_${fileStamp()}.json`);
  setStatus(`Exported ${orders.length} orders to JSON.`);
}

function wireEvents() {
  for (const section of document.querySelectorAll('.retailer')) {
    const retailer = section.dataset.retailer;
    section.querySelector('[data-action="scan"]').addEventListener('click', () => runScan(retailer, 'incremental'));
    section.querySelector('[data-action="rescan"]').addEventListener('click', () => runScan(retailer, 'full'));
  }
  document.getElementById('export-csv').addEventListener('click', exportCsv);
  document.getElementById('export-json').addEventListener('click', exportJson);
}

wireEvents();
refreshStats().catch((err) => setStatus(`Failed to load stats: ${err.message}`));
