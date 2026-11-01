// server/app/pipeline.ts — the job behind Screen 1. Five tasks, run in order:
//   ingest  → three sources land as raw JSON in bronze (one table, tagged by source system)
//   silver  → parse, conform, de-duplicate, quarantine bad rows, hash member identities
//   gold    → one replenishment position per store × SKU, travel features, knowledge clauses
//   train   → fit and backtest the demand forecast, register a new model version, score 14 days
//   publish → let the agent raise signals and recommendations for Agent Decisions
// In production this is a Lakeflow job over Delta tables in Unity Catalog; the app runs the same
// steps as SQL against Lakebase so it works in any workspace with no extra setup.
import { sql } from '../lib/db';
import { publish } from './agent';
import { RUN_MINUTES, TASK_MINUTES, shapeRun, type HistoryRun } from './history';
import { train } from './model';
import { AS_OF, SCHEMA as S, UC } from './scenario';

export const TASKS = ['ingest', 'silver', 'gold', 'train', 'publish'] as const;
export type TaskId = (typeof TASKS)[number];

type Stats = Record<string, unknown>;

async function count(text: string, params: unknown[] = []): Promise<number> {
  const [row] = await sql(text, params);
  return Number(row?.n ?? 0);
}

/** INSERT … SELECT wrapped so it returns the number of rows written. */
async function insertCount(insert: string, params: unknown[] = []): Promise<number> {
  return count(`WITH ins AS (${insert} RETURNING 1) SELECT count(*)::int AS n FROM ins`, params);
}

export async function startRun(actor: string): Promise<number> {
  // Only one run goes at a time (routes/api.ts), so a run still marked running was abandoned.
  await sql(`UPDATE ${S}.pipeline_runs SET status = 'failed', finished_at = now() WHERE status = 'running'`);
  const [row] = await sql(
    `INSERT INTO ${S}.pipeline_runs (status, triggered_by) VALUES ('running', $1) RETURNING run_id`,
    [actor]
  );
  return Number(row?.run_id);
}

async function saveTask(runId: number, task: TaskId, stats: Stats, done = false): Promise<void> {
  await sql(
    `UPDATE ${S}.pipeline_runs
     SET stats = stats || jsonb_build_object($2::text, $3::jsonb)
                 || CASE WHEN $4 THEN jsonb_build_object('duration_min', $5::int) ELSE '{}'::jsonb END,
         status = CASE WHEN $4 THEN 'succeeded' ELSE status END,
         finished_at = CASE WHEN $4 THEN now() ELSE finished_at END
     WHERE run_id = $1`,
    [runId, task, JSON.stringify(stats), done, RUN_MINUTES]
  );
}

export async function failRun(runId: number, task: string, message: string): Promise<void> {
  await sql(
    `UPDATE ${S}.pipeline_runs SET status = 'failed', finished_at = now(),
       stats = stats || jsonb_build_object('error', jsonb_build_object('task', $2::text, 'message', $3::text))
     WHERE run_id = $1`,
    [runId, task, message]
  );
}

// ── ingest ────────────────────────────────────────────────────────────────────────────────────
// The raw source spans two systems (Postgres and relational); they stay separate here so bronze keeps exact lineage.
const SOURCES: { system: string; label: string; objects: { object: string; from: string }[] }[] = [
  {
    system: 'managed_postgres',
    label: 'Managed Postgres',
    objects: [
      { object: 'pos.daily_sales', from: `${S}.src_pg_pos_sales` },
      { object: 'ordering.store_orders', from: `${S}.src_pg_store_orders` },
    ],
  },
  {
    system: 'managed_relational',
    label: 'Managed relational databases',
    objects: [
      { object: 'erp.stores', from: `${S}.src_lh_stores` },
      { object: 'erp.products', from: `${S}.src_lh_products` },
      { object: 'erp.suppliers', from: `${S}.src_lh_suppliers` },
      { object: 'erp.sales_history', from: `${S}.src_lh_sales_history` },
      { object: 'merch.promotions', from: `${S}.src_lh_promotions` },
      { object: 'scm.dc_stock', from: `${S}.src_lh_dc_stock` },
      { object: 'docs.agreements_and_policies', from: `${S}.src_lh_documents` },
    ],
  },
  {
    system: 'saas_stock_api',
    label: 'Stock API',
    objects: [{ object: 'stock/v2/positions', from: `${S}.src_api_stock` }],
  },
  {
    system: 'saas_customer_api',
    label: 'Customer behaviour API',
    objects: [{ object: 'cdp/v1/travel-events', from: `${S}.src_api_customer` }],
  },
];

