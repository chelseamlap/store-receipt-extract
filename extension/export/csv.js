// export/csv.js — pure serializers: orders + line items to RFC 4180 CSV.
// String functions are unit-tested; the *Blob wrappers are thin conveniences
// for the popup. No third-party imports.

const ORDER_COLUMNS = [
  'retailer',
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
  'order_id',
  'line_index',
  'sku',
  'name',
  'quantity',
  'unit_price',
  'line_total',
  'category_native',
];

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
        o.order_id,
        o.account_hint,
        o.ordered_at,
        o.total,
        o.subtotal,
        o.tax,
        o.shipping,
        o.fulfillment_type,
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
      rows.push(
        csvRow([
          o.retailer,
          o.order_id,
          item.line_index,
          item.sku,
          item.name,
          item.quantity,
          item.unit_price,
          item.line_total,
          item.category_native,
        ])
      );
    }
  }
  return rows.join('\r\n') + '\r\n';
}

export function ordersCsvBlob(orders, retailer) {
  return new Blob([serializeOrdersCsv(orders, retailer)], { type: 'text/csv' });
}

export function itemsCsvBlob(orders, retailer) {
  return new Blob([serializeItemsCsv(orders, retailer)], { type: 'text/csv' });
}
