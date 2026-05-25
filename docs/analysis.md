# Downstream analysis (DuckDB)

The extension only **captures + exports**. Turning line items into category-level
spend is downstream and out of the extension's scope (see ADR-003). This is a
working DuckDB recipe for that step.

The key move is **proportional allocation of the authoritative order total across
line categories** — line items don't reconcile to the order total (tax,
shipping, promos, loyalty discounts apply at the order level), so we distribute
the authoritative total across categories in proportion to their line subtotals.

## Run

Export CSVs from the popup (per store), then from the folder containing them:

```sh
duckdb
```

```sql
-- 1. Load (globs grab both retailers; union_by_name tolerates column drift).
CREATE OR REPLACE VIEW items  AS SELECT * FROM read_csv('order_items_*_*.csv', header=true, union_by_name=true);
CREATE OR REPLACE VIEW orders AS SELECT * FROM read_csv('orders_*_*.csv',      header=true, union_by_name=true);

-- 2. Net line subtotal per order x category. Instant-savings discounts net in
--    because they carry the same category and a negative line_total.
CREATE OR REPLACE VIEW order_category AS
SELECT retailer, order_channel, order_id,
       coalesce(nullif(category_label,''), nullif(category_native,''), 'Uncategorized') AS category,
       sum(line_total) AS cat_line_total
FROM items
GROUP BY ALL;

-- 3. Allocate the order's authoritative total proportionally across categories.
CREATE OR REPLACE VIEW category_spend AS
WITH line_sums AS (SELECT retailer, order_id, sum(line_total) AS line_sum FROM items GROUP BY ALL)
SELECT oc.retailer, oc.order_channel, oc.order_id,
       CAST(o.ordered_at AS TIMESTAMPTZ) AS ordered_at,
       oc.category,
       o.total AS authoritative_total,            -- swap for the Simplifi amount once joined
       CASE WHEN ls.line_sum = 0 THEN 0
            ELSE o.total * oc.cat_line_total / ls.line_sum END AS allocated
FROM order_category oc
JOIN orders    o  USING (retailer, order_id)
JOIN line_sums ls USING (retailer, order_id);

-- 4. Monthly category rollup.
SELECT date_trunc('month', ordered_at) AS month, retailer, order_channel, category,
       round(sum(allocated), 2) AS spend
FROM category_spend
GROUP BY ALL
ORDER BY month, spend DESC;
```

## Notes (from real exported data)

- **Authoritative total:** step 3 uses `orders.total`. The intended design is to
  **swap in Simplifi's transaction amount** — join `orders` to Simplifi by
  `retailer` + a date window (`ordered_at` vs the transaction date) + amount
  (`orders.total` ≈ the Simplifi amount); one Simplifi transaction ↔ one order.
  Allocating against Simplifi's authoritative total absorbs the line-vs-total
  gap.
- **Discounts net automatically** (same category, negative `line_total`), so
  category subtotals are net. For gross product lines add `WHERE is_adjustment = 'false'`.
- **Adjustments** (`is_adjustment = 'true'`): `discount` / `deposit` / `fee`.
  Filter them out, or keep them (they net correctly within a category).
- **Returns** are negative-total orders → negative `allocated` (correctly reduce
  spend).
- **`line_sum = 0` guard** handles orders where every line is 0 (e.g. a fully
  returned/price-adjusted item).
- **`line_total` is authoritative per line** — not `unit_price * quantity`.
  Costco weighed items (price per lb) and fixed-price warehouse lines don't
  multiply cleanly.
- **Timestamps** carry tz offsets, hence `TIMESTAMPTZ`.
- **Categories:** `category_label` is the human label (Costco dept map +
  Target dpci passthrough); `category_native` is the raw code if you'd rather
  group by code. Unmapped Costco depts show `Dept <n>` — fill them in
  `extension/export/costco-departments.js` and re-export (no re-scan).
- **Full fidelity:** the JSON export (`order_history_<retailer>_<stamp>.json`)
  has the raw payloads if you need fields not in the CSVs.