async function ingest(runId: number): Promise<Stats> {
  // A run rebuilds the foundation from the sources, so the downstream tables start empty.
  await sql(`TRUNCATE ${S}.bronze_raw_events, ${S}.silver_store_sku_day, ${S}.silver_stock_position,
    ${S}.silver_travel_bookings, ${S}.silver_store_orders, ${S}.silver_ref_products, ${S}.silver_ref_stores,
    ${S}.silver_ref_suppliers, ${S}.silver_ref_promotions, ${S}.silver_ref_dc_stock, ${S}.silver_quarantine,
    ${S}.gold_replenishment_position, ${S}.gold_store_travel_daily, ${S}.gold_knowledge_clauses,
    ${S}.ml_forecast, ${S}.ml_backtest, ${S}.agent_recommendations, ${S}.agent_signals`);
  const sources: { system: string; label: string; rows: number; objects: { object: string; rows: number }[] }[] = [];
  for (const src of SOURCES) {
    const objects: { object: string; rows: number }[] = [];
    for (const o of src.objects) {
      // API messages are already JSON: land the payload as received. Tables land as one JSON row each.
      const payload = o.from.includes('src_api_') ? 't.payload' : 'to_jsonb(t)';
      const rows = await insertCount(
        `INSERT INTO ${S}.bronze_raw_events (run_id, source_system, source_object, payload)
         SELECT $1, $2, $3, ${payload} FROM ${o.from} t`,
        [runId, src.system, o.object]
      );
      objects.push({ object: o.object, rows });
    }
    sources.push({ system: src.system, label: src.label, rows: objects.reduce((a, o) => a + o.rows, 0), objects });
  }
  return {
    table: UC.bronze,
    rows: sources.reduce((a, s) => a + s.rows, 0),
    sources,
    note: 'Raw JSON as received, tagged with source system, object and load time',
  };
}

// ── silver ────────────────────────────────────────────────────────────────────────────────────
const bronze = (object: string) => `${S}.bronze_raw_events b WHERE b.source_object = '${object}'`;

