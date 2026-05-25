// export/json.js — pure serializer: full-fidelity store dump (incl. raw
// payloads) to one JSON document. No third-party imports.

export const SCHEMA_VERSION = 1;

function filterByRetailer(orders, retailer) {
  return retailer ? orders.filter((o) => o.retailer === retailer) : orders;
}

// Returns the export object. `exportedAt` is injectable so tests are
// deterministic; defaults to now.
export function buildFullExport(orders, retailer, exportedAt) {
  return {
    exported_at: exportedAt ?? new Date().toISOString(),
    schema_version: SCHEMA_VERSION,
    orders: filterByRetailer(orders, retailer),
  };
}

export function serializeFullJson(orders, retailer, exportedAt) {
  return JSON.stringify(buildFullExport(orders, retailer, exportedAt), null, 2);
}
