// server/app/agent.ts — the Replenishment agent. Two jobs:
//   publish()  (last pipeline task): read gold + the forecast, raise the two signals, cost two
//              corrective options for each, and refresh the insights tiles.
//   decisions  (Screen 2): list signals, draft the store-manager e-mail for a chosen option (Claude
//              via the AI Gateway, grounded on gold facts and agreement clauses; template fallback),
//              and on human approval queue the e-mail, write the order back to store ordering
//              (Lakebase) and log the decision.
import { logDecision, queueMessage } from '../lib/common';
import { sql } from '../lib/db';
import { complete, modelService } from '../lib/llm';
import { addDays, label, range, short, toDay } from './dates';
import { AS_OF, PLANNING_INBOX, SCHEMA as S } from './scenario';

// ── shapes (mirrored in client/src/lib/api.ts) ────────────────────────────────────────────────
export interface SeriesPoint {
  date: string;
  actual?: number;
  forecast?: number;
  p10?: number;
  p90?: number;
  stock?: number;
  ly?: number;
  driver?: number;
}
interface Person {
  name: string;
  email: string;
  store: string;
}
interface Line {
  sku: string;
  name: string;
  qty: number;
  current?: number;
  from?: string;
  pack?: number;
  note?: string;
}
interface Impact {
  label: string;
  value: string;
  tone: 'good' | 'cost' | 'neutral';
}
export interface RecPayload {
  kind: 'expedite' | 'transfer' | 'amend' | 'split';
  title: string;
  summary: string;
  action: string;
  eta: string;
  lines: Line[];
  impact: Impact[];
  tradeoffs: string[];
  confidence: string;
  clause_ids: string[];
  recipient: Person;
  terms: string;
  approval: string;
  facts: Record<string, unknown>;
  score: number;
}
export interface SignalPayload {
  kind: 'stockout' | 'excess_po';
  store_id: string;
  category: string;
  store: Person;
  title: string;
  summary: string;
  headline: { label: string; value: string; tone?: 'bad' | 'warn' | 'neutral' }[];
  insight: { title: string; text: string; source: string };
  drivers: { source: string; text: string }[];
  series: SeriesPoint[];
  chart: {
    today: string;
    stockout?: string;
    window?: { from: string; to: string; label: string; perDay?: number };
    driverLabel?: string;
    showStock?: boolean;
    showLy?: boolean;
  };
  lines: { sku: string; name: string; a: string; b: string; c: string }[];
  lineHeads: [string, string, string];
  model_version: number;
}

// ── helpers ───────────────────────────────────────────────────────────────────────────────────
const n = (v: unknown) => Number(v ?? 0);
const s = (v: unknown): string =>
  typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : '';
export const money = (v: number) => `S$${Math.round(v).toLocaleString('en-US')}`;
const units = (v: number) => Math.round(v).toLocaleString('en-US');
const plural = (name: string) => (name.endsWith('s') ? name : `${name}s`);
const ceilTo = (v: number, pack: number) => Math.ceil(Math.max(0, v) / pack) * pack;
/** "28–31 Dec" */
function span(a: string, b: string): string {
  return a.slice(0, 7) === b.slice(0, 7) ? `${+a.slice(8, 10)}–${short(b)}` : `${short(a)} – ${short(b)}`;
}
const HOLIDAYS = new Set(['2026-12-25', '2027-01-01']);

/** The n-th business day before `date` (weekends and public holidays skipped). */
function businessDaysBefore(date: string, count: number): string {
  let d = date;
  let left = count;
  while (left > 0) {
    d = addDays(d, -1);
    const wd = new Date(`${d}T00:00:00Z`).getUTCDay();
    if (wd !== 0 && wd !== 6 && !HOLIDAYS.has(d)) left--;
  }
  return d;
}

interface Pos {
  store_id: string;
  store_name: string;
  sku: string;
  product_name: string;
  category: string;
  on_hand: number;
  avg7: number;
  unit_cost: number;
  unit_price: number;
  case_pack: number;
  supplier_id: string;
}
interface Ctx {
  pos: Pos[];
  fc: Map<string, { f: number; p10: number; p90: number }>;
  arrivals: Map<string, number>;
  orders: Record<string, unknown>[];
  hist: Map<string, number>;
  stores: Map<string, Person & { households: number }>;
  travel: Map<string, { cold: number; all: number; away: number }>;
  dc: Map<string, number>;
  version: number;
  run: number;
}
const k3 = (a: string, b: string, c: string) => `${a}|${b}|${c}`;

async function loadCtx(runId: number): Promise<Ctx> {
  const pos = (await sql(`SELECT * FROM ${S}.gold_replenishment_position ORDER BY store_id, sku`)).map((r) => ({
    store_id: s(r.store_id),
    store_name: s(r.store_name),
    sku: s(r.sku),
    product_name: s(r.product_name),
    category: s(r.category),
    on_hand: n(r.on_hand),
    avg7: n(r.avg_daily_7d),
    unit_cost: n(r.unit_cost),
    unit_price: n(r.unit_price),
    case_pack: n(r.case_pack),
    supplier_id: s(r.supplier_id),
  }));
  const fc = new Map<string, { f: number; p10: number; p90: number }>();
  let version = 0;
  for (const r of await sql(
    `SELECT store_id, sku, biz_date::text AS d, forecast, p10, p90, model_version FROM ${S}.ml_forecast`
  )) {
    fc.set(k3(s(r.store_id), s(r.sku), s(r.d)), { f: n(r.forecast), p10: n(r.p10), p90: n(r.p90) });
    version = n(r.model_version);
  }
  const orders = await sql(
    `SELECT po_id, line_no, store_id, supplier_id, sku, qty, delivery_date::text AS d, status, basis, created_by,
            to_char(created_at AT TIME ZONE 'Asia/Singapore', 'YYYY-MM-DD') AS created
     FROM ${S}.silver_store_orders
     WHERE delivery_date >= date '${AS_OF}' AND status IN ('submitted', 'confirmed') ORDER BY po_id, line_no`
  );
  const arrivals = new Map<string, number>();
  for (const o of orders) {
    const k = k3(s(o.store_id), s(o.sku), s(o.d));
    arrivals.set(k, (arrivals.get(k) ?? 0) + n(o.qty));
  }
  const hist = new Map<string, number>();
  for (const r of await sql(
    `SELECT biz_date::text AS d, store_id, sku, units_sold FROM ${S}.silver_store_sku_day
     WHERE biz_date >= date '${AS_OF}' - 400`
  ))
    hist.set(k3(s(r.store_id), s(r.sku), s(r.d)), n(r.units_sold));
  const stores = new Map<string, Person & { households: number }>();
  for (const r of await sql(`SELECT * FROM ${S}.silver_ref_stores`))
    stores.set(s(r.store_id), {
      name: s(r.manager_name),
      email: s(r.manager_email),
      store: s(r.store_name),
      households: n(r.households),
    });
  const travel = new Map<string, { cold: number; all: number; away: number }>();
  for (const r of await sql(
    `SELECT store_id, biz_date::text AS d, cold_departures_next10, departures_next10, members_away FROM ${S}.gold_store_travel_daily`
  ))
    travel.set(`${s(r.store_id)}|${s(r.d)}`, {
      cold: n(r.cold_departures_next10),
      all: n(r.departures_next10),
      away: n(r.members_away),
    });
  const dc = new Map<string, number>();
  for (const r of await sql(`SELECT sku, available_qty FROM ${S}.silver_ref_dc_stock`))
    dc.set(s(r.sku), n(r.available_qty));
  return { pos, fc, arrivals, orders, hist, stores, travel, dc, version, run: runId };
}

