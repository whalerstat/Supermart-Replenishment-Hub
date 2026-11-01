// server/app/scenario.ts — the fixed facts of the Supermart story (a Singapore grocer, mock data).
// The business date is pinned so every number on both screens is reproducible on any day.

export const SCHEMA = 'supermart_replen';

/** Business date: Monday 7 December 2026 (school-holiday travel peak, mid-December fresh week). */
export const AS_OF = '2026-12-07';

/** Unity Catalog names shown on screen for the three medallion tables (the app materialises them in Lakebase). */
export const UC = {
  catalog: 'supermart',
  bronze: 'supermart.bronze.raw_events',
  silver: 'supermart.silver.store_sku_day',
  gold: 'supermart.gold.replenishment_position',
  model: 'supermart.ml.replenishment_forecast',
} as const;

export const PLANNING_INBOX = 'replenishment-planning@supermart.example';

/** Day-of-week demand shape used by the seed (the model learns its own from the data). */
export function dowSql(d: string): string {
  return `(CASE extract(isodow FROM ${d})::int WHEN 1 THEN 0.92 WHEN 2 THEN 0.90 WHEN 3 THEN 0.95 WHEN 4 THEN 1.00 WHEN 5 THEN 1.08 WHEN 6 THEN 1.18 ELSE 1.12 END)`;
}

/** Deterministic noise in [lo, lo + span). */
export function noiseSql(key: string, lo = 0.8, span = 0.4): string {
  return `(${lo} + ${span} * (abs(hashtext(${key})) % 1000) / 1000.0)`;
}
