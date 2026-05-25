// Node-runnable tests for the export serializers (pure string functions).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  csvField,
  serializeOrdersCsv,
  serializeItemsCsv,
} from '../extension/export/csv.js';
import { buildFullExport, serializeFullJson } from '../extension/export/json.js';

function sampleOrders() {
  return [
    {
      retailer: 'target',
      order_id: '900000000000001',
      order_channel: 'online',
      account_hint: 'me@example.com',
      ordered_at: '2025-10-14T14:26:16-05:00',
      total: 58.78,
      subtotal: null,
      tax: null,
      shipping: null,
      fulfillment_type: 'ShipToHome',
      items: [
        { line_index: 0, sku: '111', name: 'Mixed Nuts', quantity: 1, unit_price: null, line_total: null, category_native: 'Grocery' },
        { line_index: 1, sku: '222', name: 'Paper Towels, 6 "Mega" Rolls', quantity: 2, unit_price: null, line_total: null, category_native: 'Household' },
      ],
    },
    {
      retailer: 'costco',
      order_id: 'C-1',
      order_channel: 'in_warehouse',
      account_hint: null,
      ordered_at: '2026-04-02T10:15:00Z',
      total: 142.37,
      subtotal: 130.0,
      tax: 12.37,
      shipping: 0,
      fulfillment_type: null,
      items: [
        { line_index: 0, sku: 'c-sku', name: 'Eggs, 24 ct\nlarge', quantity: 2, unit_price: 9.99, line_total: 19.98, category_native: null },
      ],
    },
  ];
}

test('csvField escapes commas, quotes, and newlines per RFC 4180', () => {
  assert.equal(csvField('plain'), 'plain');
  assert.equal(csvField('a,b'), '"a,b"');
  assert.equal(csvField('say "hi"'), '"say ""hi"""');
  assert.equal(csvField('line1\nline2'), '"line1\nline2"');
  assert.equal(csvField(null), '');
  assert.equal(csvField(undefined), '');
  assert.equal(csvField(0), '0');
});

test('serializeOrdersCsv writes header, item_count, and blank for null', () => {
  const csv = serializeOrdersCsv(sampleOrders());
  const lines = csv.trimEnd().split('\r\n');
  assert.equal(lines[0], 'retailer,order_channel,order_id,account_hint,ordered_at,total,subtotal,tax,shipping,fulfillment_type,item_count');
  assert.ok(lines[1].startsWith('target,online,900000000000001,me@example.com,'));
  assert.ok(lines[1].endsWith(',ShipToHome,2'), 'item_count = 2');
  // costco row
  assert.ok(lines[2].startsWith('costco,in_warehouse,C-1,,'));
});

test('serializeItemsCsv flattens items and quotes tricky fields', () => {
  const csv = serializeItemsCsv(sampleOrders());
  const lines = csv.trimEnd().split('\r\n');
  assert.equal(lines[0], 'retailer,order_channel,order_id,line_index,sku,name,quantity,unit_price,line_total,category_native,category_label');
  assert.equal(lines.length, 1 + 3, 'header + 3 item rows');
  assert.ok(csv.includes('"Paper Towels, 6 ""Mega"" Rolls"'));
  assert.ok(csv.includes('"Eggs, 24 ct\nlarge"'));
});

test('items CSV includes order_channel and a Costco department label', () => {
  const orders = [
    {
      retailer: 'costco',
      order_channel: 'in_warehouse',
      order_id: 'W-1',
      items: [
        { line_index: 0, sku: '1', name: 'VET RX', quantity: 1, unit_price: 9, line_total: 9, category_native: '92' },
        { line_index: 1, sku: '2', name: 'Mystery', quantity: 1, unit_price: 3, line_total: 3, category_native: '777' },
      ],
    },
  ];
  const lines = serializeItemsCsv(orders).trimEnd().split('\r\n');
  assert.ok(lines[1].startsWith('costco,in_warehouse,W-1,'), 'channel present on item rows');
  assert.ok(lines[1].endsWith(',92,Pharmacy'), 'known dept mapped to name');
  assert.ok(lines[2].endsWith(',777,Dept 777'), 'unknown dept falls back to Dept N');
});

test('Target category_label passes the dpci code through (no Costco map)', () => {
  const orders = [
    { retailer: 'target', order_channel: 'online', order_id: 'T-1', items: [{ line_index: 0, sku: 't', name: 'x', category_native: '037' }] },
  ];
  const row = serializeItemsCsv(orders).trimEnd().split('\r\n')[1];
  assert.ok(row.endsWith(',037,037'), 'target dpci code passes through as label');
});

test('items CSV guards formula injection in text but not numeric fields', () => {
  const orders = [
    {
      retailer: 'costco',
      order_id: 'C-9',
      items: [
        {
          line_index: 0,
          sku: '1',
          name: '=HYPERLINK("evil")',
          quantity: 1,
          unit_price: -5.49, // refund — must stay numeric, not quoted with '
          line_total: -5.49,
          category_native: null,
        },
      ],
    },
  ];
  const csv = serializeItemsCsv(orders);
  const row = csv.trimEnd().split('\r\n')[1];
  // name neutralized with a leading apostrophe (then RFC-quoted for the paren/quote)
  assert.ok(csv.includes(`"'=HYPERLINK(""evil"")"`), 'formula-leading name is prefixed with apostrophe');
  // negative price is untouched
  assert.ok(row.includes(',-5.49,-5.49,'), 'negative numeric fields are not altered');
});

test('retailer filter limits rows', () => {
  const orders = sampleOrders();
  assert.equal(serializeOrdersCsv(orders, 'costco').trimEnd().split('\r\n').length, 2); // header + 1
  assert.equal(serializeItemsCsv(orders, 'target').trimEnd().split('\r\n').length, 3); // header + 2
});

test('export is deterministic / idempotent for the same input', () => {
  const orders = sampleOrders();
  assert.equal(serializeOrdersCsv(orders), serializeOrdersCsv(orders));
  assert.equal(serializeItemsCsv(orders), serializeItemsCsv(orders));
  const a = serializeFullJson(orders, undefined, '2026-05-22T00:00:00Z');
  const b = serializeFullJson(orders, undefined, '2026-05-22T00:00:00Z');
  assert.equal(a, b);
});

test('buildFullExport carries schema_version, exported_at, and raw orders', () => {
  const orders = sampleOrders();
  const out = buildFullExport(orders, undefined, '2026-05-22T00:00:00Z');
  assert.equal(out.schema_version, 1);
  assert.equal(out.exported_at, '2026-05-22T00:00:00Z');
  assert.equal(out.orders.length, 2);
  assert.equal(buildFullExport(orders, 'target', 'x').orders.length, 1);
});