const F = (c: Ctx, store: string, sku: string, d: string) => c.fc.get(k3(store, sku, d)) ?? { f: 0, p10: 0, p90: 0 };

/** Day-by-day stock path: sells what is on the shelf, counts the rest as lost sales. */
function simulate(c: Ctx, p: Pos, days: string[], extra: Map<string, number> = new Map()) {
  let stock = p.on_hand;
  let lost = 0;
  let firstOut: string | null = null;
  const path: number[] = [];
  for (const d of days) {
    stock += (c.arrivals.get(k3(p.store_id, p.sku, d)) ?? 0) + (extra.get(d) ?? 0);
    const demand = F(c, p.store_id, p.sku, d).f;
    const sold = Math.min(stock, demand);
    if (demand - sold > 0.5 && !firstOut) firstOut = d;
    lost += demand - sold;
    stock -= sold;
    path.push(stock);
  }
  return { lost, firstOut, path };
}

// ── publish: signals, options and insight tiles ───────────────────────────────────────────────
export async function publish(runId: number): Promise<Record<string, unknown>> {
  const c = await loadCtx(runId);
  const week = range(AS_OF, addDays(AS_OF, 6));

  // Availability scan: every non-fresh store × SKU over the next 7 days.
  const risks = c.pos
    .filter((p) => p.category !== 'Fresh')
    .map((p) => ({ p, ...simulate(c, p, week) }))
    .filter((r) => r.lost >= 1);
  const groups = new Map<string, { store: string; category: string; lostSales: number }>();
  for (const r of risks) {
    const g = groups.get(`${r.p.store_id}|${r.p.category}`) ?? {
      store: r.p.store_id,
      category: r.p.category,
      lostSales: 0,
    };
    g.lostSales += r.lost * r.p.unit_price;
    groups.set(`${r.p.store_id}|${r.p.category}`, g);
  }
  const worst = [...groups.values()].sort((a, b) => b.lostSales - a.lostSales)[0];

  // Fresh order scan: every open fresh purchase order against the forecast for its 4-day window.
  const poScan = freshOrders(c);
  const worstPo = poScan.filter((p) => p.excessPct >= 0.25).sort((a, b) => b.wasteValue - a.wasteValue)[0];

  await sql(`DELETE FROM ${S}.agent_signals`);
  let signals = 0;
  let recs = 0;
  if (worst && worst.lostSales > 500) {
    const { signal, options } = await stockoutSignal(c, worst.store, worst.category);
    await saveSignal(`S1-R${runId}`, runId, signal, options);
    signals++;
    recs += options.length;
  }
  if (worstPo) {
    const { signal, options } = await excessPoSignal(c, worstPo);
    await saveSignal(`S2-R${runId}`, runId, signal, options);
    signals++;
    recs += options.length;
  }

  const nonFresh = c.pos.filter((p) => p.category !== 'Fresh').length;
  const stores = [...c.stores.entries()].map(([id, st]) => ({
    store_id: id,
    store: st.store,
    at_risk: risks.filter((r) => r.p.store_id === id).length,
    lost_sales: Math.round(risks.filter((r) => r.p.store_id === id).reduce((a, r) => a + r.lost * r.p.unit_price, 0)),
    waste_risk: Math.round(poScan.filter((p) => p.store === id).reduce((a, p) => a + p.wasteValue, 0)),
  }));
  const dashboard = {
    projected_in_stock: +(100 * (1 - risks.length / Math.max(nonFresh, 1))).toFixed(1),
    at_risk: risks.length,
    lost_sales_7d: Math.round(risks.reduce((a, r) => a + r.lost * r.p.unit_price, 0)),
    fresh_waste_risk: Math.round(poScan.reduce((a, p) => a + p.wasteValue, 0)),
    open_fresh_orders: poScan.length,
    stores,
    top_risks: risks
      .sort((a, b) => b.lost * b.p.unit_price - a.lost * a.p.unit_price)
      .slice(0, 5)
      .map((r) => ({
        store: r.p.store_name,
        product: r.p.product_name,
        out: r.firstOut ? label(r.firstOut) : '—',
        lost_sales: Math.round(r.lost * r.p.unit_price),
      })),
  };
  return { signals, recommendations: recs, dashboard, app: 'Agent Decisions' };
}

