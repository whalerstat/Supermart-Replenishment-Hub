// server/app/schema.ts — Lakebase DDL and the deterministic seed for the four SOURCE systems only.
// The medallion (bronze → silver → gold), the forecast and the agent's signals start empty: the
// pipeline on Screen 1 builds them from the sources (server/app/pipeline.ts).
import { commonDdl } from '../lib/common';
import { AS_OF, SCHEMA, dowSql, noiseSql, yearEndSql } from './scenario';

export { SCHEMA };
const S = SCHEMA;

export const DDL = `
DROP SCHEMA IF EXISTS ${S} CASCADE;
CREATE SCHEMA ${S};

-- ── Source 1 · Managed Postgres (Lakebase): store POS and store ordering ──────────────────────
CREATE TABLE ${S}.src_pg_pos_sales (
  sale_date DATE NOT NULL, store_id TEXT NOT NULL, sku TEXT NOT NULL,
  units INT NOT NULL, net_sales NUMERIC(12,2) NOT NULL, loaded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE ${S}.src_pg_store_orders (
  po_id TEXT NOT NULL, line_no INT NOT NULL, store_id TEXT NOT NULL, supplier_id TEXT NOT NULL, sku TEXT NOT NULL,
  qty INT NOT NULL, delivery_date DATE NOT NULL, status TEXT NOT NULL, basis TEXT, created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL, PRIMARY KEY (po_id, line_no)
);

-- ── Source 2 · Managed relational databases (Lakehouse): ERP master data, history, documents ──
CREATE TABLE ${S}.src_lh_stores (
  store_id TEXT PRIMARY KEY, store_name TEXT NOT NULL, region TEXT NOT NULL, manager_name TEXT NOT NULL,
  manager_email TEXT NOT NULL, households INT NOT NULL, scale NUMERIC(4,2) NOT NULL
);
CREATE TABLE ${S}.src_lh_products (
  sku TEXT PRIMARY KEY, product_name TEXT NOT NULL, category TEXT NOT NULL, unit_cost NUMERIC(8,2) NOT NULL,
  unit_price NUMERIC(8,2) NOT NULL, case_pack INT NOT NULL, shelf_life_days INT, supplier_id TEXT NOT NULL,
  base_units NUMERIC(8,2) NOT NULL
);
CREATE TABLE ${S}.src_lh_suppliers (
  supplier_id TEXT PRIMARY KEY, supplier_name TEXT NOT NULL, lead_time_days INT NOT NULL, contact_email TEXT NOT NULL
);
CREATE TABLE ${S}.src_lh_sales_history (
  sale_date DATE NOT NULL, store_id TEXT NOT NULL, sku TEXT NOT NULL, units INT NOT NULL, net_sales NUMERIC(12,2) NOT NULL
);
CREATE TABLE ${S}.src_lh_promotions (
  promo_id TEXT PRIMARY KEY, promo_name TEXT NOT NULL, category TEXT NOT NULL,
  start_date DATE NOT NULL, end_date DATE NOT NULL, uplift_pct NUMERIC(5,1) NOT NULL, status TEXT NOT NULL
);
CREATE TABLE ${S}.src_lh_dc_stock (dc_id TEXT NOT NULL, sku TEXT NOT NULL, available_qty INT NOT NULL, PRIMARY KEY (dc_id, sku));
CREATE TABLE ${S}.src_lh_documents (
  clause_id TEXT PRIMARY KEY, doc_title TEXT NOT NULL, clause_title TEXT NOT NULL, body TEXT NOT NULL, applies_to TEXT NOT NULL
);

-- ── Sources 3 and 4 · SaaS platforms via real-time APIs (raw JSON messages as received) ───────
CREATE TABLE ${S}.src_api_stock (msg_id BIGSERIAL PRIMARY KEY, received_at TIMESTAMPTZ NOT NULL, payload JSONB NOT NULL);
CREATE TABLE ${S}.src_api_customer (msg_id BIGSERIAL PRIMARY KEY, received_at TIMESTAMPTZ NOT NULL, payload JSONB NOT NULL);

-- ── Medallion: one bronze, one core silver (+ conformed reference tables), one core gold ─────
CREATE TABLE ${S}.bronze_raw_events (
  id BIGSERIAL PRIMARY KEY, run_id INT NOT NULL, source_system TEXT NOT NULL, source_object TEXT NOT NULL,
  payload JSONB NOT NULL, ingested_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE ${S}.silver_store_sku_day (
  biz_date DATE NOT NULL, store_id TEXT NOT NULL, sku TEXT NOT NULL, units_sold INT NOT NULL,
  net_sales NUMERIC(12,2) NOT NULL, promo_uplift_pct NUMERIC(5,1) NOT NULL DEFAULT 0, source_system TEXT NOT NULL,
  PRIMARY KEY (biz_date, store_id, sku)
);
CREATE TABLE ${S}.silver_stock_position (
  store_id TEXT NOT NULL, sku TEXT NOT NULL, on_hand INT NOT NULL, counted_at TIMESTAMPTZ NOT NULL, PRIMARY KEY (store_id, sku)
);
CREATE TABLE ${S}.silver_travel_bookings (
  booking_id TEXT PRIMARY KEY, store_id TEXT NOT NULL, member_key TEXT NOT NULL, destination TEXT NOT NULL,
  cold_destination BOOLEAN NOT NULL, depart_date DATE NOT NULL, return_date DATE NOT NULL, booked_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE ${S}.silver_store_orders (
  po_id TEXT NOT NULL, line_no INT NOT NULL, store_id TEXT NOT NULL, supplier_id TEXT NOT NULL, sku TEXT NOT NULL,
  qty INT NOT NULL, delivery_date DATE NOT NULL, status TEXT NOT NULL, basis TEXT, created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL, PRIMARY KEY (po_id, line_no)
);
CREATE TABLE ${S}.silver_ref_products (LIKE ${S}.src_lh_products);
CREATE TABLE ${S}.silver_ref_stores (LIKE ${S}.src_lh_stores);
CREATE TABLE ${S}.silver_ref_suppliers (LIKE ${S}.src_lh_suppliers);
CREATE TABLE ${S}.silver_ref_promotions (LIKE ${S}.src_lh_promotions);
CREATE TABLE ${S}.silver_ref_dc_stock (LIKE ${S}.src_lh_dc_stock);
CREATE TABLE ${S}.silver_quarantine (
  id BIGSERIAL PRIMARY KEY, run_id INT NOT NULL, source_object TEXT NOT NULL, rule TEXT NOT NULL, payload JSONB NOT NULL
);
CREATE TABLE ${S}.gold_replenishment_position (
  store_id TEXT NOT NULL, store_name TEXT NOT NULL, sku TEXT NOT NULL, product_name TEXT NOT NULL, category TEXT NOT NULL,
  on_hand INT NOT NULL, open_po_qty INT NOT NULL, next_delivery DATE, avg_daily_7d NUMERIC(10,2) NOT NULL,
  avg_daily_28d NUMERIC(10,2) NOT NULL, ly_next_14d INT NOT NULL, days_of_cover NUMERIC(10,1),
  cold_departures_next10 INT NOT NULL, unit_cost NUMERIC(8,2) NOT NULL, unit_price NUMERIC(8,2) NOT NULL,
  case_pack INT NOT NULL, shelf_life_days INT, supplier_id TEXT NOT NULL, PRIMARY KEY (store_id, sku)
);
CREATE TABLE ${S}.gold_store_travel_daily (
  store_id TEXT NOT NULL, biz_date DATE NOT NULL, cold_departures_next10 INT NOT NULL, departures_next10 INT NOT NULL,
  members_away INT NOT NULL, PRIMARY KEY (store_id, biz_date)
);
CREATE TABLE ${S}.gold_knowledge_clauses (
  clause_id TEXT PRIMARY KEY, doc_title TEXT NOT NULL, clause_title TEXT NOT NULL, body TEXT NOT NULL, applies_to TEXT NOT NULL
);

-- ── Machine learning: registry, forecast, backtest ───────────────────────────────────────────
CREATE TABLE ${S}.ml_model_registry (
  version SERIAL PRIMARY KEY, model_name TEXT NOT NULL, run_id INT NOT NULL, trained_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  train_rows INT NOT NULL, params JSONB NOT NULL, metrics JSONB NOT NULL, stage TEXT NOT NULL
);
CREATE TABLE ${S}.ml_forecast (
  store_id TEXT NOT NULL, sku TEXT NOT NULL, biz_date DATE NOT NULL, forecast NUMERIC(10,2) NOT NULL,
  p10 NUMERIC(10,2) NOT NULL, p90 NUMERIC(10,2) NOT NULL, model_version INT NOT NULL, PRIMARY KEY (store_id, sku, biz_date)
);
CREATE TABLE ${S}.ml_backtest (
  store_id TEXT NOT NULL, sku TEXT NOT NULL, biz_date DATE NOT NULL, actual INT NOT NULL,
  forecast NUMERIC(10,2) NOT NULL, spreadsheet NUMERIC(10,2) NOT NULL, PRIMARY KEY (store_id, sku, biz_date)
);

-- ── Agent: signals, recommendations, runs ────────────────────────────────────────────────────
CREATE TABLE ${S}.pipeline_runs (
  run_id SERIAL PRIMARY KEY, started_at TIMESTAMPTZ NOT NULL DEFAULT now(), finished_at TIMESTAMPTZ,
  status TEXT NOT NULL, triggered_by TEXT NOT NULL, stats JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE TABLE ${S}.agent_signals (
  signal_id TEXT PRIMARY KEY, run_id INT NOT NULL, kind TEXT NOT NULL, store_id TEXT NOT NULL, title TEXT NOT NULL,
  severity TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'awaiting decision', payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE ${S}.agent_recommendations (
  rec_id TEXT PRIMARY KEY, signal_id TEXT NOT NULL REFERENCES ${S}.agent_signals(signal_id) ON DELETE CASCADE,
  rank INT NOT NULL, payload JSONB NOT NULL, status TEXT NOT NULL DEFAULT 'proposed', draft JSONB,
  decided_by TEXT, decided_at TIMESTAMPTZ
);
${commonDdl(S)}
`;

