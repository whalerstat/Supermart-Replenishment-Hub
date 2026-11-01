// client/src/lib/api.ts — fetch helpers + the shapes returned by server/routes/api.ts.
import { useEffect, useState } from 'react';

export interface UiConfig {
  title: string;
  subtitle: string;
  persona: string;
  as_of: string;
  uc: { catalog: string; bronze: string; silver: string; gold: string; model: string };
  model_service: string | null;
  dashboard_url: string | null;
  reset_enabled: boolean;
  genie_enabled: boolean;
  genie_space_url: string | null;
}

export type Row = Record<string, unknown>;

// ── Screen 1 ──
export interface SourceStats {
  system: string;
  label: string;
  rows: number;
  objects: { object: string; rows: number }[];
}
export interface Expectation {
  rule: string;
  table: string;
  failed: number;
  action: string;
}
export interface Dashboard {
  projected_in_stock: number;
  at_risk: number;
  lost_sales_7d: number;
  fresh_waste_risk: number;
  open_fresh_orders: number;
  stores: { store_id: string; store: string; at_risk: number; lost_sales: number; waste_risk: number }[];
  top_risks: { store: string; product: string; out: string; lost_sales: number }[];
}
export interface ModelMetrics {
  wape: number;
  wape_spreadsheet: number;
  bias: number;
  backtest_week: string;
  grain: string;
  by_category: Record<string, { model: number; spreadsheet: number }>;
}
export interface RunStats {
  ingest?: { table: string; rows: number; sources: SourceStats[]; ms: number };
  silver?: {
    table: string;
    rows: number;
    related: { table: string; rows: number }[];
    expectations: Expectation[];
    quarantined: number;
    duplicates: number;
    masked: number;
    ms: number;
  };
  gold?: { table: string; rows: number; related: { table: string; rows: number }[]; grain: string; ms: number };
  train?: {
    model: string;
    version: number;
    train_rows: number;
    features: string[];
    metrics: ModelMetrics;
    drift: { feature: string; baseline_mean: number; last_week_mean: number; ratio: number; status: string };
    forecast_rows: number;
    horizon_days: number;
    ms: number;
  };
  publish?: { signals: number; recommendations: number; dashboard: Dashboard; app: string; ms: number };
}
export type TaskId = 'ingest' | 'silver' | 'gold' | 'train' | 'publish';
export interface PipelineRun {
  run_id: number;
  started_at: string;
  status: 'succeeded' | 'failed' | 'running';
  duration_min: number | null;
  triggered_by: string;
  rows_ingested: number | null;
}
export interface PipelineHistory {
  runs: PipelineRun[];
}

// ── Screen 2 ──
export interface SeriesPoint {
  date: string;
  actual?: number;
  forecast?: number;
  p10?: number;
  p90?: number;
  stock?: number;
  ly?: number;
  stock_level?: number;
  driver?: number;
}
export interface Person {
  name: string;
  email: string;
  store: string;
}
export interface RecLine {
  sku: string;
  name: string;
  qty: number;
  current?: number;
  from?: string;
  pack?: number;
  note?: string;
}
export interface RecPayload {
  kind: 'expedite' | 'transfer' | 'amend' | 'split';
  title: string;
  summary: string;
  action: string;
  eta: string;
  lines: RecLine[];
  impact: { label: string; value: string; tone: 'good' | 'cost' | 'neutral' }[];
  tradeoffs: string[];
  confidence: string;
  clause_ids: string[];
  recipient: Person;
  terms: string;
  approval: string;
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
    showStockLevel?: boolean;
  };
  lines: { sku: string; name: string; a: string; b: string; c: string }[];
  lineHeads: [string, string, string];
  model_version: number;
}
export interface Check {
  id: string;
  label: string;
  status: 'pass' | 'warn' | 'fail' | 'info';
  detail: string;
}
export interface Draft {
  to: Person;
  cc: string[];
  subject: string;
  body: string;
  source: 'model' | 'template';
  model: string | null;
  note: string | null;
  ms: number;
  grounding: { label: string; detail: string }[];
  checks: Check[];
}
export interface Rec {
  rec_id: string;
  signal_id: string;
  rank: number;
  payload: RecPayload;
  status: string;
  draft: Draft | null;
  decided_by: string | null;
  decided_at: string | null;
}
export interface Signal {
  signal_id: string;
  run_id: number;
  kind: string;
  store_id: string;
  title: string;
  severity: string;
  status: string;
  payload: SignalPayload;
  recs: Rec[];
}
export interface LogRow {
  id: number;
  entity_id: string;
  action: string;
  detail: string;
  actor: string;
  created_at: string;
}
export interface Decisions {
  as_of: string;
  ready: boolean;
  model: { version: number; metrics: ModelMetrics; trained_at: string } | null;
  model_service: string | null;
  signals: Signal[];
  log: LogRow[];
}