async function saveSignal(id: string, runId: number, signal: SignalPayload, options: RecPayload[]) {
  await sql(
    `INSERT INTO ${S}.agent_signals (signal_id, run_id, kind, store_id, title, severity, payload)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
    [
      id,
      runId,
      signal.kind,
      signal.store_id,
      signal.title,
      signal.kind === 'stockout' ? 'high' : 'medium',
      JSON.stringify(signal),
    ]
  );
  const ranked = [...options].sort((a, b) => b.score - a.score);
  for (const [i, o] of ranked.entries()) {
    await sql(
      `INSERT INTO ${S}.agent_recommendations (rec_id, signal_id, rank, payload) VALUES ($1, $2, $3, $4::jsonb)`,
      [`${id}-${String.fromCharCode(65 + i)}`, id, i + 1, JSON.stringify(o)]
    );
  }
}

// ── Signal 1: winter apparel stock-out before the travel peak ────────────────────────────────
async function stockoutSignal(c: Ctx, storeId: string, category: string) {
  const st = c.stores.get(storeId)!;
  const person: Person = { name: st.name, email: st.email, store: st.store };
  const lines = c.pos.filter((p) => p.store_id === storeId && p.category === category);
  const nextStd = c.orders
    .filter((o) => s(o.store_id) === storeId && lines.some((l) => l.sku === s(o.sku)))
    .map((o) => ({ d: s(o.d), po: s(o.po_id) }))
    .sort((a, b) => a.d.localeCompare(b.d))[0];
  const coverTo = nextStd ? addDays(nextStd.d, -1) : addDays(AS_OF, 6);
  const horizon = range(AS_OF, coverTo);
  const week = range(AS_OF, addDays(AS_OF, 6));
  const base = new Map(lines.map((p) => [p.sku, simulate(c, p, horizon)]));
  const lostBase = lines.reduce((a, p) => a + base.get(p.sku)!.lost, 0);
  const lostSalesBase = lines.reduce((a, p) => a + base.get(p.sku)!.lost * p.unit_price, 0);
  const onHand = lines.reduce((a, p) => a + p.on_hand, 0);
  const f7 = (key: 'f' | 'p10' | 'p90') =>
    lines.reduce((a, p) => a + week.reduce((b, d) => b + F(c, storeId, p.sku, d)[key], 0), 0);
  const outs = lines.map((p) => ({ p, out: base.get(p.sku)!.firstOut })).filter((x) => x.out) as {
    p: Pos;
    out: string;
  }[];
  outs.sort((a, b) => a.out.localeCompare(b.out));
  const firstOut = outs[0];
  const tv = (d: string) => c.travel.get(`${storeId}|${d}`) ?? { cold: 0, all: 0, away: 0 };
  const coldNow = tv(AS_OF).cold;
  const coldEarly = tv(addDays(AS_OF, -49)).cold;
  const lyWeek = lines.reduce(
    (a, p) => a + horizon.reduce((b, d) => b + (c.hist.get(k3(storeId, p.sku, addDays(d, -364))) ?? 0), 0),
    0
  );
  const fHorizon = lines.reduce((a, p) => a + horizon.reduce((b, d) => b + F(c, storeId, p.sku, d).f, 0), 0);
  const dest = await sql(
    `SELECT split_part(destination, ',', 1) AS city, count(*)::int AS n FROM ${S}.silver_travel_bookings
     WHERE store_id = $1 AND cold_destination AND depart_date BETWEEN date '${AS_OF}' + 2 AND date '${AS_OF}' + 10
     GROUP BY 1 ORDER BY 2 DESC LIMIT 3`,
    [storeId]
  );
  const cities = dest.map((r) => s(r.city));
  const cityText = cities.length === 3 ? `${cities[0]}, ${cities[1]} and ${cities[2]}` : cities.join(' and ');
  const ratio = coldEarly > 0 ? coldNow / coldEarly : 0;

  // Chart: 4 weeks of actuals, 2 weeks of forecast, projected stock with no action, departures.
  const chartDays = range(addDays(AS_OF, -28), addDays(AS_OF, 13));
  const fullPath = new Map(lines.map((p) => [p.sku, simulate(c, p, range(AS_OF, addDays(AS_OF, 13))).path]));
  const series: SeriesPoint[] = chartDays.map((d) => {
    const pt: SeriesPoint = { date: d, driver: tv(d).cold };
    if (d < AS_OF) pt.actual = lines.reduce((a, p) => a + (c.hist.get(k3(storeId, p.sku, d)) ?? 0), 0);
    else {
      const i = toDay(d) - toDay(AS_OF);
      pt.forecast = +lines.reduce((a, p) => a + F(c, storeId, p.sku, d).f, 0).toFixed(1);
      pt.p10 = +lines.reduce((a, p) => a + F(c, storeId, p.sku, d).p10, 0).toFixed(1);
      pt.p90 = +lines.reduce((a, p) => a + F(c, storeId, p.sku, d).p90, 0).toFixed(1);
      // Stock at close with no action, up to the next booked delivery (after that the picture resets).
      if (!nextStd || d < nextStd.d)
        pt.stock = Math.round(lines.reduce((a, p) => a + (fullPath.get(p.sku)![i] ?? 0), 0));
    }
    return pt;
  });
  const stockoutDay = series.find((p) => p.stock !== undefined && p.stock <= 0.5)?.date;

  const signal: SignalPayload = {
    kind: 'stockout',
    store_id: storeId,
    category,
    store: person,
    title: `${category} will run out at ${st.store} before the travel peak`,
    summary: `${firstOut ? `${plural(firstOut.p.product_name)} run out on ${label(firstOut.out)}` : 'Lines run short'}; ${outs.length} of ${lines.length} lines are gone before ${nextStd ? `the next delivery on ${label(nextStd.d)}` : 'next week'}.`,
    headline: [
      { label: 'Sales at risk, next 7 days', value: money(lostSalesBase), tone: 'bad' },
      { label: 'First line out', value: firstOut ? label(firstOut.out) : '—', tone: 'bad' },
      { label: 'On hand vs 7-day forecast', value: `${units(onHand)} vs ${units(f7('f'))}`, tone: 'warn' },
    ],
    insight: {
      title: 'Customers buy winter wear for their trips',
      text: `${units(coldNow)} loyalty members who shop at ${st.store} fly to cold destinations in the next 10 days, mostly ${cityText}. That is ${ratio >= 10 ? ratio.toFixed(0) : ratio.toFixed(1)}× early November, and winter apparel sales here have tracked those departures since the school holidays began.`,
      source: 'Customer behaviour API → silver.travel_bookings → gold.store_travel_daily',
    },
    drivers: [
      {
        source: 'Stock API',
        text: `${units(onHand)} units on hand across ${lines.length} lines, counted at 06:00 today.`,
      },
      {
        source: 'Managed Postgres · store orders',
        text: nextStd
          ? `Next NorthPeak delivery ${nextStd.po} lands ${label(nextStd.d)}, after the peak departure days.`
          : 'No delivery booked this week.',
      },
      {
        source: `Forecast model v${c.version}`,
        text: `${units(f7('f'))} units over the next 7 days (P10–P90: ${units(f7('p10'))}–${units(f7('p90'))}).`,
      },
      {
        source: 'Lakehouse · sales history',
        text: `The same days last year sold ${units(lyWeek)} units; copying last year would under-order by ${units(fHorizon - lyWeek)}.`,
      },
    ],
    series,
    chart: {
      today: AS_OF,
      stockout: stockoutDay,
      driverLabel: 'Members departing to cold destinations (2–10 days)',
      showStock: true,
    },
    lines: lines.map((p) => ({
      sku: p.sku,
      name: p.product_name,
      a: units(p.on_hand),
      b: units(week.reduce((a, d) => a + F(c, storeId, p.sku, d).f, 0)),
      c: base.get(p.sku)!.firstOut ? label(base.get(p.sku)!.firstOut!) : 'Covered',
    })),
    lineHeads: ['On hand', 'Forecast 7 days', 'Runs out'],
    model_version: c.version,
  };

  const situation = {
    first_line_out: firstOut ? `${plural(firstOut.p.product_name).toLowerCase()} on ${label(firstOut.out)}` : 'none',
    lines_out: `${outs.length} of ${lines.length}`,
    next_standard_delivery: nextStd ? `${nextStd.po} on ${label(nextStd.d)}` : 'none',
  };

  // Option A: expedite from the Jurong DC (48 h, 6% freight, ≥ 2 packs per line).
  const etaA = addDays(AS_OF, 2);
  const need = (p: Pos) => {
    const fh = horizon.reduce((a, d) => a + F(c, storeId, p.sku, d).f, 0);
    return fh + (2 * fh) / horizon.length - p.on_hand;
  };
  const linesA: Line[] = [];
  const extraA = new Map<string, Map<string, number>>();
  for (const p of lines) {
    let qty = ceilTo(need(p), p.case_pack);
    if (qty > 0) qty = Math.max(qty, 2 * p.case_pack);
    qty = Math.min(qty, Math.floor((c.dc.get(p.sku) ?? 0) / p.case_pack) * p.case_pack);
    if (qty <= 0) continue;
    linesA.push({
      sku: p.sku,
      name: p.product_name,
      qty,
      pack: p.case_pack,
      note: `${qty / p.case_pack} packs of ${p.case_pack}`,
    });
    extraA.set(p.sku, new Map([[etaA, qty]]));
  }
  const evalOption = (extra: Map<string, Map<string, number>>) => {
    let lostUnits = 0;
    let lostSales = 0;
    let margin = 0;
    for (const p of lines) {
      const r = simulate(c, p, horizon, extra.get(p.sku));
      const saved = base.get(p.sku)!.lost - r.lost;
      lostUnits += r.lost;
      lostSales += saved * p.unit_price;
      margin += saved * (p.unit_price - p.unit_cost);
    }
    return { lostUnits, salesProtected: lostSales, marginProtected: margin };
  };
  const costOf = (ls: Line[]) =>
    ls.reduce((a, l) => a + l.qty * (lines.find((p) => p.sku === l.sku)?.unit_cost ?? 0), 0);
  const valueA = costOf(linesA);
  const freight = valueA * 0.06;
  const evA = evalOption(extraA);
  const coverA = 1 - evA.lostUnits / Math.max(lostBase, 1);
  const optA: RecPayload = {
    kind: 'expedite',
    title: 'Expedite a NorthPeak order from the Jurong DC',
    summary: `Pick ${units(linesA.reduce((a, l) => a + l.qty, 0))} units from DC stock today; they reach ${st.store} on ${label(etaA)} and cover demand until the ${nextStd ? label(nextStd.d) : 'next'} delivery.`,
    action: `Confirm the expedited order in store ordering today`,
    eta: label(etaA),
    lines: linesA,
    impact: [
      { label: 'Sales protected', value: money(evA.salesProtected), tone: 'good' },
      { label: 'Order value', value: money(valueA + freight), tone: 'neutral' },
      { label: 'Extra cost (6% freight)', value: money(freight), tone: 'cost' },
      { label: 'Lost sales avoided', value: `${Math.round(coverA * 100)}%`, tone: 'good' },
    ],
    tradeoffs: [
      `${label(addDays(AS_OF, 1))} is still short until the order lands on ${label(etaA)}.`,
      'Uses DC stock planned for January replenishment; NorthPeak refills the DC in 5 days.',
    ],
    confidence: `Covers the forecast plus 2 days of safety stock; P90 demand is ${units(f7('p90'))} units over 7 days.`,
    clause_ids: ['NPK-4.2', 'OPS-2.4', 'CDP-1.0'],
    recipient: person,
    terms: 'Full case packs, at least two packs per line, 48-hour DC pick [NPK-4.2]',
    approval: `${money(valueA + freight)} is above the S$2,000 limit, so ${st.name} confirms it [OPS-2.4]`,
    facts: {
      ...situation,
      order_type: 'Expedited purchase order, picked from the Harmoni Jurong DC',
      supplier: 'NorthPeak Outdoor Apparel',
      arrives: label(etaA),
      order_value: money(valueA + freight),
      freight: money(freight),
      sales_protected_7d: money(evA.salesProtected),
    },
    score: evA.marginProtected - freight,
  };

  // Option B: next-day transfers from stores with spare stock (keep ≥ 21 days of cover there).
  const etaB = addDays(AS_OF, 1);
  const linesB: Line[] = [];
  const extraB = new Map<string, Map<string, number>>();
  const donorsUsed = new Set<string>();
  for (const p of lines) {
    let want = Math.max(0, Math.ceil(need(p)));
    const donors = c.pos
      .filter((q) => q.sku === p.sku && q.store_id !== storeId)
      .map((q) => {
        // Donors keep 21 days of cover at whichever is higher: their recent sales or their forecast.
        const rate = Math.max(
          q.avg7,
          range(AS_OF, addDays(AS_OF, 13)).reduce((a, d) => a + F(c, q.store_id, q.sku, d).f, 0) / 14
        );
        return { q, spare: Math.floor(q.on_hand - 21 * rate) };
      })
      .filter((x) => x.spare > 0)
      .sort((a, b) => b.spare - a.spare);
    let got = 0;
    for (const dn of donors) {
      if (want <= 0) break;
      const take = Math.min(dn.spare, want);
      linesB.push({ sku: p.sku, name: p.product_name, qty: take, from: dn.q.store_name });
      donorsUsed.add(dn.q.store_name);
      want -= take;
      got += take;
    }
    if (got > 0) extraB.set(p.sku, new Map([[etaB, got]]));
  }
  const unitsB = linesB.reduce((a, l) => a + l.qty, 0);
  const handling = unitsB * 0.6 + donorsUsed.size * 120;
  const evB = evalOption(extraB);
  const coverB = 1 - evB.lostUnits / Math.max(lostBase, 1);
  const needTotal = lines.reduce((a, p) => a + Math.max(0, Math.ceil(need(p))), 0);
  const donorList = [...donorsUsed];
  const optB: RecPayload = {
    kind: 'transfer',
    title: `Transfer spare stock from ${donorList.length} store${donorList.length === 1 ? '' : 's'} on tomorrow's shuttle`,
    summary: `Move ${units(unitsB)} units from ${donorList.join(', ')} to ${st.store}, arriving ${label(etaB)}. Covers ${Math.round((100 * unitsB) / Math.max(needTotal, 1))}% of what the store needs to the next delivery.`,
    action: 'Raise the transfer orders in store ordering today',
    eta: label(etaB),
    lines: linesB,
    impact: [
      { label: 'Sales protected', value: money(evB.salesProtected), tone: 'good' },
      { label: 'Units moved', value: units(unitsB), tone: 'neutral' },
      { label: 'Extra cost (handling + shuttle)', value: money(handling), tone: 'cost' },
      { label: 'Lost sales avoided', value: `${Math.round(coverB * 100)}%`, tone: 'good' },
    ],
    tradeoffs: [
      `Arrives a day earlier than the DC order, but donor stores must keep 21 days of cover, so only ${Math.round((100 * unitsB) / Math.max(needTotal, 1))}% of the need is available.`,
      'No new stock is bought: cheaper, and it uses winter stock that is slow in low-travel stores.',
    ],
    confidence: `Donor stores keep at least 21 days of forecast cover after the move [OPS-7.3].`,
    clause_ids: ['OPS-7.3', 'OPS-2.4', 'CDP-1.0'],
    recipient: person,
    terms: 'Next-day DC shuttle; donors keep ≥ 21 days of cover; S$0.60 per unit + S$120 per run [OPS-7.3]',
    approval: `Transfers of more than 30% of a line are confirmed by ${st.name} [OPS-2.4]`,
    facts: {
      ...situation,
      order_type: 'Inter-store transfer orders on the DC shuttle',
      donor_stores: donorList,
      arrives: label(etaB),
      handling_cost: money(handling),
      sales_protected_7d: money(evB.salesProtected),
      share_of_need_covered: `${Math.round((100 * unitsB) / Math.max(needTotal, 1))}%`,
    },
    score: evB.marginProtected - handling,
  };
  return { signal, options: [optA, optB].filter((o) => o.lines.length > 0) };
}

