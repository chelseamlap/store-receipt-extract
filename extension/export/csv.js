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
  'receipt_url',
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
  'fsa_eligible',
  'is_adjustment',
  'adjustment_reason',
  'parent_sku',
];

// Link back to the retailer's order/receipt page, useful for HSA/FSA receipt
// submissions. Derived from retailer + channel + order_id; empty when no per-
// order URL exists (Costco warehouse/gas/car-wash receipts are only viewable
// via the filtered list page).
function receiptUrlFor(order) {
  const id = order?.order_id;
  if (!id) return '';
  if (order.retailer === 'target') {
    return order.order_channel === 'in_store'
      ? `https://www.target.com/orders/stores/${id}`
      : `https://www.target.com/orders/${id}`;
  }
  if (order.retailer === 'costco' && order.order_channel === 'online') {
    return `https://www.costco.com/OrderDetailPrintView?orderId=${id}`;
  }
  return '';
}

// fsa_eligible cell value. true/false render as strings; null/undefined stay
// blank (unknown — currently the case for Target lines and Costco in-warehouse
// receipts, neither of which expose the flag in their APIs).
function fsaCell(value) {
  if (value === true) return 'true';
  if (value === false) return 'false';
  return '';
}

// Costco prints adjustments right after the item they apply to. Discount lines
// usually carry the parent's itemNumber in the name (e.g. "/1218715",
// "/  11357" with variable spacing; deposit lines like "VT BOTTLE DEPST EE/854342"
// too). For nicknamed discounts (e.g. "/ HEAT PANT") we fall back to the
// previous non-adjustment item's sku in the same order. Returns null otherwise.
function findParentSku(name) {
  const m = String(name ?? '').match(/\/\s*(\d+)/);
  return m ? m[1] : null;
}

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
        receiptUrlFor(o),
      ])
    );
  }
  return rows.join('\r\n') + '\r\n';
}

export function serializeItemsCsv(orders, retailer) {
  const rows = [csvRow(ITEM_COLUMNS)];
  for (const o of filterByRetailer(orders, retailer)) {
    let lastProductSku = null; // positional fallback for nicknamed discount lines
    for (const item of o.items || []) {
      const reason = classifyAdjustment(item.name);
      let parentSku = null;
      if (reason) {
        parentSku = findParentSku(item.name) ?? (reason === 'discount' ? lastProductSku : null);
      } else {
        if (item.sku != null) lastProductSku = item.sku;
      }
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
          fsaCell(item.fsa_eligible),
          reason ? 'true' : 'false',
          reason ?? '',
          parentSku ?? '',
        ])
      );
    }
  }
  return rows.join('\r\n') + '\r\n';
}
