// popup/popup.js — stats, scan triggers, and CSV/JSON export.
// Reads IndexedDB directly (extension contexts share the same DB) and routes
// scans through the service worker.

import * as db from '../db.js';
import { serializeOrdersCsv, serializeItemsCsv } from '../export/csv.js';
import { serializeFullJson } from '../export/json.js';

const RETAILERS = ['target', 'costco'];
const statusEl = document.getElementById('status');

// Optional: per-retailer account label from config.local.json -> filename segment.
// Lets you scan multiple family logins (Costco shared accounts, Target households)
// without mixing exports — update config.local.json's <retailer>.account_name when
// you switch logins, then scan/export.
let configPromise = null;
function loadConfig() {
  if (!configPromise) {
    configPromise = fetch(chrome.runtime.getURL('config.local.json'))
      .then((r) => (r.ok ? r.json() : {}))
      .catch(() => ({}));
  }
  return configPromise;
}
function accountSuffix(retailer, cfg) {
  const raw = cfg?.[retailer]?.account_name;
  if (!raw) return '';
  const safe = String(raw).trim().replace(/[^A-Za-z0-9._-]+/g, '_');
  return safe ? `_${safe}` : '';
}

function setStatus(text) {
  statusEl.textContent = text;
}

function fileStamp(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  const y = date.getFullYear();
  const m = p(date.getMonth() + 1);
  const d = p(date.getDate());
  const hh = p(date.getHours());
  const mm = p(date.getMinutes());
  const ss = p(date.getSeconds());
  return `${y}${m}${d}-${hh}${mm}${ss}`; // include time so each export is a unique file
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

// Blob URL download (data: URLs hang at in_progress in chrome.downloads).
// Resolves on the download() callback so it can never hang; revokes the URL
// after a delay so the download has time to read it.
function startDownload(text, mime, filename) {
  return new Promise((resolve) => {
    let url;
    try {
      url = URL.createObjectURL(new Blob([text], { type: mime }));
    } catch (e) {
      resolve({ filename, error: `createObjectURL: ${e.message}` });
      return;
    }
    try {
      chrome.downloads.download({ url, filename, saveAs: false, conflictAction: 'uniquify' }, (id) => {
        const error = chrome.runtime.lastError?.message;
        setTimeout(() => URL.revokeObjectURL(url), 60000);
        resolve({ filename, id, error: error ?? (id == null ? 'no download id' : undefined) });
      });
    } catch (e) {
      URL.revokeObjectURL(url);
      resolve({ filename, error: `download(): ${e.message}` });
    }
  });
}

// Resolve once the download reaches a terminal state (or after a timeout), so
// we report the final path/state rather than the transient in_progress.
function waitForDownload(id, timeoutMs = 8000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (item) => {
      if (done) return;
      done = true;
      chrome.downloads.onChanged.removeListener(onChanged);
      resolve(item);
    };
    const onChanged = (delta) => {
      if (delta.id !== id || !delta.state) return;
      if (delta.state.current !== 'in_progress') {
        chrome.downloads.search({ id }, (items) => finish(items?.[0]));
      }
    };
    chrome.downloads.onChanged.addListener(onChanged);
    chrome.downloads.search({ id }, (items) => {
      const it = items?.[0];
      if (it && it.state !== 'in_progress') finish(it);
    });
    setTimeout(() => chrome.downloads.search({ id }, (items) => finish(items?.[0])), timeoutMs);
  });
}

async function reportDownloads(results) {
  const errs = results.filter((r) => r.error || r.id == null);
  if (errs.length) {
    setStatus(`Download error: ${errs.map((e) => `${e.filename}: ${e.error ?? 'no id'}`).join(' | ')}`);
    return false;
  }
  const infos = await Promise.all(results.map((r) => waitForDownload(r.id)));
  if (infos.some((it) => it && it.state === 'in_progress')) {
    setStatus('Download stalled. In chrome://settings/downloads turn OFF "Ask where to save each file", then export again.');
    return false;
  }
  const desc = infos
    .map((it) => {
      if (!it) return '?';
      const why = it.state === 'interrupted' ? ` (${it.error ?? 'interrupted'})` : '';
      return `${it.filename || '(path pending)'} [${it.state}]${why}`;
    })
    .join('  •  ');
  setStatus(desc);
  return infos.every((it) => it && it.state === 'complete');
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

async function exportCsv(retailer) {
  try {
    const orders = await db.getAllOrders(retailer);
    if (orders.length === 0) {
      setStatus(`No ${retailer} orders to export.`);
      return;
    }
    const stamp = fileStamp();
    const acct = accountSuffix(retailer, await loadConfig());
    const results = await Promise.all([
      startDownload(serializeOrdersCsv(orders, retailer), 'text/csv', `orders_${retailer}${acct}_${stamp}.csv`),
      startDownload(serializeItemsCsv(orders, retailer), 'text/csv', `order_items_${retailer}${acct}_${stamp}.csv`),
    ]);
    await reportDownloads(results);
  } catch (err) {
    setStatus(`Export CSV error: ${err.message}`);
  }
}

async function exportJson(retailer) {
  try {
    const orders = await db.getAllOrders(retailer);
    if (orders.length === 0) {
      setStatus(`No ${retailer} orders to export.`);
      return;
    }
    const acct = accountSuffix(retailer, await loadConfig());
    const results = await Promise.all([
      startDownload(serializeFullJson(orders, retailer), 'application/json', `order_history_${retailer}${acct}_${fileStamp()}.json`),
    ]);
    await reportDownloads(results);
  } catch (err) {
    setStatus(`Export JSON error: ${err.message}`);
  }
}

function wireEvents() {
  for (const section of document.querySelectorAll('.retailer')) {
    const retailer = section.dataset.retailer;
    section.querySelector('[data-action="scan"]').addEventListener('click', () => runScan(retailer, 'incremental'));
    section.querySelector('[data-action="rescan"]').addEventListener('click', () => runScan(retailer, 'full'));
    section.querySelector('[data-action="export-csv"]').addEventListener('click', () => exportCsv(retailer));
    section.querySelector('[data-action="export-json"]').addEventListener('click', () => exportJson(retailer));
  }
}

wireEvents();
refreshStats().catch((err) => setStatus(`Failed to load stats: ${err.message}`));