// ── Signal 2: a fresh order copied from last year's promotion week ────────────────────────────
interface PoScan {
  po: string;
  store: string;
  supplier: string;
  delivery: string;
  basis: string;
  createdBy: string;
  created: string;
  lines: { p: Pos; qty: number; fw: number; p90: number }[];
  qty: number;
  fw: number;
  excessPct: number;
  wasteValue: number;
}

function freshOrders(c: Ctx): PoScan[] {
  const byPo = new Map<string, Record<string, unknown>[]>();
  for (const o of c.orders) {
    const p = c.pos.find((x) => x.store_id === s(o.store_id) && x.sku === s(o.sku));
    if (!p || p.category !== 'Fresh') continue;
    byPo.set(s(o.po_id), [...(byPo.get(s(o.po_id)) ?? []), o]);
  }
  return [...byPo.entries()].map(([po, rows]) => {
    const first = rows[0];
    const delivery = s(first.d);
    const win = range(delivery, addDays(delivery, 3));
    const lines = rows.map((o) => {
      const p = c.pos.find((x) => x.store_id === s(o.store_id) && x.sku === s(o.sku))!;
      return {
        p,
        qty: n(o.qty),
        fw: win.reduce((a, d) => a + F(c, p.store_id, p.sku, d).f, 0),
        p90: win.reduce((a, d) => a + F(c, p.store_id, p.sku, d).p90, 0),
      };
    });
    const qty = lines.reduce((a, l) => a + l.qty, 0);
    const fw = lines.reduce((a, l) => a + l.fw, 0);
    return {
      po,
      store: s(first.store_id),
      supplier: s(first.supplier_id),
      delivery,
      basis: s(first.basis),
      createdBy: s(first.created_by),
      created: s(first.created),
      lines,
      qty,
      fw,
      excessPct: fw > 0 ? qty / fw - 1 : 0,
      wasteValue: lines.reduce((a, l) => a + Math.max(0, l.qty - l.fw) * l.p.unit_cost, 0),
    };
  });
}

