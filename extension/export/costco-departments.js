// Costco warehouse POS department codes -> human labels.
//
// Costco does NOT publish these, so this is a best-effort, grow-as-you-go map.
// The order_items CSV shows `category_native` (the raw code) next to
// `category_label` and the item names — so when you see an unmapped "Dept N",
// look at the items in it and add an entry here, then re-export (labels are
// applied at export time, no re-scan needed).
//
// Seeded only with what real receipts confirm; everything else falls back to
// "Dept <n>".
export const COSTCO_DEPARTMENTS = {
  '92': 'Pharmacy', // observed on a receipt: "VET. RX"
};

export function costcoDepartmentLabel(code) {
  if (code == null || code === '') return '';
  return COSTCO_DEPARTMENTS[String(code)] ?? `Dept ${code}`;
}