// ── helpers ──
export async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(await errorText(res));
  return (await res.json()) as T;
}

export async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await errorText(res));
  return (await res.json()) as T;
}

/** A non-2xx reply; `status` lets callers tell "service unavailable" (503) from other failures. */
export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** POSTs JSON and reads a plain-text streamed reply, calling onText with the text so far. */
export async function postStream(
  url: string,
  body: unknown,
  onText: (textSoFar: string) => void,
  signal?: AbortSignal
): Promise<string> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) throw new HttpError(res.status, await errorText(res));
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let complete = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    let chunk = decoder.decode(value, { stream: true });
    if (chunk.includes(STREAM_END)) {
      complete = true;
      chunk = chunk.replaceAll(STREAM_END, '');
    }
    if (!chunk) continue;
    text += chunk;
    onText(text);
  }
  if (!complete) throw new Error('The rewrite was cut off before it finished');
  return text;
}

/** Sent by the server after the last chunk of a complete stream (see /revise in server/routes/api.ts). */
const STREAM_END = '\u0004';

async function errorText(res: Response): Promise<string> {
  const t = await res.text();
  try {
    const j = JSON.parse(t) as { error?: string };
    if (j.error) return j.error;
  } catch {
    /* not JSON */
  }
  return `${res.status} ${t.slice(0, 200)}`;
}

export interface Loadable<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
}

/** Fetch JSON; bump `refreshKey` to refetch. Keeps the previous data while refetching. */
export function useJson<T>(url: string, refreshKey = 0): Loadable<T> {
  const [state, setState] = useState<Loadable<T>>({ data: null, error: null, loading: true });
  useEffect(() => {
    let alive = true;
    getJson<T>(url)
      .then((data) => alive && setState({ data, error: null, loading: false }))
      .catch(
        (e: unknown) =>
          alive &&
          setState((s) => ({ data: s.data, error: e instanceof Error ? e.message : String(e), loading: false }))
      );
    return () => {
      alive = false;
    };
  }, [url, refreshKey]);
  return state;
}

export const nf = (v: number) => Math.round(v).toLocaleString('en-US');
export const money = (v: number) => `S$${nf(v)}`;
export const moneyK = (v: number) => (Math.abs(v) >= 1000 ? `S$${(v / 1000).toFixed(1)}k` : money(v));

const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "2026-12-22" → "22 Dec" */
export function dShort(iso: string): string {
  return `${+iso.slice(8, 10)} ${MON[+iso.slice(5, 7) - 1]}`;
}
/** "2026-12-22" → "Tue 22 Dec" */
export function dLong(iso: string): string {
  return `${WD[new Date(`${iso}T00:00:00Z`).getUTCDay()]} ${dShort(iso)}`;
}

export function relTime(v: unknown): string {
  if (typeof v !== 'string') return '';
  const t = new Date(v).getTime();
  if (Number.isNaN(t)) return '';
  const mins = Math.round((Date.now() - t) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const h = Math.round(mins / 60);
  if (h < 24) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