async function excessPoSignal(c: Ctx, po: PoScan) {
  const st = c.stores.get(po.store)!;
  const person: Person = { name: st.name, email: st.email, store: st.store };
  const win = range(po.delivery, addDays(po.delivery, 3));
  const cutoff = businessDaysBefore(po.delivery, 2);
  const [promo] = await sql(
    `SELECT promo_name, uplift_pct, start_date::text AS a, end_date::text AS b FROM ${S}.silver_ref_promotions
     WHERE category = 'Fresh' AND end_date >= date '${win[0]}' - 364 AND start_date <= date '${win[3]}' - 364 LIMIT 1`
  );
  const awayPeak = Math.max(...win.map((d) => c.travel.get(`${po.store}|${d}`)?.away ?? 0));
  const awayPct = (100 * awayPeak) / st.households;
  const lyWin = po.lines.reduce(
    (a, l) => a + win.reduce((b, d) => b + (c.hist.get(k3(po.store, l.p.sku, addDays(d, -364))) ?? 0), 0),
    0
  );
  const p90w = po.lines.reduce((a, l) => a + l.p90, 0);
  const pct = Math.round(po.excessPct * 100);
  const skus = po.lines.map((l) => l.p);

  const chartDays = range(addDays(AS_OF, -28), addDays(AS_OF, 13));
  const series: SeriesPoint[] = chartDays.map((d) => {
    const pt: SeriesPoint = {
      date: d,
      ly: skus.reduce((a, p) => a + (c.hist.get(k3(po.store, p.sku, addDays(d, -364))) ?? 0), 0),
    };
    if (d < AS_OF) pt.actual = skus.reduce((a, p) => a + (c.hist.get(k3(po.store, p.sku, d)) ?? 0), 0);
    else {
      pt.forecast = +skus.reduce((a, p) => a + F(c, po.store, p.sku, d).f, 0).toFixed(1);
      pt.p10 = +skus.reduce((a, p) => a + F(c, po.store, p.sku, d).p10, 0).toFixed(1);
      pt.p90 = +skus.reduce((a, p) => a + F(c, po.store, p.sku, d).p90, 0).toFixed(1);
    }
    return pt;
  });

  const signal: SignalPayload = {
    kind: 'excess_po',
    store_id: po.store,
    category: 'Fresh',
    store: person,
    title: `${st.store}'s year-end fresh order is ${pct}% above forecast`,
    summary: `${po.po} to Greenleaf Fresh for ${label(po.delivery)} orders ${units(po.qty)} units for ${span(win[0], win[3])}; the forecast is ${units(po.fw)}. It was copied from last year's order (+3%).`,
    headline: [
      { label: 'Fresh waste at risk', value: money(po.wasteValue), tone: 'bad' },
      {
        label: `Ordered vs forecast, ${span(win[0], win[3])}`,
        value: `${units(po.qty)} vs ${units(po.fw)}`,
        tone: 'warn',
      },
      { label: 'Amendment cut-off', value: `${label(cutoff)}, 14:00`, tone: 'neutral' },
    ],
    insight: {
      title: "Last year's spike was a promotion, and shoppers are away",
      text: `The same days last year ran the ${promo ? `${s(promo.promo_name)} (+${n(promo.uplift_pct)}%)` : 'a fresh promotion'}, which moves to Lunar New Year this time. And ${units(awayPeak)} ${st.store} loyalty households (${awayPct.toFixed(0)}%) will be travelling over the holiday week, so fewer meals are cooked at home.`,
      source: 'Lakehouse promotions calendar + Customer behaviour API → gold',
    },
    drivers: [
      {
        source: 'Managed Postgres · store orders',
        text: `${po.po} placed by ${po.createdBy} on ${short(po.created)}: “${po.basis}”.`,
      },
      {
        source: 'Lakehouse · promotions',
        text: `Last year's ${span(win[0], win[3])} sold ${units(lyWin)} units with the promotion running; this year has no fresh promotion that week.`,
      },
      {
        source: `Forecast model v${c.version}`,
        text: `${units(po.fw)} units for ${span(win[0], win[3])} (P90: ${units(p90w)}), with the promotion removed and travel absences included.`,
      },
      {
        source: 'Lakehouse · supplier agreement',
        text: `Greenleaf accepts changes until 14:00 on ${label(cutoff)} [GRN-3.1].`,
      },
    ],
    series,
    chart: {
      today: AS_OF,
      window: {
        from: win[0],
        to: win[3],
        label: `${po.po}: ${units(po.qty / win.length)} a day ordered`,
        perDay: Math.round(po.qty / win.length),
      },
      showLy: true,
    },
    lines: po.lines.map((l) => ({
      sku: l.p.sku,
      name: l.p.product_name,
      a: units(l.qty),
      b: units(l.fw),
      c: `${l.qty > l.fw ? '+' : ''}${Math.round(100 * (l.qty / Math.max(l.fw, 1) - 1))}%`,
    })),
    lineHeads: ['Ordered', `Forecast ${span(win[0], win[3])}`, 'Over forecast'],
    model_version: c.version,
  };

  // Option A: amend each line to forecast + half a day of safety stock [FRS-2.1].
  const linesA: Line[] = po.lines.map((l) => ({
    sku: l.p.sku,
    name: l.p.product_name,
    current: l.qty,
    qty: Math.min(l.qty, ceilTo(l.fw + l.fw / 8, l.p.case_pack)),
    pack: l.p.case_pack,
  }));
  const waste = (q: number, f: number, cost: number) => Math.max(0, q - f) * cost;
  const wasteA = po.lines.reduce((a, l, i) => a + waste(linesA[i].qty, l.fw, l.p.unit_cost), 0);
  const optA: RecPayload = {
    kind: 'amend',
    title: `Amend ${po.po} to the forecast`,
    summary: `Cut ${po.po} from ${units(po.qty)} to ${units(linesA.reduce((a, l) => a + l.qty, 0))} units: forecast plus half a day of safety stock, one delivery on ${label(po.delivery)}.`,
    action: `Amend ${po.po} with Greenleaf before 14:00 on ${label(cutoff)}`,
    eta: `Cut-off ${label(cutoff)}, 14:00`,
    lines: linesA,
    impact: [
      { label: 'Waste avoided', value: money(po.wasteValue - wasteA), tone: 'good' },
      {
        label: 'Units taken off the order',
        value: units(po.qty - linesA.reduce((a, l) => a + l.qty, 0)),
        tone: 'good',
      },
      { label: 'Safety stock kept', value: '½ day', tone: 'neutral' },
      {
        label: 'Share of P90 demand covered',
        value: `${Math.min(100, Math.round((100 * linesA.reduce((a, l) => a + l.qty, 0)) / Math.max(p90w, 1)))}%`,
        tone: 'neutral',
      },
    ],
    tradeoffs: [
      'One change, made once: simplest for the store and the supplier.',
      "If New Year's Eve runs well above forecast, the store relies on the next regular order.",
    ],
    confidence: `Forecast error on fresh last week was ${'{fresh_wape}'}% at store × SKU × week.`,
    clause_ids: ['GRN-3.1', 'FRS-2.1', 'PRM-1.2', 'OPS-2.4'],
    recipient: person,
    terms: `Change accepted until 14:00 on ${label(cutoff)} [GRN-3.1]; order to forecast + ½ day [FRS-2.1]`,
    approval: `Lines change by more than 30%, so ${st.name} confirms the amendment [OPS-2.4]`,
    facts: {
      order: po.po,
      supplier: 'Greenleaf Fresh Co.',
      delivery: label(po.delivery),
      covers: `${short(win[0])} to ${short(win[3])}`,
      ordered_units: units(po.qty),
      forecast_units: units(po.fw),
      amendment_cutoff: `${label(cutoff)}, 14:00`,
      waste_avoided: money(po.wasteValue - wasteA),
      last_year_promotion: promo ? `${s(promo.promo_name)} (+${n(promo.uplift_pct)}%)` : 'none',
      households_away_pct: `${awayPct.toFixed(0)}%`,
    },
    score: po.wasteValue - wasteA,
  };

  // Option B: split into two drops; the second is sized on 29 Dec against what actually sold.
  const d2 = addDays(po.delivery, 2);
  const splitLines: Line[] = [];
  let wasteB = 0;
  for (const l of po.lines) {
    const f1 = [po.delivery, addDays(po.delivery, 1)].reduce((a, d) => a + F(c, po.store, l.p.sku, d).f, 0);
    const f2 = [d2, addDays(d2, 1)].reduce((a, d) => a + F(c, po.store, l.p.sku, d).f, 0);
    const q1 = ceilTo(f1 + f1 / 4, l.p.case_pack);
    const q2 = ceilTo(f2 + f2 / 4, l.p.case_pack);
    splitLines.push({
      sku: l.p.sku,
      name: l.p.product_name,
      current: l.qty,
      qty: q1,
      note: label(po.delivery),
      pack: l.p.case_pack,
    });
    splitLines.push({
      sku: l.p.sku,
      name: l.p.product_name,
      qty: q2,
      note: `${label(d2)} (confirm on ${short(addDays(d2, -1))})`,
      pack: l.p.case_pack,
    });
    wasteB += waste(q1, f1, l.p.unit_cost) + waste(q2, f2, l.p.unit_cost);
  }
  const optB: RecPayload = {
    kind: 'split',
    title: `Split ${po.po} into two deliveries`,
    summary: `Take ${units(splitLines.filter((_, i) => i % 2 === 0).reduce((a, l) => a + l.qty, 0))} units on ${label(po.delivery)} and size a second drop for ${label(d2)} on what actually sells, so New Year's Eve stock is fresh.`,
    action: `Ask Greenleaf to split ${po.po} before 14:00 on ${label(cutoff)}`,
    eta: `${short(po.delivery)} and ${short(d2)}`,
    lines: splitLines,
    impact: [
      { label: 'Waste avoided', value: money(po.wasteValue - wasteB), tone: 'good' },
      { label: 'Fresher stock for', value: "New Year's Eve", tone: 'good' },
      { label: 'Extra delivery charge', value: 'S$0', tone: 'neutral' },
      { label: 'Second drop confirmed', value: short(addDays(d2, -1)), tone: 'neutral' },
    ],
    tradeoffs: [
      "Protects New Year's Eve if it runs hot: the second drop can go up as well as down.",
      'Salmon (3-day shelf life) arrives on the 30th instead of the 28th.',
      'Two deliveries to receive, and someone must confirm the second drop on the 29th.',
    ],
    confidence: "Each drop carries a day's worth of safety stock across two days.",
    clause_ids: ['GRN-3.4', 'GRN-3.1', 'PRM-1.2', 'OPS-2.4'],
    recipient: person,
    terms: `Split deliveries free above S$1,500 with 24 hours' notice [GRN-3.4]; cut-off 14:00 ${label(cutoff)} [GRN-3.1]`,
    approval: `Lines change by more than 30%, so ${st.name} confirms the split [OPS-2.4]`,
    facts: {
      order: po.po,
      supplier: 'Greenleaf Fresh Co.',
      first_delivery: label(po.delivery),
      second_delivery: label(d2),
      second_drop_confirmed_on: label(addDays(d2, -1)),
      ordered_units: units(po.qty),
      forecast_units: units(po.fw),
      amendment_cutoff: `${label(cutoff)}, 14:00`,
      waste_avoided: money(po.wasteValue - wasteB),
      last_year_promotion: promo ? `${s(promo.promo_name)} (+${n(promo.uplift_pct)}%)` : 'none',
    },
    score: po.wasteValue - wasteB - 1,
  };
  // Fill in the fresh backtest error from the model that produced this forecast.
  const [m] = await sql(`SELECT metrics FROM ${S}.ml_model_registry WHERE version = $1`, [c.version]);
  const metrics = (m?.metrics ?? {}) as { by_category?: Record<string, { model: number }> };
  const fw = metrics.by_category?.Fresh?.model;
  optA.confidence = optA.confidence.replace('{fresh_wape}', fw !== undefined ? String(fw) : 'n/a');
  return { signal, options: [optA, optB] };
}