const dow = dowSql;
const ye = yearEndSql;

export const SEED = `
INSERT INTO ${S}.src_lh_stores VALUES
  ('CHG', 'Changi City',      'East',       'Daniel Tan',   'daniel.tan@harmonimart.example',   2200, 1.00),
  ('TMP', 'Tampines Central', 'East',       'Siti Rahman',  'siti.rahman@harmonimart.example',  2600, 1.25),
  ('JUR', 'Jurong East',      'West',       'Arun Pillai',  'arun.pillai@harmonimart.example',  3200, 1.15),
  ('BIS', 'Bishan',           'Central',    'Grace Lim',    'grace.lim@harmonimart.example',    2400, 0.90),
  ('WDL', 'Woodlands North',  'North',      'Marcus Ong',   'marcus.ong@harmonimart.example',   2600, 0.95),
  ('PUN', 'Punggol',          'North-East', 'Koh Hui Min',  'huimin.koh@harmonimart.example',   2800, 1.05);

INSERT INTO ${S}.src_lh_products VALUES
  ('APP-101', 'Thermal down jacket',        'Winter apparel', 32.00, 79.90,  6, NULL, 'SUP-NPK', 0.50),
  ('APP-102', 'Thermal base-layer top',     'Winter apparel',  7.50, 19.90, 12, NULL, 'SUP-NPK', 1.00),
  ('APP-103', 'Fleece-lined gloves',        'Winter apparel',  4.20, 12.90, 12, NULL, 'SUP-NPK', 0.70),
  ('APP-104', 'Knit beanie',                'Winter apparel',  3.10,  9.90, 12, NULL, 'SUP-NPK', 0.50),
  ('TRV-201', 'Cabin luggage 20-inch',      'Travel',         38.00, 89.00,  4, NULL, 'SUP-TRV', 0.25),
  ('TRV-202', 'Universal travel adapter',   'Travel',          9.00, 24.90, 10, NULL, 'SUP-TRV', 0.60),
  ('FRS-301', 'Baby bok choy 300 g',        'Fresh',           0.95,  1.95, 20,    4, 'SUP-GRN', 120),
  ('FRS-302', 'Korean strawberries 250 g',  'Fresh',           4.10,  7.90, 12,    5, 'SUP-GRN', 45),
  ('FRS-303', 'Salmon fillet 200 g',        'Fresh',           5.20,  9.50, 10,    3, 'SUP-GRN', 55),
  ('FRS-304', 'Fresh whole chicken 1.2 kg', 'Fresh',           4.80,  8.90,  8,    4, 'SUP-PLT', 60),
  ('FRS-305', 'Mixed salad leaves 150 g',   'Fresh',           1.60,  3.50, 15,    4, 'SUP-GRN', 50),
  ('GRO-401', 'Jasmine rice 5 kg',          'Ambient',         7.40, 13.90,  4, NULL, 'SUP-AMB', 12);

INSERT INTO ${S}.src_lh_suppliers VALUES
  ('SUP-NPK', 'NorthPeak Outdoor Apparel', 5, 'orders@northpeak.example'),
  ('SUP-TRV', 'Wayfarer Travel Goods',     7, 'orders@wayfarer.example'),
  ('SUP-GRN', 'Greenleaf Fresh Co.',       2, 'orders@greenleaf.example'),
  ('SUP-PLT', 'Sunrise Poultry',           2, 'orders@sunrisepoultry.example'),
  ('SUP-AMB', 'Golden Grain Trading',      6, 'orders@goldengrain.example');

INSERT INTO ${S}.src_lh_promotions VALUES
  ('PRM-2512-FF', 'Year-end Fresh Fest',       'Fresh', '2025-12-26', '2026-01-01', 45.0, 'completed'),
  ('PRM-2702-FF', 'Lunar New Year Fresh Fest', 'Fresh', '2027-02-10', '2027-02-16', 40.0, 'planned');

INSERT INTO ${S}.src_lh_dc_stock VALUES
  ('JDC', 'APP-101', 180), ('JDC', 'APP-102', 420), ('JDC', 'APP-103', 300), ('JDC', 'APP-104', 260),
  ('JDC', 'TRV-201', 60),  ('JDC', 'TRV-202', 240), ('JDC', 'GRO-401', 900);

INSERT INTO ${S}.src_lh_documents VALUES
  ('NPK-4.2', 'NorthPeak supply agreement 2026', '§4.2 Expedited DC pick',
   'Orders of two or more case packs per line can be picked from the Harmoni Jurong DC and delivered to store within 48 hours. Expedited freight is charged at 6% of the order cost.', 'Winter apparel'),
  ('NPK-4.5', 'NorthPeak supply agreement 2026', '§4.5 Standard replenishment',
   'Standard orders are delivered in 5 days, in full case packs: jackets in packs of 6, all other lines in packs of 12.', 'Winter apparel'),
  ('OPS-7.3', 'Harmoni store operations playbook', '§7.3 Inter-store transfers',
   'Transfers between stores travel on the DC shuttle and arrive the next day. The donor store must keep at least 21 days of cover after the transfer. Handling is S$0.60 per unit plus S$120 per shuttle run.', 'All'),
  ('OPS-2.4', 'Harmoni store operations playbook', '§2.4 Approval thresholds',
   'Any new or changed order above S$2,000, or a change of more than 30% to an order line, is confirmed by the store manager before it is placed.', 'All'),
  ('GRN-3.1', 'Greenleaf Fresh supply agreement 2026', '§3.1 Order amendments',
   'Purchase order quantities can be amended until 14:00 on the second business day before delivery. Public holidays are not business days.', 'Fresh'),
  ('GRN-3.4', 'Greenleaf Fresh supply agreement 2026', '§3.4 Split deliveries',
   'Orders above S$1,500 can be split across two delivery days at no extra charge with 24 hours'' notice.', 'Fresh'),
  ('FRS-2.1', 'Harmoni fresh ordering policy', '§2.1 Order to forecast',
   'Order fresh lines to forecast plus half a day of safety stock, and never more than the product can sell within its shelf life.', 'Fresh'),
  ('CDP-1.0', 'Customer data platform metric definitions', 'Cold-destination departures',
   'Loyalty members with a confirmed flight to Japan, Korea, northern China or Europe departing in the next 2 to 10 days. Member identities are hashed before analysis.', 'Winter apparel'),
  ('PRM-1.2', 'Harmoni promotions calendar notes', 'Year-end Fresh Fest moved',
   'The Year-end Fresh Fest that ran from 26 December 2025 to 1 January 2026 moves to Lunar New Year in 2027. There is no fresh promotion in the 2026 year-end week.', 'Fresh');

-- Travel bookings from the customer behaviour platform (generated once, then published as API messages).
CREATE TABLE ${S}._seed_bookings AS
WITH n AS (SELECT * FROM (VALUES ('CHG', 1500), ('TMP', 1100), ('JUR', 420), ('BIS', 480), ('WDL', 360), ('PUN', 620)) v(store_id, n)),
u AS (
  SELECT n.store_id, i,
         (abs(hashtext(n.store_id || ':' || i || ':p')) % 10000) / 10000.0 AS u1,
         (abs(hashtext(n.store_id || ':' || i || ':d')) % 10000) / 10000.0 AS u2,
         (abs(hashtext(n.store_id || ':' || i || ':c')) % 10000) / 10000.0 AS u3,
         (abs(hashtext(n.store_id || ':' || i || ':r')) % 10000) / 10000.0 AS u4,
         (abs(hashtext(n.store_id || ':' || i || ':k')) % 10000) / 10000.0 AS u5
  FROM n, generate_series(1, n.n) AS i
),
d AS (
  SELECT store_id, i, u3, u4, u5,
         CASE WHEN u1 < 0.15 THEN date '2026-10-20' + floor(u2 * 32)::int
              WHEN u1 < 0.45 THEN date '2026-11-21' + floor(u2 * 28)::int
              WHEN u1 < 0.90 THEN date '2026-12-21' + floor(u2 * 12)::int
              ELSE date '2027-01-02' + floor(u2 * 9)::int END AS depart_date
  FROM u
)
SELECT store_id, i, depart_date,
       depart_date + 4 + floor(u4 * 10)::int AS return_date,
       u3 < (CASE WHEN depart_date >= date '2026-12-01' THEN 0.70 ELSE 0.40 END) AS cold,
       (ARRAY['Tokyo, Japan', 'Tokyo, Japan', 'Seoul, South Korea', 'Seoul, South Korea', 'Sapporo, Japan', 'Osaka, Japan', 'London, UK', 'Zurich, Switzerland'])[1 + floor(u4 * 8)::int] AS cold_dest,
       (ARRAY['Bangkok, Thailand', 'Bali, Indonesia', 'Perth, Australia', 'Phuket, Thailand', 'Kuala Lumpur, Malaysia'])[1 + floor(u4 * 5)::int] AS warm_dest,
       (depart_date - (7 + floor(u5 * 50)::int))::timestamp + make_interval(mins => floor(u4 * 1300)::int) AS booked_at
FROM d;

CREATE TABLE ${S}._seed_travel AS
SELECT st.store_id, g::date AS d, st.households,
       (SELECT count(*) FROM ${S}._seed_bookings b WHERE b.store_id = st.store_id AND b.cold
          AND b.depart_date BETWEEN g::date + 2 AND g::date + 10) AS dep10_cold,
       (SELECT count(*) FROM ${S}._seed_bookings b WHERE b.store_id = st.store_id
          AND b.depart_date BETWEEN g::date + 2 AND g::date + 10) AS dep10_all,
       (SELECT count(*) FROM ${S}._seed_bookings b WHERE b.store_id = st.store_id
          AND b.depart_date <= g::date AND b.return_date > g::date) AS away
FROM ${S}.src_lh_stores st, generate_series(date '2026-10-26', date '2027-01-03', interval '1 day') g;

-- This year's POS sales (26 Oct – 20 Dec 2026), driven by travel bookings, the week shape and year-end.
INSERT INTO ${S}.src_pg_pos_sales (sale_date, store_id, sku, units, net_sales, loaded_at)
SELECT t.d, st.store_id, p.sku, x.units, round(x.units * p.unit_price * 0.97, 2), t.d + time '23:30'
FROM ${S}._seed_travel t
JOIN ${S}.src_lh_stores st ON st.store_id = t.store_id
CROSS JOIN ${S}.src_lh_products p
CROSS JOIN LATERAL (
  SELECT greatest(0, round(
    CASE p.category
      WHEN 'Winter apparel' THEN p.base_units * (0.8 * st.scale + 0.04 * t.dep10_cold)
      WHEN 'Travel'         THEN p.base_units * (0.8 * st.scale + 0.03 * t.dep10_all)
      WHEN 'Fresh'          THEN p.base_units * st.scale * ${ye('t.d')} * (1 - 1.5 * t.away::numeric / st.households)
      ELSE p.base_units * st.scale END
    * ${dow('t.d')} * ${noiseSql(`st.store_id || p.sku || t.d::text`, 0.7, 0.6)}
    * ${noiseSql(`'wk' || st.store_id || p.sku || date_trunc('week', t.d)::date::text`, 0.88, 0.24)}))::int AS units
) x
WHERE t.d <= date '${AS_OF}' - 1;

-- A replayed POS batch: 24 exact duplicates that silver must remove.
INSERT INTO ${S}.src_pg_pos_sales (sale_date, store_id, sku, units, net_sales, loaded_at)
SELECT sale_date, store_id, sku, units, net_sales, loaded_at + interval '2 hours'
FROM ${S}.src_pg_pos_sales WHERE sale_date = date '${AS_OF}' - 1 AND store_id IN ('CHG', 'TMP');

-- Last year's sales from the lakehouse (27 Oct 2025 – 4 Jan 2026): less travel, and the Fresh Fest promotion.
INSERT INTO ${S}.src_lh_sales_history (sale_date, store_id, sku, units, net_sales)
SELECT t.d - 364, st.store_id, p.sku, x.units, round(x.units * p.unit_price * 0.97, 2)
FROM ${S}._seed_travel t
JOIN ${S}.src_lh_stores st ON st.store_id = t.store_id
CROSS JOIN ${S}.src_lh_products p
CROSS JOIN LATERAL (
  SELECT greatest(0, round(
    CASE p.category
      WHEN 'Winter apparel' THEN p.base_units * (0.8 * st.scale + 0.04 * 0.7 * t.dep10_cold)
      WHEN 'Travel'         THEN p.base_units * (0.8 * st.scale + 0.03 * 0.7 * t.dep10_all)
      WHEN 'Fresh'          THEN p.base_units * st.scale * 0.97 * ${ye('(t.d - 364)')}
                                 * (CASE WHEN t.d - 364 BETWEEN date '2025-12-26' AND date '2026-01-01' THEN 1.45 ELSE 1 END)
                                 * (1 - 1.5 * 0.7 * t.away::numeric / st.households)
      ELSE p.base_units * st.scale * 0.97 END
    * ${dow('(t.d - 364)')} * ${noiseSql(`'ly' || st.store_id || p.sku || t.d::text`, 0.7, 0.6)}
    * ${noiseSql(`'lywk' || st.store_id || p.sku || date_trunc('week', t.d)::date::text`, 0.88, 0.24)}))::int AS units
) x;

-- Store purchase orders (store ordering app on Lakebase).
-- Greenleaf year-end orders for delivery Mon 28 Dec, covering 28–31 Dec. Tampines copied last year (+3%).
INSERT INTO ${S}.src_pg_store_orders
SELECT CASE st.store_id WHEN 'TMP' THEN 'PO-7731' ELSE 'PO-77' || (40 + row_number() OVER (PARTITION BY p.sku ORDER BY st.store_id))::text END,
       row_number() OVER (PARTITION BY st.store_id ORDER BY p.sku)::int,
       st.store_id, 'SUP-GRN', p.sku,
       CASE WHEN st.store_id = 'TMP'
            THEN (ceil((SELECT sum(h.units) FROM ${S}.src_lh_sales_history h
                        WHERE h.store_id = st.store_id AND h.sku = p.sku
                          AND h.sale_date BETWEEN date '2025-12-29' AND date '2026-01-01') * 1.03 / p.case_pack) * p.case_pack)::int
            ELSE (ceil(p.base_units * st.scale * 4 * 0.96 / p.case_pack) * p.case_pack)::int END,
       date '2026-12-28', 'submitted',
       CASE WHEN st.store_id = 'TMP' THEN 'Copied from last year''s 29 Dec – 1 Jan order, +3% trend' ELSE 'Planner forecast' END,
       st.manager_name, CASE WHEN st.store_id = 'TMP' THEN timestamptz '2026-12-19 16:42+08' ELSE timestamptz '2026-12-18 10:05+08' END
FROM ${S}.src_lh_stores st CROSS JOIN ${S}.src_lh_products p
WHERE p.supplier_id = 'SUP-GRN';

-- NorthPeak winter apparel orders already in flight. Changi City's next delivery lands after the travel peak.
INSERT INTO ${S}.src_pg_store_orders
SELECT 'PO-' || CASE st.store_id WHEN 'CHG' THEN '7716' WHEN 'TMP' THEN '7712' WHEN 'PUN' THEN '7714' WHEN 'JUR' THEN '7709' WHEN 'BIS' THEN '7710' ELSE '7711' END,
       row_number() OVER (PARTITION BY st.store_id ORDER BY p.sku)::int, st.store_id, 'SUP-NPK', p.sku,
       CASE st.store_id
         WHEN 'CHG' THEN CASE p.sku WHEN 'APP-101' THEN 24 WHEN 'APP-102' THEN 48 WHEN 'APP-103' THEN 36 ELSE 24 END
         WHEN 'TMP' THEN CASE p.sku WHEN 'APP-101' THEN 72 WHEN 'APP-102' THEN 156 WHEN 'APP-103' THEN 108 ELSE 72 END
         WHEN 'PUN' THEN CASE p.sku WHEN 'APP-101' THEN 36 WHEN 'APP-102' THEN 72 WHEN 'APP-103' THEN 48 ELSE 36 END
         ELSE CASE p.sku WHEN 'APP-101' THEN 12 ELSE 24 END END,
       CASE st.store_id WHEN 'CHG' THEN date '2026-12-28' WHEN 'TMP' THEN date '2026-12-22' WHEN 'PUN' THEN date '2026-12-22' ELSE date '2027-01-05' END,
       'confirmed', 'Season plan', st.manager_name, timestamptz '2026-12-14 09:20+08'
FROM ${S}.src_lh_stores st CROSS JOIN ${S}.src_lh_products p
WHERE p.supplier_id = 'SUP-NPK';

-- Stock API: 12 snapshots per store × SKU over the last 48 hours (every 4 h), as raw JSON messages.
CREATE TABLE ${S}._seed_onhand AS
WITH rate AS (
  SELECT store_id, sku, avg(units)::numeric AS avg7
  FROM ${S}.src_pg_pos_sales WHERE sale_date >= date '${AS_OF}' - 7 GROUP BY store_id, sku
)
SELECT r.store_id, r.sku, r.avg7,
       CASE
         WHEN r.store_id = 'CHG' AND r.sku = 'APP-101' THEN 9
         WHEN r.store_id = 'CHG' AND r.sku = 'APP-102' THEN 22
         WHEN r.store_id = 'CHG' AND r.sku = 'APP-103' THEN 15
         WHEN r.store_id = 'CHG' AND r.sku = 'APP-104' THEN 18
         WHEN p.category = 'Fresh' THEN round(r.avg7 * 1.2)
         WHEN p.category = 'Winter apparel' AND r.store_id IN ('JUR', 'BIS', 'WDL') THEN round(r.avg7 * (24 + abs(hashtext(r.store_id || r.sku)) % 4))
         WHEN p.category = 'Winter apparel' THEN round(r.avg7 * (5 + abs(hashtext(r.store_id || r.sku)) % 3))
         ELSE round(r.avg7 * (16 + abs(hashtext(r.store_id || r.sku)) % 10))
       END::int AS on_hand
FROM rate r JOIN ${S}.src_lh_products p ON p.sku = r.sku;

INSERT INTO ${S}.src_api_stock (received_at, payload)
SELECT ts, jsonb_build_object(
         'store', o.store_id, 'sku', o.sku, 'on_hand', o.on_hand + round(o.avg7 * k * 4 / 24.0)::int,
         'location', 'floor+backroom', 'counted_at', to_char(ts AT TIME ZONE 'Asia/Singapore', 'YYYY-MM-DD"T"HH24:MI:SS"+08:00"'))
FROM ${S}._seed_onhand o, generate_series(0, 11) k,
     LATERAL (SELECT timestamptz '${AS_OF} 06:00+08' - make_interval(hours => 4 * k) AS ts) t
ORDER BY ts;

INSERT INTO ${S}.src_api_stock (received_at, payload) VALUES
  (timestamptz '${AS_OF} 05:12+08', '{"store": "CHG", "sku": "APP-999", "on_hand": 40, "location": "floor+backroom", "counted_at": "${AS_OF}T05:12:00+08:00"}'),
  (timestamptz '${AS_OF} 05:14+08', '{"store": "TMP", "sku": "APP-999", "on_hand": 12, "location": "floor+backroom", "counted_at": "${AS_OF}T05:14:00+08:00"}'),
  (timestamptz '${AS_OF} 05:20+08', '{"store": "PUN", "sku": "TRV-299", "on_hand": 7, "location": "floor+backroom", "counted_at": "${AS_OF}T05:20:00+08:00"}'),
  (timestamptz '${AS_OF} 06:30+08', '{"store": "JUR", "sku": "FRS-301", "on_hand": -4, "location": "floor+backroom", "counted_at": "${AS_OF}T06:30:00+08:00"}'),
  (timestamptz '${AS_OF} 06:31+08', '{"store": "BIS", "sku": "FRS-305", "on_hand": -11, "location": "floor+backroom", "counted_at": "${AS_OF}T06:31:00+08:00"}');

-- Customer behaviour API: one message per travel booking, as received (with the member's e-mail).
INSERT INTO ${S}.src_api_customer (received_at, payload)
SELECT least((b.booked_at + interval '3 minutes') AT TIME ZONE 'Asia/Singapore', timestamptz '${AS_OF} 06:00+08'), jsonb_build_object(
         'event_id', 'evt_' || b.store_id || '_' || lpad(b.i::text, 5, '0'),
         'event_type', 'flight_booking',
         'member_id', 'M-' || b.store_id || '-' || lpad(b.i::text, 5, '0'),
         'member_email', 'member' || lower(b.store_id) || b.i || '@mail.example',
         'home_store', b.store_id,
         'destination', CASE WHEN b.cold THEN b.cold_dest ELSE b.warm_dest END,
         'climate', CASE WHEN b.cold THEN 'cold' ELSE 'warm' END,
         'depart_date', b.depart_date, 'return_date', b.return_date,
         'booked_at', to_char(b.booked_at, 'YYYY-MM-DD"T"HH24:MI:SS"+08:00"'))
FROM ${S}._seed_bookings b
WHERE b.booked_at <= timestamp '${AS_OF} 06:00'
ORDER BY b.booked_at;

-- Two messages stamped in the future (device clock skew) that silver must quarantine.
INSERT INTO ${S}.src_api_customer (received_at, payload) VALUES
  (timestamptz '${AS_OF} 05:58+08', '{"event_id": "evt_CHG_X0001", "event_type": "flight_booking", "member_id": "M-CHG-X0001", "member_email": "skew1@mail.example", "home_store": "CHG", "destination": "Tokyo, Japan", "climate": "cold", "depart_date": "2026-12-26", "return_date": "2027-01-03", "booked_at": "2027-03-01T09:00:00+08:00"}'),
  (timestamptz '${AS_OF} 05:59+08', '{"event_id": "evt_TMP_X0002", "event_type": "flight_booking", "member_id": "M-TMP-X0002", "member_email": "skew2@mail.example", "home_store": "TMP", "destination": "Seoul, South Korea", "climate": "cold", "depart_date": "2026-12-27", "return_date": "2027-01-04", "booked_at": "2027-02-11T10:00:00+08:00"}');

DROP TABLE ${S}._seed_onhand;
DROP TABLE ${S}._seed_travel;
DROP TABLE ${S}._seed_bookings;
`;
