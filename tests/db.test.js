// Node-runnable tests for the IndexedDB wrapper (extension/db.js).
// Uses fake-indexeddb (dev-only) to provide a real IndexedDB implementation
// in node. Run with: npm test  (node --test tests/)

import 'fake-indexeddb/auto';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import * as db from '../extension/db.js';

function deleteDatabase(name) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(name);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('deleteDatabase blocked'));
  });
}

// Fresh, isolated database before every test.
beforeEach(async () => {
  db._closeForTests();
  await deleteDatabase(db.DB_NAME);
  await db.open();
});

function sampleOrder(overrides = {}) {
  return {
    retailer: 'target',
    order_id: '900000000000001',
    account_hint: 'me@example.com',
    ordered_at: '2025-10-14T14:26:16-05:00',
    total: 58.78,
    subtotal: null,
    tax: null,
    shipping: null,
    fulfillment_type: 'ShipToHome',
    raw: { orderNumber: '900000000000001' },
    items: [
      {
        line_index: 0,
        sku: '11111111',
        name: 'Unsalted Roasted Mixed Nuts',
        quantity: 1,
        unit_price: null,
        line_total: null,
        category_native: 'Grocery',
        raw_item: { tcin: '11111111' },
      },
    ],
    ...overrides,
  };
}

test('open() creates the expected object stores', async () => {
  const handle = await db.open();
  const names = Array.from(handle.objectStoreNames).sort();
  assert.deepEqual(names, ['orders', 'product_cache', 'scan_state']);
});

test('upsertOrder then getOrder round-trips the record', async () => {
  await db.upsertOrder(sampleOrder());
  const got = await db.getOrder('target', '900000000000001');
  assert.equal(got.order_id, '900000000000001');
  assert.equal(got.total, 58.78);
  assert.equal(got.items.length, 1);
  assert.ok(got.first_seen_at, 'first_seen_at is set');
  assert.ok(got.last_updated_at, 'last_updated_at is set');
});

test('getOrder returns null for a missing order', async () => {
  assert.equal(await db.getOrder('target', 'nope'), null);
});

test('upsertOrder is idempotent: same input twice yields one record', async () => {
  await db.upsertOrder(sampleOrder());
  await db.upsertOrder(sampleOrder());
  const all = await db.getAllOrders('target');
  assert.equal(all.length, 1);
});

test('re-upsert preserves first_seen_at and refreshes last_updated_at', async () => {
  const first = await db.upsertOrder(sampleOrder());
  // Ensure wall-clock advances so timestamps can differ.
  await new Promise((r) => setTimeout(r, 5));
  const second = await db.upsertOrder(
    sampleOrder({ total: 61.0, items: [] }) // status/contents changed
  );
  assert.equal(second.first_seen_at, first.first_seen_at, 'first_seen_at preserved');
  assert.notEqual(second.last_updated_at, first.first_seen_at);
  assert.ok(second.last_updated_at >= first.last_updated_at);

  const got = await db.getOrder('target', '900000000000001');
  assert.equal(got.total, 61.0, 'wholesale replace updated total');
  assert.equal(got.items.length, 0, 'wholesale replace updated items');
});

test('getAllOrders filters by retailer and returns all when omitted', async () => {
  await db.upsertOrder(sampleOrder());
  await db.upsertOrder(sampleOrder({ retailer: 'costco', order_id: 'C-1' }));

  assert.equal((await db.getAllOrders('target')).length, 1);
  assert.equal((await db.getAllOrders('costco')).length, 1);
  assert.equal((await db.getAllOrders()).length, 2);
});

test('upsertOrder rejects input missing keys', async () => {
  await assert.rejects(() => db.upsertOrder({ retailer: 'target' }));
  await assert.rejects(() => db.upsertOrder({ order_id: 'x' }));
});

test('scan_state set/get round-trips and overwrites', async () => {
  assert.equal(await db.getScanState('target'), null);
  await db.setScanState('target', {
    last_scan_at: '2025-10-14T20:00:00Z',
    latest_order_id_seen: '900000000000001',
    latest_order_date_seen: '2025-10-14T14:26:16-05:00',
  });
  let state = await db.getScanState('target');
  assert.equal(state.latest_order_id_seen, '900000000000001');

  await db.setScanState('target', { last_scan_at: '2025-11-01T00:00:00Z' });
  state = await db.getScanState('target');
  assert.equal(state.last_scan_at, '2025-11-01T00:00:00Z');
});

test('product_cache upsert/get round-trips and is idempotent', async () => {
  await db.upsertProductCache({
    retailer: 'target',
    sku: '11111111',
    name: 'Mixed Nuts',
    category_native: 'Grocery',
    raw: {},
  });
  await db.upsertProductCache({
    retailer: 'target',
    sku: '11111111',
    name: 'Mixed Nuts',
    category_native: 'Grocery',
    raw: {},
  });
  const got = await db.getProductCache('target', '11111111');
  assert.equal(got.name, 'Mixed Nuts');
  assert.ok(got.cached_at, 'cached_at defaulted');
  assert.equal(await db.getProductCache('target', 'missing'), null);
});
