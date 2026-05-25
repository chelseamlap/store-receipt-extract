// Node-runnable tests of pure parser functions from extension/content/common.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  parseTargetOrderHistory,
  parseTargetOrderDetail,
  mergeTargetDetail,
  departmentFromDpci,
  parseCostcoOnlineOrders,
  parseCostcoOrderDetail,
  mergeCostcoDetail,
  parseCostcoReceiptList,
  parseCostcoReceiptDetail,
  channelFromCostcoReceiptType,
  classifyAdjustment,
  TokenBucket,
} from '../extension/content/common.js';

const targetFixture = JSON.parse(
  readFileSync(fileURLToPath(new URL('./fixtures/target_order_sample.json', import.meta.url)), 'utf8')
);
const targetDetailFixture = JSON.parse(
  readFileSync(fileURLToPath(new URL('./fixtures/target_order_detail_sample.json', import.meta.url)), 'utf8')
);
const targetStoreFixture = JSON.parse(
  readFileSync(fileURLToPath(new URL('./fixtures/target_store_sample.json', import.meta.url)), 'utf8')
);
const costcoFixture = JSON.parse(
  readFileSync(fileURLToPath(new URL('./fixtures/costco_order_sample.json', import.meta.url)), 'utf8')
);
const costcoReceiptFixture = JSON.parse(
  readFileSync(fileURLToPath(new URL('./fixtures/costco_receipt_sample.json', import.meta.url)), 'utf8')
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

test('parseTargetOrderHistory handles in-store orders (store_receipt_id, in_store channel, no address PII)', () => {
  const { orders, skipped } = parseTargetOrderHistory(targetStoreFixture);
  assert.equal(skipped, 0);
  assert.equal(orders.length, 1);
  const o = orders[0];
  assert.equal(o.order_channel, 'in_store');
  assert.equal(o.order_id, '6136-0000-0000-0000');
  assert.equal(o.total, 32.4);
  assert.equal(o.items[0].sku, '94886701');
  assert.ok(!JSON.stringify(o).includes('address'), 'address stripped from raw');
});

test('parseTargetOrderHistory tags online orders with order_channel online', () => {
  assert.equal(parseTargetOrderHistory(targetFixture).orders[0].order_channel, 'online');
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

test('departmentFromDpci returns the leading department segment', () => {
  assert.equal(departmentFromDpci('037-11-9248'), '037');
  assert.equal(departmentFromDpci('058-02-1234'), '058');
  assert.equal(departmentFromDpci(null), null);
  assert.equal(departmentFromDpci(''), null);
});

test('parseTargetOrderDetail extracts totals + lines and ignores PII', () => {
  const parsed = parseTargetOrderDetail(targetDetailFixture, '900000000000001');
  assert.deepEqual(parsed.totals, { total: 58.78, subtotal: 53.49, tax: 5.19, shipping: 0 });
  assert.equal(parsed.fulfillment_type, 'ShipToHome');
  assert.equal(parsed.items.length, 2);
  assert.deepEqual(
    parsed.items.map((i) => [i.sku, i.unit_price, i.quantity, i.line_total, i.category_native, i.dpci]),
    [
      ['11111111', 5.49, 1, 5.49, '058', '058-02-1234'],
      ['22222222', 24.0, 2, 48.0, '253', '253-07-0099'],
    ]
  );
  // The parsed result must not surface guest_profile / payments anywhere.
  const blob = JSON.stringify(parsed);
  assert.ok(!blob.includes('guest_profile'));
  assert.ok(!blob.includes('card_number'));
  assert.ok(!blob.includes('email_id'));
});

test('parseTargetOrderDetail returns null on unexpected shape', () => {
  assert.equal(parseTargetOrderDetail({}, 'x'), null);
  assert.equal(parseTargetOrderDetail({ summary: {} }, 'x'), null);
});

test('mergeTargetDetail makes the detail authoritative, keeps order_history as raw, drops PII', () => {
  const order = parseTargetOrderHistory(targetFixture).orders[0];
  mergeTargetDetail(order, targetDetailFixture);

  assert.equal(order.subtotal, 53.49);
  assert.equal(order.tax, 5.19);
  assert.equal(order.shipping, 0);
  assert.equal(order.total, 58.78);
  assert.equal(order.items[0].unit_price, 5.49);
  assert.equal(order.items[0].line_total, 5.49);
  assert.equal(order.items[1].line_total, 48.0);
  assert.equal(order.items[0].category_native, '058');
  // raw stays the order_history order (low-PII), raw_summary is money-only
  assert.equal(order.raw.order_number, '900000000000001');
  assert.equal(order.raw_summary.total_taxes, 5.19);
  assert.ok(!JSON.stringify(order).includes('card_number'));
  assert.ok(!JSON.stringify(order).includes('guest_profile'));
});

test('mergeTargetDetail is a no-op when detail parsing fails', () => {
  const order = parseTargetOrderHistory(targetFixture).orders[0];
  const before = JSON.stringify(order);
  mergeTargetDetail(order, { summary: null });
  assert.equal(JSON.stringify(order), before);
});

test('parseCostcoOnlineOrders normalizes the array-wrapped envelope, drops emailAddress', () => {
  const { orders, skipped } = parseCostcoOnlineOrders(costcoFixture.getOnlineOrders);
  assert.equal(skipped, 0);
  assert.equal(orders.length, 1);
  const o = orders[0];
  assert.equal(o.retailer, 'costco');
  assert.equal(o.order_id, '100000000');
  assert.equal(o.total, 142.37);
  assert.equal(o.subtotal, null); // prices only come from getOrderDetails
  assert.equal(o.items[0].sku, '1111111');
  assert.equal(o.items[0].unit_price, null);
  assert.ok(!JSON.stringify(o).includes('emailAddress'), 'PII dropped from raw');
});

test('parseCostcoOnlineOrders tolerates a missing/array-less envelope', () => {
  assert.deepEqual(parseCostcoOnlineOrders({}), { orders: [], skipped: 0 });
  assert.deepEqual(parseCostcoOnlineOrders({ data: { getOnlineOrders: [{}] } }), { orders: [], skipped: 0 });
});

test('parseCostcoOrderDetail extracts totals + nested line prices', () => {
  const parsed = parseCostcoOrderDetail(costcoFixture.getOrderDetails);
  assert.deepEqual(parsed.totals, { total: 142.37, subtotal: 130.0, tax: 12.37, shipping: 0 });
  assert.equal(parsed.items.length, 1);
  assert.deepEqual(
    parsed.items.map((i) => [i.sku, i.unit_price, i.quantity, i.line_total]),
    [['1111111', 9.99, 2, 19.98]]
  );
});

test('mergeCostcoDetail makes detail authoritative and keeps it PII-free', () => {
  const order = parseCostcoOnlineOrders(costcoFixture.getOnlineOrders).orders[0];
  mergeCostcoDetail(order, costcoFixture.getOrderDetails);
  assert.equal(order.subtotal, 130.0);
  assert.equal(order.tax, 12.37);
  assert.equal(order.total, 142.37);
  assert.equal(order.items[0].unit_price, 9.99);
  assert.equal(order.items[0].line_total, 19.98);
  assert.equal(order.items[0].category_native, null); // Costco online: no category
  assert.equal(order.raw_summary.merchandiseTotal, 130.0);
  assert.ok(!JSON.stringify(order).includes('emailAddress'));
});

test('channelFromCostcoReceiptType maps receipt types to channels', () => {
  assert.equal(channelFromCostcoReceiptType('In-Warehouse'), 'in_warehouse');
  assert.equal(channelFromCostcoReceiptType('Gas Station'), 'gas');
  assert.equal(channelFromCostcoReceiptType('Car Wash'), 'carwash');
  assert.equal(channelFromCostcoReceiptType(null), 'in_warehouse');
});

test('parseCostcoReceiptList returns barcodes + receipt types', () => {
  const list = parseCostcoReceiptList(costcoReceiptFixture.list);
  assert.equal(list.length, 2);
  assert.deepEqual(
    list.map((r) => [r.barcode, r.receiptType]),
    [
      ['21044300000000000000001', 'In-Warehouse'],
      ['21044300000000000000002', 'Gas Station'],
    ]
  );
  assert.deepEqual(parseCostcoReceiptList({}), []);
});

test('parseCostcoReceiptDetail normalizes a receipt, derives category from dept, strips membership', () => {
  const rec = parseCostcoReceiptDetail(costcoReceiptFixture.detail);
  assert.equal(rec.retailer, 'costco');
  assert.equal(rec.order_channel, 'in_warehouse');
  assert.equal(rec.order_id, '21044300000000000000001');
  assert.equal(rec.total, 26.78);
  assert.equal(rec.subtotal, 26.78);
  assert.equal(rec.tax, 0);
  assert.equal(rec.items.length, 2);
  assert.deepEqual(
    rec.items.map((i) => [i.sku, i.name, i.line_total, i.category_native]),
    [
      ['929092', 'KS PAPER TWL', 19.99, '14'],
      ['111111', 'ORGANIC EGGS', 6.79, '24'],
    ]
  );
  assert.ok(!JSON.stringify(rec).includes('membershipNumber'), 'membership stripped from raw');
});

test('parseCostcoReceiptDetail returns null on unexpected shape', () => {
  assert.equal(parseCostcoReceiptDetail({}), null);
  assert.equal(parseCostcoReceiptDetail({ data: { receiptsWithCounts: { receipts: [{}] } } }), null);
});

test('classifyAdjustment flags discounts, deposits, fees; passes products', () => {
  assert.equal(classifyAdjustment('/1218715'), 'discount');
  assert.equal(classifyAdjustment('/ GLASSES'), 'discount');
  assert.equal(classifyAdjustment('VT BOTTLE DEPST EE/854342'), 'deposit');
  assert.equal(classifyAdjustment('COLORADO DELIVERY FEE $.28'), 'fee');
  assert.equal(classifyAdjustment('STARB FRENCH 1.13KG BEANS'), null);
  assert.equal(classifyAdjustment('COFFEE 2LB'), null); // \bfee\b must not match "coffee"
  assert.equal(classifyAdjustment(null), null);
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
