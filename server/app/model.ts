// server/app/model.ts — the "Forecasting ML job" task: fit, backtest, register and score a demand
// forecast from the silver/gold tables. Deliberately small and explainable (a few hundred lines a
// planner's analyst could read), with two learned parts:
//   • Winter apparel and travel goods: daily units ~ a + b × loyalty members departing in 2–10 days
//     (cold destinations for apparel, any destination for travel goods), fitted per store × category.
//   • Fresh and ambient: a recent level × week shape × last year's seasonality with promotions
//     removed × (1 − γ × share of households away), with γ fitted across stores.
// Accuracy is measured on the last full week (trained only on data before it) against the
// spreadsheet method planners use today: last year's same days + 3%.
import { sql } from '../lib/db';
import { addDays, isoDow, range, toDay } from './dates';
import { AS_OF, SCHEMA as S, UC } from './scenario';

interface Product {
  sku: string;
  category: string;
}
interface Store {
  store_id: string;
  households: number;
}
interface Booking {
  store_id: string;
  cold: boolean;
  depart: number;
  ret: number;
  booked: number;
}
interface Data {
  products: Product[];
  stores: Store[];
  units: Map<string, number>;
  promo: Map<string, number>;
  bookings: Booking[];
}
export interface Forecast {
  store_id: string;
  sku: string;
  date: string;
  f: number;
}

const key = (store: string, sku: string, date: string) => `${store}|${sku}|${date}`;
const DRIVEN = new Set(['Winter apparel', 'Travel']);

async function load(): Promise<Data> {
  const products = (await sql(`SELECT sku, category FROM ${S}.silver_ref_products ORDER BY sku`)).map((r) => ({
    sku: String(r.sku),
    category: String(r.category),
  }));
  const stores = (await sql(`SELECT store_id, households FROM ${S}.silver_ref_stores ORDER BY store_id`)).map((r) => ({
    store_id: String(r.store_id),
    households: Number(r.households),
  }));
  const units = new Map<string, number>();
  const promo = new Map<string, number>();
  for (const r of await sql(
    `SELECT biz_date::text AS d, store_id, sku, units_sold, promo_uplift_pct FROM ${S}.silver_store_sku_day`
  )) {
    units.set(key(String(r.store_id), String(r.sku), String(r.d)), Number(r.units_sold));
    const p = Number(r.promo_uplift_pct);
    if (p) promo.set(`${String(r.sku)}|${String(r.d)}`, p);
  }
  const bookings = (
    await sql(
      `SELECT store_id, cold_destination, depart_date::text AS dep, return_date::text AS ret,
              extract(epoch FROM booked_at)::float8 AS booked
       FROM ${S}.silver_travel_bookings`
    )
  ).map((r) => ({
    store_id: String(r.store_id),
    cold: r.cold_destination === true,
    depart: toDay(String(r.dep)),
    ret: toDay(String(r.ret)),
    booked: Number(r.booked),
  }));
  return { products, stores, units, promo, bookings };
}

interface Features {
  cold: Map<string, number>;
  all: Map<string, number>;
  away: Map<string, number>;
}

/** Travel features per store × day, using only bookings known at 06:00 on the origin date. */
function travelFeatures(data: Data, origin: string, from: string, to: string): Features {
  const cutoff = Date.parse(`${origin}T06:00:00+08:00`) / 1000;
  const lo = toDay(from);
  const hi = toDay(to);
  const f: Features = { cold: new Map(), all: new Map(), away: new Map() };
  const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);
  for (const b of data.bookings) {
    if (b.booked > cutoff) continue;
    for (let d = Math.max(lo, b.depart - 10); d <= Math.min(hi, b.depart - 2); d++) {
      bump(f.all, `${b.store_id}|${d}`);
      if (b.cold) bump(f.cold, `${b.store_id}|${d}`);
    }
    for (let d = Math.max(lo, b.depart); d <= Math.min(hi, b.ret - 1); d++) bump(f.away, `${b.store_id}|${d}`);
  }
  return f;
}
const feat = (m: Map<string, number>, store: string, date: string) => m.get(`${store}|${toDay(date)}`) ?? 0;

