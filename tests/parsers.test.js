// Node-runnable tests of pure parser functions from extension/content/common.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  parseTargetOrderHistory,
  enrichTargetItems,
  TokenBucket,
} from '../extension/content/common.js';

const targetFixture = JSON.parse(
  readFileSync(fileURLToPath(new URL('./fixtures/target_order_sample.json', import.meta.url)), 'utf8')
);

test('parseTargetOrderHistory normalizes the confirmed shape', () => {
  const { orders, skipped } = parseTargetOrderHistory(targetFixture);
  assert.equal(skipped, 0);
  assert.equal(orders.length, 1);

  const o = orders[0];
  assert.equal(o.retailer, 'target');
  assert.equal(o.order_id, '900000000000001');
  assert.equal(o.ordered_at, '2025-10-14T14:26:16-05:00');
  assert.equal(o.total, 58.78); // parsed from summary.grand_total string
  assert.equal(o.subtotal, null);
  assert.equal(o.tax, null);
  assert.equal(o.fulfillment_type, 'ShipToHome'); // from order_lines[0]
  assert.equal(o.items.length, 2);

  assert.deepEqual(
    o.items.map((i) => [i.line_index, i.sku, i.quantity, i.unit_price, i.category_native]),
    [
      [0, '11111111', 1, null, null],
      [1, '22222222', 2, null, null],
    ]
  );
  assert.equal(o.items[1].name, 'Paper Towels, 6 "Mega" Rolls');
});

test('parseTargetOrderHistory skips orders missing order_number, keeps the rest', () => {
  const env = { orders: [{ placed_date: 'x' }, targetFixture.orders[0]] };
  const { orders, skipped } = parseTargetOrderHistory(env);
  assert.equal(skipped, 1);
  assert.equal(orders.length, 1);
});

test('parseTargetOrderHistory tolerates a non-array orders field', () => {
  assert.deepEqual(parseTargetOrderHistory({}), { orders: [], skipped: 0 });
  assert.deepEqual(parseTargetOrderHistory(null), { orders: [], skipped: 0 });
});

test('enrichTargetItems applies price/category by TCIN and computes line_total', () => {
  const { orders } = parseTargetOrderHistory(targetFixture);
  const order = orders[0];
  enrichTargetItems(order, {
    '11111111': { category_native: 'Grocery', unit_price: 5.49 },
    '22222222': { category_native: 'Household', unit_price: 12.0 },
  });
  assert.equal(order.items[0].category_native, 'Grocery');
  assert.equal(order.items[0].unit_price, 5.49);
  assert.equal(order.items[0].line_total, 5.49); // qty 1
  assert.equal(order.items[1].line_total, 24.0); // qty 2 * 12.00
});

test('TokenBucket gates the 3rd request in a 2-req/sec window', async () => {
  let clock = 0;
  const bucket = new TokenBucket(2, () => clock);
  assert.equal(bucket.msUntilAvailable(), 0);
  await bucket.take(); // 1
  await bucket.take(); // 2 — bucket now empty
  assert.ok(bucket.msUntilAvailable() > 0, 'third request must wait');
  clock += 500; // half a second -> 1 token refilled
  assert.equal(bucket.msUntilAvailable(), 0);
});
