// Costco warehouse POS department codes -> human labels.
//
// Costco does NOT publish these. This map was inferred from the item
// descriptions on real receipts (see the order_items CSV: category_native is
// the raw code, next to the item names). Treat it as best-effort and adjust
// freely — labels are applied at export time, so editing here + re-exporting
// updates them with no re-scan. Unknown codes fall back to "Dept <n>".
export const COSTCO_DEPARTMENTS = {
  '0': 'Deposits & Fees', // bottle deposits, adjustments
  '12': 'Snacks & Candy', // bars, chips, popcorn, pretzels, gummies
  '13': 'Dry Grocery', // pasta, bread, condiments, coffee, oil, canned
  '14': 'Sundries & Household', // paper goods, trash bags, cleaning, soda, pet food
  '16': 'Beer & Alcohol',
  '17': 'Dairy & Refrigerated', // milk, eggs, butter, yogurt, cheese
  '18': 'Frozen',
  '19': 'Deli (Prepared)', // refrigerated prepared meals, lasagna, sausage
  '20': 'Health & Beauty', // razors, deodorant, body wash, diapers, supplements
  '23': 'Seasonal & Hardware', // storage, lighting, outdoor
  '24': 'Electronics',
  '26': 'Sporting Goods', // gloves, life vests, outdoor gear
  '31': 'Apparel', // adult clothing + shoes
  '32': 'Housewares', // kitchen/cookware
  '34': 'Domestics', // linens, bath, bedding, rugs
  '36': 'Books',
  '38': 'Toys',
  '39': 'Kids & Infant Apparel',
  '44': 'Licensed Apparel', // NFL/team gear
  '61': 'Meat',
  '62': 'Bakery',
  '63': 'Service Deli & Rotisserie',
  '65': 'Produce',
  '92': 'Pharmacy', // Rx
  '93': 'Health & OTC', // OTC meds, vitamins, contact solution
  '94': 'Optical',
  '95': 'Membership & Services', // e.g. Gold Star renewal
};

export function costcoDepartmentLabel(code) {
  if (code == null || code === '') return '';
  return COSTCO_DEPARTMENTS[String(code)] ?? `Dept ${code}`;
}