function ols(xs: number[], ys: number[]): { a: number; b: number } {
  const n = xs.length;
  if (n < 3) return { a: ys.reduce((s, y) => s + y, 0) / Math.max(n, 1), b: 0 };
  const mx = xs.reduce((s, x) => s + x, 0) / n;
  const my = ys.reduce((s, y) => s + y, 0) / n;
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) ** 2;
  }
  const b = sxx > 0 ? sxy / sxx : 0;
  return { a: my - b * mx, b };
}

interface Fitted {
  forecasts: Forecast[];
  params: Record<string, unknown>;
  trainRows: number;
}

/** Fit on the 56 days before `origin` and forecast `horizon` days from `origin`. */
function fitAndForecast(data: Data, origin: string, horizon: number): Fitted {
  const trainFrom = addDays(origin, -56);
  const trainDays = range(trainFrom, addDays(origin, -1)).filter((d) =>
    data.units.has(key(data.stores[0].store_id, data.products[0].sku, d))
  );
  const recent = trainDays.filter((d) => d >= addDays(origin, -28));
  const horizonDays = range(origin, addDays(origin, horizon - 1));
  const feats = travelFeatures(data, origin, trainFrom, addDays(origin, horizon));
  const cats = [...new Set(data.products.map((p) => p.category))];
  const skusOf = (c: string) => data.products.filter((p) => p.category === c).map((p) => p.sku);
  const u = (s: string, sku: string, d: string) => data.units.get(key(s, sku, d)) ?? 0;
  const catUnits = (s: string, c: string, d: string) => skusOf(c).reduce((a, sku) => a + u(s, sku, d), 0);

  // Week shape per category: each day against its centred 7-day average (so a rising season does
  // not leak into the weekday factors), pooled over stores.
  const dow: Record<string, number[]> = {};
  for (const c of cats) {
    const sum = Array<number>(8).fill(0);
    const cnt = Array<number>(8).fill(0);
    for (const s of data.stores)
      for (let i = 3; i < trainDays.length - 3; i++) {
        const win = trainDays.slice(i - 3, i + 4).reduce((a, d) => a + catUnits(s.store_id, c, d), 0) / 7;
        if (win <= 0) continue;
        sum[isoDow(trainDays[i])] += catUnits(s.store_id, c, trainDays[i]) / win;
        cnt[isoDow(trainDays[i])] += 1;
      }
    const raw = sum.map((v, i) => (cnt[i] ? v / cnt[i] : 1));
    const mean = raw.slice(1).reduce((a, v) => a + v, 0) / 7 || 1;
    dow[c] = raw.map((v) => v / mean);
  }

  const forecasts: Forecast[] = [];
  const params: Record<string, unknown> = { origin, horizon_days: horizon, train_days: trainDays.length };
  const driverFit: Record<string, Record<string, { a: number; b: number }>> = {};
  const gamma: Record<string, number> = {};

  for (const c of cats) {
    const skus = skusOf(c);
    if (DRIVEN.has(c)) {
      const driver = c === 'Winter apparel' ? feats.cold : feats.all;
      driverFit[c] = {};
      for (const s of data.stores) {
        const xs = trainDays.map((d) => feat(driver, s.store_id, d));
        const ys = trainDays.map((d) => catUnits(s.store_id, c, d) / dow[c][isoDow(d)]);
        const { a, b } = ols(xs, ys);
        const fit = { a, b: Math.max(0, b) };
        driverFit[c][s.store_id] = fit;
        const total = recent.reduce((acc, d) => acc + catUnits(s.store_id, c, d), 0) || 1;
        for (const sku of skus) {
          const w = recent.reduce((acc, d) => acc + u(s.store_id, sku, d), 0) / total;
          for (const d of horizonDays) {
            const level = Math.max(0, fit.a + fit.b * feat(driver, s.store_id, d));
            forecasts.push({ store_id: s.store_id, sku, date: d, f: level * dow[c][isoDow(d)] * w });
          }
        }
      }
    } else {
      // γ: how much demand falls per unit share of households away, pooled across stores.
      const xs: number[] = [];
      const ys: number[] = [];
      for (const s of data.stores) {
        const base =
          recent.reduce((a, d) => a + catUnits(s.store_id, c, d) / dow[c][isoDow(d)], 0) / Math.max(recent.length, 1);
        if (base <= 0) continue;
        for (const d of trainDays) {
          xs.push(feat(feats.away, s.store_id, d) / s.households);
          ys.push(catUnits(s.store_id, c, d) / (dow[c][isoDow(d)] * base));
        }
      }
      const g = Math.min(3, Math.max(0, -ols(xs, ys).b));
      gamma[c] = g;
      // Last year's shape for this category with promotions taken out, relative to the matching 4 weeks.
      const lyAdj = (d: string) => {
        const ly = addDays(d, -364);
        let total = 0;
        for (const s of data.stores)
          for (const sku of skus) total += u(s.store_id, sku, ly) / (1 + (data.promo.get(`${sku}|${ly}`) ?? 0) / 100);
        return total / dow[c][isoDow(d)];
      };
      const lyBase = recent.reduce((a, d) => a + lyAdj(d), 0) / Math.max(recent.length, 1);
      const season = (d: string) => (lyBase > 0 ? lyAdj(d) / lyBase : 1);
      for (const s of data.stores) {
        const awayShare = (d: string) => feat(feats.away, s.store_id, d) / s.households;
        for (const sku of skus) {
          const denom = recent.reduce((a, d) => a + dow[c][isoDow(d)] * season(d) * (1 - g * awayShare(d)), 0);
          const level = recent.reduce((a, d) => a + u(s.store_id, sku, d), 0) / (denom || 1);
          for (const d of horizonDays) {
            const f = level * dow[c][isoDow(d)] * season(d) * Math.max(0, 1 - g * awayShare(d));
            forecasts.push({ store_id: s.store_id, sku, date: d, f });
          }
        }
      }
    }
  }
  params.week_shape = Object.fromEntries(
    Object.entries(dow).map(([c, v]) => [c, v.slice(1).map((x) => +x.toFixed(3))])
  );
  params.travel_fit = Object.fromEntries(
    Object.entries(driverFit).map(([c, m]) => [
      c,
      Object.fromEntries(
        Object.entries(m).map(([s, f]) => [s, { intercept: +f.a.toFixed(2), per_departure: +f.b.toFixed(4) }])
      ),
    ])
  );
  params.away_elasticity = Object.fromEntries(Object.entries(gamma).map(([c, g]) => [c, +g.toFixed(3)]));
  return { forecasts, params, trainRows: trainDays.length * data.stores.length * data.products.length };
}

