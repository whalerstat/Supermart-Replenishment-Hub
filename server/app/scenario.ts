// server/app/scenario.ts — the fixed facts of the demo story (Harmoni Mart, a fictional Singapore grocer).
// The business date is pinned so every number on both screens is reproducible on any day.

export const SCHEMA = 'replen_agent_hub';

/** Business date of the demo: Monday 21 December 2026 (school-holiday travel peak, year-end fresh week). */
export const AS_OF = '2026-12-21';

/** Unity Catalog names shown on screen for the three medallion tables (the demo materialises them in Lakebase). */
export const UC = {
  catalog: 'harmoni',
  bronze: 'harmoni.bronze.raw_events',
  silver: 'harmoni.silver.store_sku_day',
  gold: 'harmoni.gold.replenishment_position',
  model: 'harmoni.ml.replenishment_forecast',
} as const;

export const PLANNING_INBOX = 'replenishment-planning@harmonimart.example';

/** Day-of-week demand shape used by the seed (the model learns its own from the data). */
export function dowSql(d: string): string {
  return `(CASE extract(isodow FROM ${d})::int WHEN 1 THEN 0.92 WHEN 2 THEN 0.90 WHEN 3 THEN 0.95 WHEN 4 THEN 1.00 WHEN 5 THEN 1.08 WHEN 6 THEN 1.18 ELSE 1.12 END)`;
}

/** Year-end cooking bump (Christmas Eve, 30 and 31 December) — present in both years. */
export function yearEndSql(d: string): string {
  return `(CASE to_char(${d}, 'MM-DD') WHEN '12-24' THEN 1.10 WHEN '12-30' THEN 1.08 WHEN '12-31' THEN 1.15 ELSE 1.0 END)`;
}

/** Deterministic noise in [lo, lo + span). */
export function noiseSql(key: string, lo = 0.8, span = 0.4): string {
  return `(${lo} + ${span} * (abs(hashtext(${key})) % 1000) / 1000.0)`;
}