// ── Screen 2 API ──────────────────────────────────────────────────────────────────────────────
export async function getDecisions(): Promise<Record<string, unknown>> {
  const signals = await sql(
    `SELECT signal_id, run_id, kind, store_id, title, severity, status, payload FROM ${S}.agent_signals ORDER BY signal_id`
  );
  const recs = await sql(
    `SELECT rec_id, signal_id, rank, payload, status, draft, decided_by,
            to_char(decided_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS decided_at
     FROM ${S}.agent_recommendations ORDER BY signal_id, rank`
  );
  const [model] = await sql(
    `SELECT version, metrics, to_char(trained_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS trained_at
     FROM ${S}.ml_model_registry WHERE stage = 'Production' ORDER BY version DESC LIMIT 1`
  );
  const ids = signals.map((r) => s(r.signal_id));
  const log = ids.length
    ? await sql(
        `SELECT id, entity_type, entity_id, action, detail, actor, source,
                to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_at
         FROM ${S}.decision_log WHERE split_part(entity_id, '-', 1) || '-' || split_part(entity_id, '-', 2) = ANY($1::text[])
         ORDER BY id DESC LIMIT 20`,
        [ids]
      )
    : [];
  return {
    as_of: AS_OF,
    model: model ?? null,
    model_service: modelService(),
    signals: signals.map((r) => ({
      ...r,
      recs: recs.filter((x) => s(x.signal_id) === s(r.signal_id)),
    })),
    log,
  };
}

async function loadRec(recId: string) {
  const [rec] = await sql(
    `SELECT r.rec_id, r.signal_id, r.status, r.payload, r.draft, s.payload AS signal, s.run_id
     FROM ${S}.agent_recommendations r JOIN ${S}.agent_signals s ON s.signal_id = r.signal_id WHERE r.rec_id = $1`,
    [recId]
  );
  if (!rec) return null;
  return {
    id: s(rec.rec_id),
    signalId: s(rec.signal_id),
    status: s(rec.status),
    runId: n(rec.run_id),
    rec: rec.payload as RecPayload,
    signal: rec.signal as SignalPayload,
  };
}

export interface Check {
  id: string;
  label: string;
  status: 'pass' | 'warn' | 'fail' | 'info';
  detail: string;
}