async function silver(runId: number): Promise<Stats> {
  const ref: [string, string][] = [
    ['silver_ref_stores', 'erp.stores'],
    ['silver_ref_products', 'erp.products'],
    ['silver_ref_suppliers', 'erp.suppliers'],
    ['silver_ref_promotions', 'merch.promotions'],
    ['silver_ref_dc_stock', 'scm.dc_stock'],
  ];
  for (const [table, object] of ref) {
    await sql(`INSERT INTO ${S}.${table}
               SELECT r.* FROM ${S}.bronze_raw_events b
               CROSS JOIN LATERAL jsonb_populate_record(NULL::${S}.${table}, b.payload) r
               WHERE b.source_object = '${object}'`);
  }

  // Core entity: one row per product × store × day, this year (Managed Postgres POS) and last year (Lakehouse).
  const salesRaw = await count(
    `SELECT count(*)::int AS n FROM ${S}.bronze_raw_events WHERE source_object IN ('pos.daily_sales', 'erp.sales_history')`
  );
  const core = await insertCount(`
    INSERT INTO ${S}.silver_store_sku_day (biz_date, store_id, sku, units_sold, net_sales, promo_uplift_pct, source_system)
    SELECT DISTINCT ON (r.d, r.store_id, r.sku) r.d, r.store_id, r.sku, r.units, r.net_sales,
           coalesce((SELECT pr.uplift_pct FROM ${S}.silver_ref_promotions pr
                     JOIN ${S}.silver_ref_products p ON p.category = pr.category
                     WHERE p.sku = r.sku AND r.d BETWEEN pr.start_date AND pr.end_date LIMIT 1), 0),
           r.source_system
    FROM (
      SELECT (b.payload->>'sale_date')::date AS d, b.payload->>'store_id' AS store_id, b.payload->>'sku' AS sku,
             (b.payload->>'units')::int AS units, (b.payload->>'net_sales')::numeric AS net_sales, b.source_system
      FROM ${S}.bronze_raw_events b
      WHERE b.source_object IN ('pos.daily_sales', 'erp.sales_history')
    ) r
    WHERE r.sku IN (SELECT sku FROM ${S}.silver_ref_products) AND r.units >= 0
    ORDER BY r.d, r.store_id, r.sku`);

  // Stock API: quarantine unknown SKUs and negative counts, keep the latest valid count per store × SKU.
  const badSku = await insertCount(
    `INSERT INTO ${S}.silver_quarantine (run_id, source_object, rule, payload)
     SELECT $1, b.source_object, 'valid_sku', b.payload FROM ${bronze('stock/v2/positions')}
       AND b.payload->>'sku' NOT IN (SELECT sku FROM ${S}.silver_ref_products)`,
    [runId]
  );
  const negative = await insertCount(
    `INSERT INTO ${S}.silver_quarantine (run_id, source_object, rule, payload)
     SELECT $1, b.source_object, 'non_negative_stock', b.payload FROM ${bronze('stock/v2/positions')}
       AND b.payload->>'sku' IN (SELECT sku FROM ${S}.silver_ref_products) AND (b.payload->>'on_hand')::int < 0`,
    [runId]
  );
  const stockMsgs = await count(`SELECT count(*)::int AS n FROM ${bronze('stock/v2/positions')}`);
  const positions = await insertCount(`
    INSERT INTO ${S}.silver_stock_position (store_id, sku, on_hand, counted_at)
    SELECT DISTINCT ON (b.payload->>'store', b.payload->>'sku')
           b.payload->>'store', b.payload->>'sku', (b.payload->>'on_hand')::int, (b.payload->>'counted_at')::timestamptz
    FROM ${bronze('stock/v2/positions')}
      AND b.payload->>'sku' IN (SELECT sku FROM ${S}.silver_ref_products) AND (b.payload->>'on_hand')::int >= 0
    ORDER BY b.payload->>'store', b.payload->>'sku', (b.payload->>'counted_at')::timestamptz DESC`);

  // Customer behaviour API: drop e-mail, hash the member id, quarantine events stamped in the future.
  const loadCutoff = `timestamptz '${AS_OF} 06:00+08'`;
  const future = await insertCount(
    `INSERT INTO ${S}.silver_quarantine (run_id, source_object, rule, payload)
     SELECT $1, b.source_object, 'no_future_events', b.payload FROM ${bronze('cdp/v1/travel-events')}
       AND (b.payload->>'booked_at')::timestamptz > ${loadCutoff}`,
    [runId]
  );
  const bookings = await insertCount(`
    INSERT INTO ${S}.silver_travel_bookings
    SELECT b.payload->>'event_id', b.payload->>'home_store',
           encode(sha256(convert_to(b.payload->>'member_id', 'UTF8')), 'hex'),
           b.payload->>'destination', b.payload->>'climate' = 'cold',
           (b.payload->>'depart_date')::date, (b.payload->>'return_date')::date, (b.payload->>'booked_at')::timestamptz
    FROM ${bronze('cdp/v1/travel-events')} AND (b.payload->>'booked_at')::timestamptz <= ${loadCutoff}`);

  const orders = await insertCount(`
    INSERT INTO ${S}.silver_store_orders
    SELECT r.* FROM ${S}.bronze_raw_events b
    CROSS JOIN LATERAL jsonb_populate_record(NULL::${S}.silver_store_orders, b.payload) r
    WHERE b.source_object = 'ordering.store_orders'`);

  const duplicates = salesRaw - core;
  const expectations = [
    {
      rule: 'One row per product × store × day',
      table: 'store_sku_day',
      failed: duplicates,
      action: 'Duplicates dropped (replayed POS batch)',
    },
    { rule: 'SKU exists in the product master', table: 'stock positions', failed: badSku, action: 'Quarantined' },
    { rule: 'Stock count is not negative', table: 'stock positions', failed: negative, action: 'Quarantined' },
    { rule: 'Event is not stamped in the future', table: 'travel bookings', failed: future, action: 'Quarantined' },
    {
      rule: 'Latest count per store × SKU',
      table: 'stock positions',
      failed: 0,
      action: `${stockMsgs} messages → ${positions} positions`,
    },
    {
      rule: 'Member identity hashed, e-mail dropped',
      table: 'travel bookings',
      failed: 0,
      action: `${bookings} members masked`,
    },
  ];
  return {
    table: UC.silver,
    rows: core,
    related: [
      { table: 'supermart.silver.stock_position', rows: positions },
      { table: 'supermart.silver.travel_bookings', rows: bookings },
      { table: 'supermart.silver.store_orders', rows: orders },
    ],
    expectations,
    quarantined: badSku + negative + future,
    duplicates,
    masked: bookings,
  };
}

