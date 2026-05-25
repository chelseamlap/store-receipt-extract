// export/csv.js — pure serializers: orders + line items to RFC 4180 CSV.
// No third-party imports.

import { costcoDepartmentLabel } from './costco-departments.js';
import { classifyAdjustment } from '../content/common.js';

const ORDER_COLUMNS = [
  'retailer',
  'order_channel',
  'order_id',
  'account_hint',
  'ordered_at',
  'total',
  'subtotal',
  'tax',
  'shipping',
  'fulfillment_type',
  'item_count',
];

const ITEM_COLUMNS = [
  'retailer',
  'order_channel',
  'order_id',
  'line_index',
  'sku',
  'name',
  'quantity',
  'unit_price',
  'line_total',
  'category_native',
  'category_label',
  'is_adjustment',
  'adjustment_reason',
];

// Human label for category_native: Costco dept codes -> names; otherwise the
// raw value (Target's dpci department code) passes through.
function categoryLabel(retailer, code) {
  return retailer === 'costco' ? costcoDepartmentLabel(code) : code;
}

// RFC 4180: quote fields containing comma, quote, CR or LF; double embedded
// quotes. null/undefined -> empty field.
export function csvField(value) {
  if (value === null || value === undefined) return '';
  const s = String(value);
  if (/[",\r\n]/.test(s)) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

// Guard free-text fields against spreadsheet formula injection: a value that
// opens with =,+,-,@ (or whitespace control chars) can execute as a formula in
// Excel/Sheets. Prefix with an apostrophe so it's treated as literal text.
// Applied only to text columns (names, categories) — never to numeric columns,
// so legitimate negatives like -5.49 stay numeric.
function safeText(value) {
  if (typeof value === 'string' && /^[=+\-@\t\r]/.test(value)) return `'${value}`;
  return value;
}

function csvRow(values) {
  return values.map(csvField).join(',');
}

function filterByRetailer(orders, retailer) {
  return retailer ? orders.filter((o) => o.retailer === retailer) : orders;
}

export function serializeOrdersCsv(orders, retailer) {
  const rows = [csvRow(ORDER_COLUMNS)];
  for (const o of filterByRetailer(orders, retailer)) {
    rows.push(
      csvRow([
        o.retailer,
        o.order_channel,
        o.order_id,
        safeText(o.account_hint),
        o.ordered_at,
        o.total,
        o.subtotal,
        o.tax,
        o.shipping,
        safeText(o.fulfillment_type),
        Array.isArray(o.items) ? o.items.length : 0,
      ])
    );
  }
  return rows.join('\r\n') + '\r\n';
}

export function serializeItemsCsv(orders, retailer) {
  const rows = [csvRow(ITEM_COLUMNS)];
  for (const o of filterByRetailer(orders, retailer)) {
    for (const item of o.items || []) {
      const reason = classifyAdjustment(item.name);
      rows.push(
        csvRow([
          o.retailer,
          o.order_channel,
          o.order_id,
          item.line_index,
          item.sku,
          safeText(item.name),
          item.quantity,
          item.unit_price,
          item.line_total,
          safeText(item.category_native),
          safeText(categoryLabel(o.retailer, item.category_native)),
          reason ? 'true' : 'false',
          reason ?? '',
        ])
      );
    }
  }
  return rows.join('\r\n') + '\r\n';
}
