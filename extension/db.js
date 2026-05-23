// db.js — IndexedDB wrapper for the order_history store.
// Pure async/await, no callbacks exposed. Runs in the extension (global
// `indexedDB`) and in node tests (where `fake-indexeddb/auto` installs the
// same global). No third-party imports here — dev-only test deps live in the
// test files, never in shipped extension code.

export const DB_NAME = 'order_history';
export const DB_VERSION = 1;

const STORE_ORDERS = 'orders';
const STORE_PRODUCT_CACHE = 'product_cache';
const STORE_SCAN_STATE = 'scan_state';

function idbFactory() {
  const impl = globalThis.indexedDB;
  if (!impl) {
    throw new Error('IndexedDB is not available in this environment');
  }
  return impl;
}

function nowIso() {
  return new Date().toISOString();
}

// Promisify a single IDBRequest.
function awaitRequest(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// Resolve when a transaction fully commits (so writes are durable before
// the caller proceeds).
function awaitTransaction(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
  });
}

// Lazily-opened singleton connection. Kept module-level so callers don't have
// to thread a handle through every call. `_closeForTests` resets it.
let dbPromise = null;

export async function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = idbFactory().open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_ORDERS)) {
        const orders = db.createObjectStore(STORE_ORDERS, {
          keyPath: ['retailer', 'order_id'],
        });
        orders.createIndex('by_retailer_date', ['retailer', 'ordered_at'], { unique: false });
        orders.createIndex('by_date', 'ordered_at', { unique: false });
      }
      if (!db.objectStoreNames.contains(STORE_PRODUCT_CACHE)) {
        db.createObjectStore(STORE_PRODUCT_CACHE, { keyPath: ['retailer', 'sku'] });
      }
      if (!db.objectStoreNames.contains(STORE_SCAN_STATE)) {
        db.createObjectStore(STORE_SCAN_STATE, { keyPath: 'retailer' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('IndexedDB open blocked by another connection'));
  });
  return dbPromise;
}

async function getDb() {
  return dbPromise || open();
}

// Insert or replace an order wholesale. Preserves `first_seen_at` from any
// existing record and always refreshes `last_updated_at`. Returns the stored
// record. Idempotent: re-running with the same input never duplicates.
export async function upsertOrder(order) {
  if (!order || typeof order.retailer !== 'string' || order.order_id == null) {
    throw new Error('upsertOrder requires an object with `retailer` and `order_id`');
  }
  const db = await getDb();
  const tx = db.transaction(STORE_ORDERS, 'readwrite');
  const store = tx.objectStore(STORE_ORDERS);
  const existing = await awaitRequest(store.get([order.retailer, order.order_id]));
  const ts = nowIso();
  const record = {
    ...order,
    first_seen_at: existing?.first_seen_at ?? order.first_seen_at ?? ts,
    last_updated_at: ts,
  };
  store.put(record);
  await awaitTransaction(tx);
  return record;
}

export async function getOrder(retailer, orderId) {
  const db = await getDb();
  const tx = db.transaction(STORE_ORDERS, 'readonly');
  const result = await awaitRequest(tx.objectStore(STORE_ORDERS).get([retailer, orderId]));
  await awaitTransaction(tx);
  return result ?? null;
}

// Returns every stored order, optionally filtered to one retailer. Small
// personal dataset, so filter in JS rather than fuss with compound key ranges.
export async function getAllOrders(retailer) {
  const db = await getDb();
  const tx = db.transaction(STORE_ORDERS, 'readonly');
  const all = await awaitRequest(tx.objectStore(STORE_ORDERS).getAll());
  await awaitTransaction(tx);
  return retailer ? all.filter((o) => o.retailer === retailer) : all;
}

export async function getScanState(retailer) {
  const db = await getDb();
  const tx = db.transaction(STORE_SCAN_STATE, 'readonly');
  const result = await awaitRequest(tx.objectStore(STORE_SCAN_STATE).get(retailer));
  await awaitTransaction(tx);
  return result ?? null;
}

export async function setScanState(retailer, state) {
  if (typeof retailer !== 'string') {
    throw new Error('setScanState requires a retailer string');
  }
  const db = await getDb();
  const tx = db.transaction(STORE_SCAN_STATE, 'readwrite');
  const record = { ...state, retailer };
  tx.objectStore(STORE_SCAN_STATE).put(record);
  await awaitTransaction(tx);
  return record;
}

export async function upsertProductCache(entry) {
  if (!entry || typeof entry.retailer !== 'string' || entry.sku == null) {
    throw new Error('upsertProductCache requires an object with `retailer` and `sku`');
  }
  const db = await getDb();
  const tx = db.transaction(STORE_PRODUCT_CACHE, 'readwrite');
  const record = { ...entry, cached_at: entry.cached_at ?? nowIso() };
  tx.objectStore(STORE_PRODUCT_CACHE).put(record);
  await awaitTransaction(tx);
  return record;
}

export async function getProductCache(retailer, sku) {
  const db = await getDb();
  const tx = db.transaction(STORE_PRODUCT_CACHE, 'readonly');
  const result = await awaitRequest(tx.objectStore(STORE_PRODUCT_CACHE).get([retailer, sku]));
  await awaitTransaction(tx);
  return result ?? null;
}

// Test seam: drop the cached connection so a fresh `open()` re-runs upgrades.
export function _closeForTests() {
  if (!dbPromise) return;
  const p = dbPromise;
  dbPromise = null;
  p.then((db) => db.close()).catch(() => {});
}