export function checkDraft(rec: RecPayload, body: string): Check[] {
  const text = body.toLowerCase();
  const missing = rec.lines.filter(
    (l) =>
      !(text.includes(l.sku.toLowerCase()) || text.includes(l.name.toLowerCase())) ||
      !(body.includes(String(l.qty)) || body.includes(units(l.qty)))
  );
  const strangers = (body.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) ?? []).filter(
    (e) => !/harmonimart\.example$/i.test(e)
  );
  const memberIds = body.match(/\bM-[A-Z]{3}-\d{3,}\b/g) ?? [];
  const cited = rec.clause_ids.filter((id) => body.includes(id));
  return [
    {
      id: 'lines',
      label: 'Order lines match the recommendation',
      status: missing.length === 0 ? 'pass' : 'warn',
      detail:
        missing.length === 0
          ? `All ${rec.lines.length} lines and quantities are in the e-mail`
          : `Check ${missing.map((l) => l.sku).join(', ')}: quantity changed or missing`,
    },
    {
      id: 'pii',
      label: 'No customer personal data',
      status: strangers.length + memberIds.length === 0 ? 'pass' : 'fail',
      detail:
        strangers.length + memberIds.length === 0
          ? 'Only aggregated travel counts; member identities stay hashed in silver'
          : `Remove ${[...strangers, ...memberIds].join(', ')} before sending`,
    },
    { id: 'terms', label: 'Within supplier and store terms', status: 'pass', detail: rec.terms },
    {
      id: 'cite',
      label: 'Cites the governing clauses',
      status: cited.length > 0 ? 'pass' : 'warn',
      detail: cited.length > 0 ? `Cites ${cited.join(', ')}` : 'No clause reference in the text',
    },
    { id: 'approval', label: 'Store manager confirmation', status: 'info', detail: rec.approval },
  ];
}

function linesText(rec: RecPayload): string {
  if (rec.kind === 'amend')
    return rec.lines.map((l) => `- ${l.name} (${l.sku}): ${units(l.current ?? 0)} → ${units(l.qty)}`).join('\n');
  if (rec.kind === 'split') {
    const by = new Map<string, Line[]>();
    for (const l of rec.lines) by.set(l.note ?? '', [...(by.get(l.note ?? '') ?? []), l]);
    return [...by.entries()]
      .map(([when, ls]) => `${when}:\n${ls.map((l) => `- ${l.name} (${l.sku}): ${units(l.qty)}`).join('\n')}`)
      .join('\n');
  }
  if (rec.kind === 'transfer')
    return rec.lines.map((l) => `- ${l.name} (${l.sku}): ${units(l.qty)} from ${l.from}`).join('\n');
  return rec.lines.map((l) => `- ${l.name} (${l.sku}): ${units(l.qty)}${l.note ? ` (${l.note})` : ''}`).join('\n');
}

function templateDraft(sig: SignalPayload, rec: RecPayload): { subject: string; body: string } {
  const first = rec.recipient.name.split(' ')[0];
  const f = rec.facts as Record<string, string>;
  const sales = rec.impact.find((i) => i.label === 'Sales protected')?.value;
  if (rec.kind === 'expedite' || rec.kind === 'transfer') {
    const opening =
      `Hi ${first},\n\n${rec.recipient.store} is about to run out of winter apparel: ${f.first_line_out}, and ${f.lines_out} lines before your next NorthPeak delivery, ${f.next_standard_delivery}.\n\n` +
      `Why now: ${sig.insight.text} [CDP-1.0]\n\n`;
    if (rec.kind === 'expedite')
      return {
        subject: `${rec.recipient.store} winter apparel: please confirm an expedited order today`,
        body:
          `${opening}Please confirm this expedited order, picked from the Jurong DC so it arrives on ${f.arrives} [NPK-4.2]:\n${linesText(rec)}\n\n` +
          `Order value ${f.order_value}, including ${f.freight} expedite freight. It protects about ${sales} of sales over the next 7 days.\n\n` +
          `A draft order is waiting for you in store ordering. It needs your confirmation because it is above S$2,000 [OPS-2.4].\n\nThanks,\nReplenishment planning`,
      };
    return {
      subject: `${rec.recipient.store} winter apparel: please raise transfer orders today`,
      body:
        `${opening}Please raise these transfers on tomorrow's DC shuttle so they arrive on ${f.arrives} [OPS-7.3]:\n${linesText(rec)}\n\n` +
        `This covers ${f.share_of_need_covered} of what the store needs until the next delivery and protects about ${sales} of sales. Handling and shuttle cost ${f.handling_cost}. The donor stores keep at least 21 days of cover.\n\n` +
        `Draft transfer orders are waiting for you in store ordering for confirmation [OPS-2.4].\n\nThanks,\nReplenishment planning`,
    };
  }
  const opening =
    `Hi ${first},\n\n${f.order} to ${f.supplier} for ${f.delivery ?? f.first_delivery} orders ${f.ordered_units} units; we expect ${rec.recipient.store} to sell ${f.forecast_units}.\n\n` +
    `It copies last year's order, which was placed for the ${f.last_year_promotion}. That promotion moves to Lunar New Year this time [PRM-1.2]. ${sig.insight.text.split('. ').slice(1).join('. ')}\n\n`;
  if (rec.kind === 'amend')
    return {
      subject: `${f.order}: please amend before ${f.amendment_cutoff}`,
      body:
        `${opening}Please amend ${f.order} to these quantities before Greenleaf's cut-off at ${f.amendment_cutoff} [GRN-3.1]:\n${linesText(rec)}\n\n` +
        `That keeps the order at forecast plus half a day of safety stock [FRS-2.1] and avoids about ${f.waste_avoided} of fresh waste.\n\n` +
        `It needs your confirmation because lines change by more than 30% [OPS-2.4].\n\nThanks,\nReplenishment planning`,
    };
  return {
    subject: `${f.order}: please split into two deliveries before ${f.amendment_cutoff}`,
    body:
      `${opening}Please ask Greenleaf to split ${f.order} into two deliveries [GRN-3.4], before ${f.amendment_cutoff} [GRN-3.1]:\n${linesText(rec)}\n\n` +
      `We will confirm the second drop on ${f.second_drop_confirmed_on} against what has sold, so it can go up for New Year's Eve if needed. This avoids about ${f.waste_avoided} of fresh waste.\n\n` +
      `It needs your confirmation because lines change by more than 30% [OPS-2.4].\n\nThanks,\nReplenishment planning`,
  };
}

const SYSTEM = `You draft short operational e-mails for Harmoni Mart's replenishment planning team, sent to a store manager after a planner approves an AI recommendation.
Rules:
- Use only the facts provided. Never invent numbers, dates, people or products.
- Plain, warm, direct English. No marketing tone. Under 200 words in the body.
- Say what is happening, why (one or two sentences, citing the customer and data insight), and exactly what the manager must do and by when.
- Include every order line exactly as given, one per line, starting with "- ", keeping product names, SKU codes and quantities unchanged.
- Cite clause ids in square brackets, e.g. [NPK-4.2], right after the sentence that relies on them.
- Never include customer names, e-mail addresses or member ids.
- Sign off as "Replenishment planning".
Return only JSON: {"subject": "...", "body": "..."} with \\n for line breaks.`;