// ── gold ──────────────────────────────────────────────────────────────────────────────────────
async function gold(): Promise<Stats> {
  const travel = await insertCount(`
    INSERT INTO ${S}.gold_store_travel_daily
    SELECT st.store_id, g::date,
      (SELECT count(*) FROM ${S}.silver_travel_bookings b WHERE b.store_id = st.store_id AND b.cold_destination
         AND b.depart_date BETWEEN g::date + 2 AND g::date + 10),
      (SELECT count(*) FROM ${S}.silver_travel_bookings b WHERE b.store_id = st.store_id
         AND b.depart_date BETWEEN g::date + 2 AND g::date + 10),
      (SELECT count(*) FROM ${S}.silver_travel_bookings b WHERE b.store_id = st.store_id
         AND b.depart_date <= g::date AND b.return_date > g::date)
    FROM ${S}.silver_ref_stores st,
         generate_series(date '${AS_OF}' - 56, date '${AS_OF}' + 13, interval '1 day') g`);

  const position = await insertCount(`
    INSERT INTO ${S}.gold_replenishment_position
    SELECT st.store_id, st.store_name, p.sku, p.product_name, p.category,
           coalesce(sp.on_hand, 0), coalesce(po.qty, 0), po.next_delivery,
           round(coalesce(s7.avg7, 0), 2), round(coalesce(s28.avg28, 0), 2), coalesce(ly.units, 0),
           CASE WHEN s7.avg7 > 0 THEN round(coalesce(sp.on_hand, 0) / s7.avg7, 1) END,
           coalesce(tr.cold_departures_next10, 0),
           p.unit_cost, p.unit_price, p.case_pack, p.shelf_life_days, p.supplier_id
    FROM ${S}.silver_ref_stores st
    CROSS JOIN ${S}.silver_ref_products p
    LEFT JOIN ${S}.silver_stock_position sp ON sp.store_id = st.store_id AND sp.sku = p.sku
    LEFT JOIN LATERAL (
      SELECT sum(o.qty)::int AS qty, min(o.delivery_date) AS next_delivery FROM ${S}.silver_store_orders o
      WHERE o.store_id = st.store_id AND o.sku = p.sku AND o.delivery_date >= date '${AS_OF}'
        AND o.status IN ('submitted', 'confirmed')) po ON true
    LEFT JOIN LATERAL (
      SELECT avg(d.units_sold) AS avg7 FROM ${S}.silver_store_sku_day d
      WHERE d.store_id = st.store_id AND d.sku = p.sku AND d.biz_date BETWEEN date '${AS_OF}' - 7 AND date '${AS_OF}' - 1) s7 ON true
    LEFT JOIN LATERAL (
      SELECT avg(d.units_sold) AS avg28 FROM ${S}.silver_store_sku_day d
      WHERE d.store_id = st.store_id AND d.sku = p.sku AND d.biz_date BETWEEN date '${AS_OF}' - 28 AND date '${AS_OF}' - 1) s28 ON true
    LEFT JOIN LATERAL (
      SELECT sum(d.units_sold)::int AS units FROM ${S}.silver_store_sku_day d
      WHERE d.store_id = st.store_id AND d.sku = p.sku AND d.biz_date BETWEEN date '${AS_OF}' - 364 AND date '${AS_OF}' - 351) ly ON true
    LEFT JOIN ${S}.gold_store_travel_daily tr ON tr.store_id = st.store_id AND tr.biz_date = date '${AS_OF}'`);

  const clauses = await insertCount(`
    INSERT INTO ${S}.gold_knowledge_clauses
    SELECT b.payload->>'clause_id', b.payload->>'doc_title', b.payload->>'clause_title', b.payload->>'body', b.payload->>'applies_to'
    FROM ${bronze('docs.agreements_and_policies')}`);

  return {
    table: UC.gold,
    rows: position,
    related: [
      { table: 'supermart.gold.store_travel_daily', rows: travel },
      { table: 'supermart.gold.knowledge_clauses', rows: clauses },
    ],
    grain: 'One row per store × SKU, as of the business date',
  };
}