async function bulkInsert(table: string, cols: string[], types: string[], rows: unknown[][]): Promise<void> {
  if (rows.length === 0) return;
  const arrays = cols.map((_, i) => rows.map((r) => r[i]));
  const sel = types.map((t, i) => `$${i + 1}::${t}[]`).join(', ');
  await sql(`INSERT INTO ${S}.${table} (${cols.join(', ')}) SELECT * FROM unnest(${sel})`, arrays);
}

export async function train(runId: number): Promise<Record<string, unknown>> {
  const data = await load();
  const catOf = new Map(data.products.map((p) => [p.sku, p.category]));

  // 1 · Backtest: train on everything before the last full week, forecast that week, compare.
  const btOrigin = addDays(AS_OF, -7);
  const bt = fitAndForecast(data, btOrigin, 7);
  const rows: unknown[][] = [];
  const week = new Map<string, { a: number; f: number; s: number; c: string }>();
  const rel: Record<string, number[]> = {};
  for (const r of bt.forecasts) {
    const a = data.units.get(key(r.store_id, r.sku, r.date)) ?? 0;
    const sheet = (data.units.get(key(r.store_id, r.sku, addDays(r.date, -364))) ?? 0) * 1.03;
    rows.push([r.store_id, r.sku, r.date, a, +r.f.toFixed(2), +sheet.toFixed(2)]);
    const k = `${r.store_id}|${r.sku}`;
    const w = week.get(k) ?? { a: 0, f: 0, s: 0, c: catOf.get(r.sku) ?? '' };
    w.a += a;
    w.f += r.f;
    w.s += sheet;
    week.set(k, w);
    const c = catOf.get(r.sku) ?? '';
    if (r.f >= 1) (rel[c] ??= []).push((a - r.f) / r.f);
  }
  await bulkInsert(
    'ml_backtest',
    ['store_id', 'sku', 'biz_date', 'actual', 'forecast', 'spreadsheet'],
    ['text', 'text', 'date', 'int', 'numeric', 'numeric'],
    rows
  );

  const wape = (pick: (w: { a: number; f: number; s: number }) => number, filter?: string) => {
    let err = 0;
    let act = 0;
    for (const w of week.values()) {
      if (filter && w.c !== filter) continue;
      err += Math.abs(w.a - pick(w));
      act += w.a;
    }
    return act > 0 ? (100 * err) / act : 0;
  };
  const totA = [...week.values()].reduce((s, w) => s + w.a, 0);
  const totF = [...week.values()].reduce((s, w) => s + w.f, 0);
  const cats = [...new Set(data.products.map((p) => p.category))];
  const byCategory = Object.fromEntries(
    cats.map((c) => [c, { model: +wape((w) => w.f, c).toFixed(1), spreadsheet: +wape((w) => w.s, c).toFixed(1) }])
  );
  const cv = Object.fromEntries(
    cats.map((c) => {
      const xs = rel[c] ?? [];
      const m = xs.reduce((s, x) => s + x, 0) / Math.max(xs.length, 1);
      const sd = Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(xs.length - 1, 1));
      return [c, Math.min(0.6, Math.max(0.08, sd))];
    })
  );
  const metrics = {
    wape: +wape((w) => w.f).toFixed(1),
    wape_spreadsheet: +wape((w) => w.s).toFixed(1),
    bias: +((100 * (totF - totA)) / Math.max(totA, 1)).toFixed(1),
    backtest_week: `${btOrigin} to ${addDays(AS_OF, -1)}`,
    grain: 'store × SKU × week',
    by_category: byCategory,
    interval_cv: Object.fromEntries(Object.entries(cv).map(([c, v]) => [c, +v.toFixed(3)])),
  };

  // 2 · Drift on the main driver: cold-destination departures, last week vs the weeks before.
  const f = travelFeatures(data, AS_OF, addDays(AS_OF, -56), addDays(AS_OF, -1));
  const daily = (from: number, to: number) => {
    const ds = range(addDays(AS_OF, from), addDays(AS_OF, to));
    return ds.reduce((s, d) => s + data.stores.reduce((a, st) => a + feat(f.cold, st.store_id, d), 0), 0) / ds.length;
  };
  const before = daily(-56, -8);
  const last = daily(-7, -1);
  const ratio = before > 0 ? last / before : 1;
  const drift = {
    feature: 'cold_departures_next10',
    baseline_mean: +before.toFixed(1),
    last_week_mean: +last.toFixed(1),
    ratio: +ratio.toFixed(2),
    status: ratio > 1.5 || ratio < 0.67 ? 'shifted: retrained this run' : 'stable',
  };

  // 3 · Production fit: train on the 56 days to yesterday and score the next 14 days.
  const prod = fitAndForecast(data, AS_OF, 14);
  const [v] = await sql(`SELECT coalesce(max(version), 0) + 1 AS v FROM ${S}.ml_model_registry`);
  const version = Number(v?.v ?? 1);
  const z = 1.2816;
  await bulkInsert(
    'ml_forecast',
    ['store_id', 'sku', 'biz_date', 'forecast', 'p10', 'p90', 'model_version'],
    ['text', 'text', 'date', 'numeric', 'numeric', 'numeric', 'int'],
    prod.forecasts.map((r) => {
      const c = cv[catOf.get(r.sku) ?? ''] ?? 0.2;
      return [
        r.store_id,
        r.sku,
        r.date,
        +r.f.toFixed(2),
        +(r.f * Math.max(0, 1 - z * c)).toFixed(2),
        +(r.f * (1 + z * c)).toFixed(2),
        version,
      ];
    })
  );
  await sql(`UPDATE ${S}.ml_model_registry SET stage = 'Archived' WHERE stage = 'Production'`);
  await sql(
    `INSERT INTO ${S}.ml_model_registry (version, model_name, run_id, train_rows, params, metrics, stage)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, 'Production')`,
    [version, UC.model, runId, prod.trainRows, JSON.stringify(prod.params), JSON.stringify({ ...metrics, drift })]
  );
  await sql(`SELECT setval(pg_get_serial_sequence('${S}.ml_model_registry', 'version'), $1)`, [version]);

  return {
    model: UC.model,
    version,
    train_rows: prod.trainRows,
    features: [
      'cold-destination departures (2–10 days)',
      'all departures',
      'households away',
      'week shape',
      'last year ex-promotion',
    ],
    metrics,
    drift,
    forecast_rows: prod.forecasts.length,
    horizon_days: 14,
  };
}