function promptFor(sig: SignalPayload, rec: RecPayload, clauses: Record<string, unknown>[]): string {
  return JSON.stringify(
    {
      recipient: { first_name: rec.recipient.name.split(' ')[0], role: `Store manager, ${rec.recipient.store}` },
      situation: {
        title: sig.title,
        summary: sig.summary,
        insight: sig.insight.text,
        evidence: sig.drivers.map((d) => `${d.source}: ${d.text}`),
      },
      chosen_action: {
        title: rec.title,
        summary: rec.summary,
        what_manager_must_do: rec.action,
        arrives_or_deadline: rec.eta,
        facts: rec.facts,
      },
      order_lines_verbatim: linesText(rec),
      approval_rule: rec.approval,
      clauses: clauses.map((c) => ({ id: c.clause_id, title: c.clause_title, text: c.body })),
    },
    null,
    2
  );
}

export async function draftEmail(recId: string): Promise<Record<string, unknown> | null> {
  const r = await loadRec(recId);
  if (!r) return null;
  const clauses = await sql(
    `SELECT clause_id, doc_title, clause_title, body FROM ${S}.gold_knowledge_clauses WHERE clause_id = ANY($1::text[])`,
    [r.rec.clause_ids]
  );
  let subject = '';
  let body = '';
  let source: 'model' | 'template' = 'template';
  let note: string | null = null;
  const t0 = Date.now();
  try {
    const text = await complete(SYSTEM, promptFor(r.signal, r.rec, clauses));
    const json = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)) as {
      subject?: string;
      body?: string;
    };
    if (!json.subject || !json.body) throw new Error('Model reply had no subject or body');
    subject = json.subject.trim();
    body = json.body.trim();
    source = 'model';
  } catch (err) {
    note = err instanceof Error ? err.message : String(err);
    ({ subject, body } = templateDraft(r.signal, r.rec));
  }
  const draft = {
    to: r.rec.recipient,
    cc: [PLANNING_INBOX],
    subject,
    body,
    source,
    model: source === 'model' ? modelService() : null,
    note,
    ms: Date.now() - t0,
    grounding: [
      { label: 'Gold position', detail: `harmoni.gold.replenishment_position · ${r.signal.store.store}` },
      { label: 'Forecast', detail: `harmoni.ml.replenishment_forecast v${r.signal.model_version}` },
      { label: 'Customer insight', detail: r.signal.insight.source },
      ...clauses.map((c) => ({ label: s(c.clause_id), detail: `${s(c.doc_title)} ${s(c.clause_title)}` })),
    ],
    checks: checkDraft(r.rec, body),
  };
  await sql(`UPDATE ${S}.agent_recommendations SET draft = $2::jsonb WHERE rec_id = $1`, [
    recId,
    JSON.stringify(draft),
  ]);
  return draft;
}

export async function approve(recId: string, subject: string, body: string, actor: string) {
  const r = await loadRec(recId);
  if (!r) return { status: 404 as const, error: 'Recommendation not found' };
  if (r.status !== 'proposed') return { status: 409 as const, error: `Already ${r.status}` };
  const checks = checkDraft(r.rec, body);
  const blocked = checks.find((c) => c.status === 'fail');
  if (blocked) return { status: 400 as const, error: `${blocked.label}: ${blocked.detail}` };

  const [model] = await sql(`SELECT max(version) AS v FROM ${S}.ml_model_registry`);
  const stamp = new Date().toLocaleString('en-SG', {
    timeZone: 'Asia/Singapore',
    dateStyle: 'medium',
    timeStyle: 'short',
  });
  const footer = `\n\n—\nApproved by ${actor} at ${stamp} (SGT). Drafted by the Replenishment agent from governed data: pipeline run #${r.runId}, forecast model v${n(model?.v)}. Reference ${recId}.`;
  const sent = await queueMessage({
    schema: S,
    channel: 'email',
    recipient: r.rec.recipient.email,
    subject,
    body: body + footer,
  });

  // Write the action back to store ordering (Managed Postgres) so the manager confirms one click away.
  let writeBack = '';
  if (r.rec.kind === 'expedite' || r.rec.kind === 'transfer') {
    const [row] = await sql(
      `SELECT coalesce(max(substring(po_id FROM '[0-9]+')::int), 7800) + 1 AS next FROM ${S}.src_pg_store_orders`
    );
    const id = `${r.rec.kind === 'expedite' ? 'PO' : 'TO'}-${n(row?.next)}`;
    const delivery = r.rec.kind === 'expedite' ? addDays(AS_OF, 2) : addDays(AS_OF, 1);
    for (const [i, l] of r.rec.lines.entries()) {
      await sql(
        `INSERT INTO ${S}.src_pg_store_orders VALUES ($1, $2, $3, $4, $5, $6, $7::date, 'awaiting store confirmation', $8, 'Replenishment agent', now())`,
        [
          id,
          i + 1,
          r.signal.store_id,
          r.rec.kind === 'expedite' ? 'SUP-NPK' : `TRANSFER:${l.from ?? ''}`,
          l.sku,
          l.qty,
          delivery,
          `${recId} approved by ${actor}`,
        ]
      );
    }
    writeBack = `Draft ${r.rec.kind === 'expedite' ? 'order' : 'transfer order'} ${id} (${r.rec.lines.length} lines) is waiting for ${r.rec.recipient.name}'s confirmation in store ordering`;
  } else {
    const po = String(r.rec.facts.order);
    await sql(`UPDATE ${S}.src_pg_store_orders SET status = $2 WHERE po_id = $1`, [
      po,
      r.rec.kind === 'amend' ? 'amendment requested' : 'split requested',
    ]);
    writeBack = `${po} is flagged “${r.rec.kind === 'amend' ? 'amendment' : 'split'} requested” in store ordering until ${r.rec.recipient.name} confirms`;
  }

  await sql(
    `UPDATE ${S}.agent_recommendations SET status = 'approved', decided_by = $2, decided_at = now(), draft = coalesce(draft, '{}'::jsonb) || jsonb_build_object('subject', $3::text, 'body', $4::text) WHERE rec_id = $1`,
    [recId, actor, subject, body]
  );
  await sql(
    `UPDATE ${S}.agent_recommendations SET status = 'not chosen' WHERE signal_id = $1 AND rec_id <> $2 AND status = 'proposed'`,
    [r.signalId, recId]
  );
  await sql(`UPDATE ${S}.agent_signals SET status = 'e-mail sent' WHERE signal_id = $1`, [r.signalId]);
  await logDecision({
    schema: S,
    entityType: 'recommendation',
    entityId: recId,
    action: 'approved and sent',
    detail: `${r.rec.title} → e-mail to ${r.rec.recipient.name} (outbox #${n(sent.id)}). ${writeBack}.`,
    actor,
    source: 'ui',
  });
  return { status: 200 as const, outbox_id: n(sent.id), outbox_status: s(sent.status), write_back: writeBack };
}

export async function reject(recId: string, reason: string, actor: string) {
  const r = await loadRec(recId);
  if (!r) return { status: 404 as const, error: 'Recommendation not found' };
  if (r.status !== 'proposed') return { status: 409 as const, error: `Already ${r.status}` };
  await sql(
    `UPDATE ${S}.agent_recommendations SET status = 'rejected', decided_by = $2, decided_at = now() WHERE rec_id = $1`,
    [recId, actor]
  );
  await logDecision({
    schema: S,
    entityType: 'recommendation',
    entityId: recId,
    action: 'rejected',
    detail: reason || 'Rejected by planner',
    actor,
    source: 'ui',
  });
  return { status: 200 as const };
}