// ── orchestration ─────────────────────────────────────────────────────────────────────────────
export async function runTask(runId: number, task: TaskId): Promise<Stats> {
  const t0 = Date.now();
  let stats: Stats;
  try {
    if (task === 'ingest') stats = await ingest(runId);
    else if (task === 'silver') stats = await silver(runId);
    else if (task === 'gold') stats = await gold();
    else if (task === 'train') stats = await train(runId);
    else stats = await publish(runId);
  } catch (err) {
    await failRun(runId, task, err instanceof Error ? err.message : String(err)).catch(() => undefined);
    throw err;
  }
  const out = { ...stats, ms: Date.now() - t0, minutes: TASK_MINUTES[task] };
  await saveTask(runId, task, out, task === 'publish');
  return out;
}

/** Newest first: the seeded scheduled runs and every run started from the app. */
export async function runHistory(limit = 6): Promise<HistoryRun[]> {
  const rows = await sql(
    `SELECT run_id, status, triggered_by, stats->>'seeded' AS seeded,
            to_char(started_at AT TIME ZONE 'Asia/Singapore', 'YYYY-MM-DD') AS sgt_date,
            to_char(started_at AT TIME ZONE 'Asia/Singapore', 'HH24:MI:SS') AS sgt_time,
            stats->>'duration_min' AS duration_min,
            coalesce(stats->>'rows_ingested', stats->'ingest'->>'rows') AS rows_ingested
     FROM ${S}.pipeline_runs ORDER BY run_id DESC LIMIT $1`,
    [limit]
  );
  return rows.map(shapeRun);
}

export async function latestRun(): Promise<Record<string, unknown> | null> {
  const [row] = await sql(
    `SELECT run_id, status, triggered_by, stats,
            to_char(started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS started_at,
            to_char(finished_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS finished_at
     FROM ${S}.pipeline_runs WHERE status = 'succeeded' AND stats->>'seeded' IS NULL ORDER BY run_id DESC LIMIT 1`
  );
  return row ?? null;
}
