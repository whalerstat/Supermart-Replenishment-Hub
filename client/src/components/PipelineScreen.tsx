// client/src/components/PipelineScreen.tsx — Screen 1: the governed data foundation pipeline.
// Pressing "Run job" calls the five job tasks in order (each is real work on the server); the flow
// animates as each one runs, and the foundation box fills bronze → silver → gold as tables land.
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import {
  ArrowRight,
  Bot,
  BrainCircuit,
  CircleAlert,
  CircleCheck,
  Database,
  ExternalLink,
  Layers,
  LayoutDashboard,
  Loader2,
  Lock,
  Network,
  PackageSearch,
  Play,
  Plane,
  ShieldCheck,
  type LucideIcon,
} from 'lucide-react';
import { Alert, AlertDescription, Badge, Button } from '@databricks/appkit-ui/react';
import { cn } from '../lib/utils';
import {
  getJson,
  money,
  moneyK,
  nf,
  postJson,
  relTime,
  sleep,
  type Dashboard,
  type ModelMetrics,
  type RunStats,
  type TaskId,
  type UiConfig,
} from '../lib/api';

const SHORT: Record<string, string> = {
  managed_postgres: 'Managed Postgres',
  managed_relational: 'Lakehouse',
  saas_stock_api: 'Stock API',
  saas_customer_api: 'Customer API',
};

type State = 'idle' | 'running' | 'done' | 'failed';
const TASKS: { id: TaskId; label: string; min: number }[] = [
  { id: 'ingest', label: 'Ingest four sources into bronze', min: 2400 },
  { id: 'silver', label: 'Clean, conform and mask into silver', min: 1900 },
  { id: 'gold', label: 'Build the gold replenishment position', min: 1600 },
  { id: 'train', label: 'Train, backtest and register the forecast', min: 2400 },
  { id: 'publish', label: 'Refresh the dashboard and run the agent', min: 1800 },
];
const IDLE: Record<TaskId, State> = { ingest: 'idle', silver: 'idle', gold: 'idle', train: 'idle', publish: 'idle' };

const SOURCES: { system: string; title: string; subtitle: string; kind: string; icon: LucideIcon }[] = [
  {
    system: 'managed_postgres',
    title: 'Managed Postgres',
    subtitle: 'Lakebase · POS sales and store orders',
    kind: 'Change feed',
    icon: Database,
  },
  {
    system: 'managed_relational',
    title: 'Managed relational databases',
    subtitle: 'Lakehouse · ERP, sales history, promotions, agreements',
    kind: 'Federated',
    icon: Layers,
  },
  {
    system: 'saas_stock_api',
    title: 'Stock levels API',
    subtitle: 'SaaS inventory platform · counts every 4 h',
    kind: 'Real-time API',
    icon: PackageSearch,
  },
  {
    system: 'saas_customer_api',
    title: 'Customer behaviour API',
    subtitle: 'SaaS customer data platform · travel bookings',
    kind: 'Real-time API',
    icon: Plane,
  },
];

function useFlowPaths(
  container: RefObject<HTMLDivElement | null>,
  nodes: Record<string, RefObject<HTMLElement | null>>,
  deps: unknown[]
) {
  const [paths, setPaths] = useState<Record<string, string>>({});
  const [size, setSize] = useState({ w: 0, h: 0 });
  // The node map is a fresh object each render; read it through a ref so `measure` stays stable.
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  const measure = useCallback(() => {
    const nodes = nodesRef.current;
    const root = container.current;
    if (!root) return;
    const rb = root.getBoundingClientRect();
    const box = (k: string) => {
      const el = nodes[k]?.current;
      if (!el) return null;
      const b = el.getBoundingClientRect();
      return {
        l: b.left - rb.left,
        r: b.right - rb.left,
        t: b.top - rb.top,
        b: b.bottom - rb.top,
        cy: b.top - rb.top + b.height / 2,
      };
    };
    const curve = (a: { x: number; y: number }, z: { x: number; y: number }) => {
      const dx = (z.x - a.x) / 2;
      return `M${a.x},${a.y} C${a.x + dx},${a.y} ${z.x - dx},${z.y} ${z.x},${z.y}`;
    };
    const out: Record<string, string> = {};
    const f = box('foundation');
    const ml = box('ml');
    for (let i = 0; i < 4; i++) {
      const s = box(`src${i}`);
      if (s && f) out[`src${i}`] = curve({ x: s.r, y: s.cy }, { x: f.l, y: f.t + 56 + i * 10 });
    }
    if (f && ml) out.ml = curve({ x: f.r, y: f.t + 56 }, { x: ml.l, y: ml.cy });
    for (const k of ['dash', 'app']) {
      const o = box(k);
      if (ml && o) out[k] = curve({ x: ml.r, y: ml.cy }, { x: o.l, y: o.cy });
    }
    setPaths((prev) => (JSON.stringify(prev) === JSON.stringify(out) ? prev : out));
    setSize((prev) => (prev.w === rb.width && prev.h === rb.height ? prev : { w: rb.width, h: rb.height }));
  }, [container]);
  useLayoutEffect(() => {
    measure();
    const ro = new ResizeObserver(measure);
    if (container.current) ro.observe(container.current);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [measure, ...deps]);
  return { paths, size };
}

function Edge({ d, state }: { d?: string; state: State }) {
  if (!d) return null;
  return (
    <path
      d={d}
      fill="none"
      strokeWidth={state === 'idle' ? 1.5 : 2}
      strokeLinecap="round"
      strokeDasharray={state === 'idle' ? '3 5' : undefined}
      className={cn(
        state === 'idle' && 'stroke-border',
        state === 'running' && 'flow-active stroke-brand',
        state === 'done' && 'stroke-foreground/45',
        state === 'failed' && 'stroke-destructive'
      )}
    />
  );
}

function Node({
  nodeRef,
  state,
  className,
  children,
}: {
  nodeRef?: RefObject<HTMLDivElement | null>;
  state: State;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      ref={nodeRef}
      className={cn(
        'relative rounded-lg border bg-card p-3 transition-colors',
        state === 'running' && 'node-running border-brand',
        state === 'failed' && 'border-destructive',
        className
      )}
    >
      {children}
    </div>
  );
}

function StateIcon({ state, className = 'size-4' }: { state: State; className?: string }) {
  if (state === 'running') return <Loader2 aria-label="Running" className={cn(className, 'animate-spin text-brand')} />;
  if (state === 'done') return <CircleCheck aria-label="Done" className={cn(className, 'text-success')} />;
  if (state === 'failed') return <CircleAlert aria-label="Failed" className={cn(className, 'text-destructive')} />;
  return (
    <span
      aria-label="Waiting"
      className={cn(className, 'inline-block rounded-full border border-dashed border-muted-foreground/50')}
    />
  );
}

function ColumnLabel({ children }: { children: ReactNode }) {
  return (
    <p className="m-0 mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{children}</p>
  );
}

function Medallion({
  tier,
  table,
  rows,
  state,
  children,
}: {
  tier: 'Bronze' | 'Silver' | 'Gold';
  table: string;
  rows?: number;
  state: State;
  children?: ReactNode;
}) {
  const color = tier === 'Bronze' ? 'bg-medal-bronze' : tier === 'Silver' ? 'bg-medal-silver' : 'bg-medal-gold';
  if (state === 'idle') return null;
  return (
    <div className={cn('rise-in rounded-lg border bg-card p-3', state === 'running' && 'border-brand')}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span aria-hidden className={cn('size-3 shrink-0 rounded-full ring-2 ring-card', color)} />
        <span className="text-xs font-semibold uppercase tracking-wide">{tier}</span>
        <code className="min-w-0 truncate text-xs text-muted-foreground">{table}</code>
        <span className="ml-auto text-sm font-semibold tabular-nums">
          {state === 'running' ? (
            <Loader2 aria-label="Building" className="size-4 animate-spin text-brand" />
          ) : (
            <>
              {nf(rows ?? 0)}
              <span className="text-xs font-normal text-muted-foreground"> rows</span>
            </>
          )}
        </span>
      </div>
      {state === 'done' && children && <div className="mt-2 text-xs text-muted-foreground">{children}</div>}
    </div>
  );
}

function Tile({ label, value, tone }: { label: string; value: string; tone?: 'bad' | 'good' }) {
  return (
    <div className="rounded-md border bg-background px-2 py-1.5">
      <p className="m-0 text-[11px] leading-tight text-muted-foreground">{label}</p>
      <p className={cn('m-0 text-sm font-semibold tabular-nums', tone === 'bad' && 'text-brand-text')}>{value}</p>
    </div>
  );
}

export function PipelineScreen({ config, onOpenDecisions }: { config: UiConfig; onOpenDecisions: () => void }) {
  const [status, setStatus] = useState<Record<TaskId, State>>(IDLE);
  const [stats, setStats] = useState<RunStats>({});
  const [runId, setRunId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [started, setStarted] = useState<number | null>(null);
  const [finished, setFinished] = useState<number | null>(null);
  const [now, setNow] = useState(0);
  const [last, setLast] = useState<{ run: { run_id: number; finished_at: string } | null } | null>(null);

  const running = Object.values(status).includes('running');
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNow(Date.now()), 200);
    return () => clearInterval(t);
  }, [running]);
  useEffect(() => {
    getJson<{ run: { run_id: number; finished_at: string } | null }>('/api/pipeline/latest')
      .then(setLast)
      .catch(() => setLast(null));
  }, [finished]);

  const container = useRef<HTMLDivElement>(null);
  const src0 = useRef<HTMLDivElement>(null);
  const src1 = useRef<HTMLDivElement>(null);
  const src2 = useRef<HTMLDivElement>(null);
  const src3 = useRef<HTMLDivElement>(null);
  const foundationRef = useRef<HTMLDivElement>(null);
  const mlRef = useRef<HTMLDivElement>(null);
  const dashRef = useRef<HTMLDivElement>(null);
  const appRef = useRef<HTMLDivElement>(null);
  const srcRefs = [src0, src1, src2, src3];
  const { paths, size } = useFlowPaths(
    container,
    { src0, src1, src2, src3, foundation: foundationRef, ml: mlRef, dash: dashRef, app: appRef },
    [status, stats]
  );

  async function run() {
    setError(null);
    setStats({});
    setStatus(IDLE);
    setFinished(null);
    setStarted(Date.now());
    try {
      const { run_id } = await postJson<{ run_id: number }>('/api/pipeline/runs', {});
      setRunId(run_id);
      for (const t of TASKS) {
        setStatus((s) => ({ ...s, [t.id]: 'running' }));
        const [out] = await Promise.all([
          postJson<Record<string, unknown>>(`/api/pipeline/runs/${run_id}/${t.id}`, {}),
          sleep(t.min),
        ]);
        setStats((s) => ({ ...s, [t.id]: out }));
        setStatus((s) => ({ ...s, [t.id]: 'done' }));
      }
      setFinished(Date.now());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus((s) => {
        const next = { ...s };
        for (const k of Object.keys(next) as TaskId[]) if (next[k] === 'running') next[k] = 'failed';
        return next;
      });
    }
  }

  const ingest = stats.ingest;
  const srcRows = (system: string) => ingest?.sources.find((s) => s.system === system)?.rows;
  const edge = (task: TaskId): State => status[task];
  const elapsed = started ? ((finished ?? now) - started) / 1000 : 0;
  const allDone = status.publish === 'done';
  const anything = Object.values(status).some((v) => v !== 'idle');
  const dash = stats.publish?.dashboard;
  const train = stats.train;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="m-0 text-lg font-semibold leading-tight">Governed data foundation pipeline</h2>
          <p className="m-0 text-sm text-muted-foreground">
            Lakeflow job <code className="text-xs">harmoni_replenishment_daily</code> · four sources into one governed
            foundation, then the forecast, the dashboard and the agent
          </p>
        </div>
        <div className="flex items-center gap-2">
          {running && (
            <Badge variant="secondary" className="tabular-nums">
              Run #{runId} · {elapsed.toFixed(1)} s
            </Badge>
          )}
          {allDone && (
            <Badge variant="secondary" className="gap-1 tabular-nums">
              <CircleCheck aria-hidden className="size-3.5 text-success" /> Run #{runId} succeeded in{' '}
              {elapsed.toFixed(1)} s
            </Badge>
          )}
          {!anything && last?.run && (
            <span className="hidden text-xs text-muted-foreground sm:inline">
              Last run #{last.run.run_id} · {relTime(last.run.finished_at)}
            </span>
          )}
          <Button
            onClick={() => void run()}
            disabled={running}
            className="gap-1.5 bg-brand-strong text-brand-foreground hover:bg-brand-strong/90"
          >
            {running ? (
              <Loader2 aria-hidden className="size-4 animate-spin" />
            ) : (
              <Play aria-hidden className="size-4" />
            )}
            {running ? 'Running…' : anything ? 'Run again' : 'Run job'}
          </Button>
        </div>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <div ref={container} className="relative rounded-xl border bg-card/60 p-4 md:p-5">
        <svg
          aria-hidden
          className="pointer-events-none absolute inset-0 hidden lg:block"
          width={size.w}
          height={size.h}
        >
          {[0, 1, 2, 3].map((i) => (
            <Edge key={i} d={paths[`src${i}`]} state={edge('ingest')} />
          ))}
          <Edge d={paths.ml} state={edge('train')} />
          <Edge d={paths.dash} state={edge('publish')} />
          <Edge d={paths.app} state={edge('publish')} />
        </svg>

        <div className="relative grid gap-5 lg:grid-cols-[minmax(180px,0.85fr)_minmax(320px,1.45fr)_minmax(190px,0.9fr)_minmax(200px,0.95fr)] lg:gap-12">
          {/* Sources */}
          <div>
            <ColumnLabel>Sources</ColumnLabel>
            <div className="flex flex-col gap-3">
              {SOURCES.map((s, i) => {
                const st: State =
                  status.ingest === 'idle' ? 'idle' : srcRows(s.system) !== undefined ? 'done' : status.ingest;
                return (
                  <Node key={s.system} nodeRef={srcRefs[i]} state={st}>
                    <div className="flex items-start gap-2.5">
                      <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-secondary">
                        <s.icon aria-hidden className="size-4" />
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="m-0 text-sm font-semibold leading-tight">{s.title}</p>
                        <p className="m-0 text-xs leading-snug text-muted-foreground">{s.subtitle}</p>
                      </div>
                    </div>
                    <div className="mt-2 flex items-center justify-between gap-2 text-xs">
                      <span className="rounded bg-secondary px-1.5 py-0.5 text-[11px] font-medium">{s.kind}</span>
                      {srcRows(s.system) !== undefined ? (
                        <span className="flex items-center gap-1 font-medium tabular-nums">
                          <CircleCheck aria-hidden className="size-3.5 text-success" />
                          {nf(srcRows(s.system)!)} rows
                        </span>
                      ) : status.ingest === 'running' ? (
                        <span className="text-muted-foreground">Reading…</span>
                      ) : null}
                    </div>
                  </Node>
                );
              })}
            </div>
          </div>

          {/* Foundation */}
          <div>
            <ColumnLabel>Unity Catalog</ColumnLabel>
            <div
              ref={foundationRef}
              className={cn(
                'flex min-h-[340px] flex-col gap-3 rounded-xl border-2 p-3 transition-colors md:p-4',
                status.ingest === 'idle'
                  ? 'border-dashed border-border bg-background/40'
                  : 'border-foreground/15 bg-background'
              )}
            >
              <div className="flex items-start gap-2">
                <ShieldCheck aria-hidden className="mt-0.5 size-5 shrink-0 text-brand" />
                <div className="min-w-0">
                  <p className="m-0 text-sm font-semibold leading-tight">Unified governed data foundation</p>
                  <p className="m-0 text-xs text-muted-foreground">
                    Catalog <code>{config.uc.catalog}</code> · one record per product × store × day
                  </p>
                </div>
              </div>

              {status.ingest === 'idle' ? (
                <div className="flex flex-1 flex-col items-center justify-center gap-1 rounded-lg border border-dashed px-4 py-8 text-center">
                  <p className="m-0 text-sm font-medium">Empty</p>
                  <p className="m-0 max-w-64 text-xs text-muted-foreground">
                    Run the job to land the four sources and build the bronze, silver and gold tables.
                  </p>
                </div>
              ) : (
                <div className="flex flex-col gap-2">
                  <Medallion tier="Bronze" table={config.uc.bronze} rows={ingest?.rows} state={status.ingest}>
                    <p className="m-0 mb-1">Raw JSON as received, tagged with its source and load time</p>
                    <ul className="m-0 grid list-none gap-x-3 gap-y-0.5 p-0 sm:grid-cols-2">
                      {ingest?.sources.map((s) => (
                        <li key={s.system} className="flex justify-between gap-2">
                          <span>{SHORT[s.system] ?? s.label}</span>
                          <span className="tabular-nums text-foreground">{nf(s.rows)}</span>
                        </li>
                      ))}
                    </ul>
                  </Medallion>
                  <Medallion tier="Silver" table={config.uc.silver} rows={stats.silver?.rows} state={status.silver}>
                    <ul className="m-0 grid list-none gap-0.5 p-0">
                      {stats.silver?.expectations.map((e) => (
                        <li key={e.rule} className="flex items-start gap-1">
                          {e.failed > 0 ? (
                            <CircleAlert aria-label="Rows caught" className="mt-0.5 size-3 shrink-0 text-warning" />
                          ) : (
                            <CircleCheck aria-label="Passed" className="mt-0.5 size-3 shrink-0 text-success" />
                          )}
                          <span>
                            {e.rule}
                            {e.failed > 0 ? (
                              <span className="text-foreground">
                                {' '}
                                · {nf(e.failed)} {e.action.charAt(0).toLowerCase() + e.action.slice(1)}
                              </span>
                            ) : (
                              <span> · {e.action}</span>
                            )}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </Medallion>
                  <Medallion tier="Gold" table={config.uc.gold} rows={stats.gold?.rows} state={status.gold}>
                    {stats.gold?.grain}. Also{' '}
                    {stats.gold?.related.map((r, i) => (
                      <span key={r.table}>
                        {i > 0 && ' and '}
                        <code>{r.table.split('.').pop()}</code> ({nf(r.rows)})
                      </span>
                    ))}
                    .
                  </Medallion>
                  {status.gold === 'done' && (
                    <div className="rise-in grid gap-2 border-t pt-2 text-xs sm:grid-cols-3">
                      <p className="m-0 flex items-start gap-1.5">
                        <Network aria-hidden className="mt-0.5 size-3.5 shrink-0" />
                        <span>
                          <span className="font-semibold">Lineage</span>
                          <span className="text-muted-foreground">
                            {' '}
                            captured source → bronze → silver → gold, to the column
                          </span>
                        </span>
                      </p>
                      <p className="m-0 flex items-start gap-1.5">
                        <CircleCheck aria-hidden className="mt-0.5 size-3.5 shrink-0" />
                        <span>
                          <span className="font-semibold">Quality</span>
                          <span className="text-muted-foreground">
                            {' '}
                            {stats.silver?.expectations.length} expectations, {stats.silver?.quarantined} rows
                            quarantined
                          </span>
                        </span>
                      </p>
                      <p className="m-0 flex items-start gap-1.5">
                        <Lock aria-hidden className="mt-0.5 size-3.5 shrink-0" />
                        <span>
                          <span className="font-semibold">Access</span>
                          <span className="text-muted-foreground"> row filter by store, member identity masked</span>
                        </span>
                      </p>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* ML */}
          <div className="lg:flex lg:flex-col lg:justify-center">
            <ColumnLabel>Machine learning</ColumnLabel>
            <Node nodeRef={mlRef} state={status.train}>
              <div className="flex items-start gap-2.5">
                <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-secondary">
                  <BrainCircuit aria-hidden className="size-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="m-0 text-sm font-semibold leading-tight">Forecasting ML job</p>
                  <p className="m-0 text-xs text-muted-foreground">MLflow registered model</p>
                  <code className="block break-all text-[11px] leading-snug text-muted-foreground">
                    {config.uc.model}
                  </code>
                </div>
                <StateIcon state={status.train} />
              </div>
              {status.train === 'running' && (
                <p className="m-0 mt-2 text-xs text-muted-foreground">Training on gold, backtesting last week…</p>
              )}
              {train && (
                <div className="rise-in mt-2 flex flex-col gap-1.5 text-xs">
                  <div className="flex items-center gap-1.5">
                    <Badge variant="secondary" className="px-1.5 py-0 text-[11px]">
                      v{train.version} · Production
                    </Badge>
                    <span className="text-muted-foreground">{nf(train.train_rows)} training rows</span>
                  </div>
                  <div className="grid grid-cols-2 gap-1.5">
                    <Tile label="Forecast error" value={`${train.metrics.wape}%`} />
                    <Tile label="Spreadsheet today" value={`${train.metrics.wape_spreadsheet}%`} />
                  </div>
                  <p className="m-0 text-muted-foreground">
                    Drift monitor: travel bookings ×{train.drift.ratio} vs the 7 weeks before ({train.drift.status}).
                  </p>
                  <p className="m-0 text-muted-foreground">
                    {nf(train.forecast_rows)} forecasts · next {train.horizon_days} days with P10–P90
                  </p>
                </div>
              )}
            </Node>
          </div>

          {/* Outputs */}
          <div className="flex flex-col gap-3 lg:justify-center">
            <ColumnLabel>Outputs</ColumnLabel>
            <Node nodeRef={dashRef} state={status.publish}>
              <div className="flex items-start gap-2.5">
                <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-secondary">
                  <LayoutDashboard aria-hidden className="size-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="m-0 text-sm font-semibold leading-tight">Insights dashboard</p>
                  <p className="m-0 text-xs text-muted-foreground">AI/BI · availability and waste</p>
                </div>
                <StateIcon state={status.publish} />
              </div>
              {dash && (
                <div className="rise-in mt-2 grid grid-cols-2 gap-1.5">
                  <Tile label="In stock, next 7 days" value={`${dash.projected_in_stock}%`} />
                  <Tile label="SKU-stores at risk" value={nf(dash.at_risk)} tone="bad" />
                  <Tile label="Sales at risk" value={moneyK(dash.lost_sales_7d)} tone="bad" />
                  <Tile label="Fresh waste risk" value={moneyK(dash.fresh_waste_risk)} tone="bad" />
                </div>
              )}
              {dash && config.dashboard_url && (
                <a
                  href={config.dashboard_url}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-brand-text hover:underline"
                >
                  Open in Databricks <ExternalLink aria-hidden className="size-3" />
                </a>
              )}
            </Node>
            <Node nodeRef={appRef} state={status.publish}>
              <div className="flex items-start gap-2.5">
                <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-secondary">
                  <Bot aria-hidden className="size-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="m-0 text-sm font-semibold leading-tight">Agent Decisions app</p>
                  <p className="m-0 text-xs text-muted-foreground">Databricks App · a planner approves</p>
                </div>
                <StateIcon state={status.publish} />
              </div>
              {stats.publish && (
                <div className="rise-in mt-2 flex flex-col gap-2">
                  <p className="m-0 text-xs">
                    <span className="font-semibold tabular-nums">{stats.publish.signals}</span> signals ·{' '}
                    <span className="font-semibold tabular-nums">{stats.publish.recommendations}</span> recommendations
                    waiting
                  </p>
                  <Button size="sm" onClick={onOpenDecisions} className="gap-1.5">
                    Open Agent Decisions <ArrowRight aria-hidden className="size-4" />
                  </Button>
                </div>
              )}
            </Node>
          </div>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
        <RunLog status={status} stats={stats} />
        <Governance stats={stats} status={status} config={config} />
      </div>

      {dash && train && <DashboardPreview dash={dash} metrics={train.metrics} />}
    </div>
  );
}

function summary(task: TaskId, stats: RunStats): string {
  if (task === 'ingest' && stats.ingest)
    return `${nf(stats.ingest.rows)} rows from ${stats.ingest.sources.length} sources`;
  if (task === 'silver' && stats.silver)
    return `${nf(stats.silver.rows)} rows · ${stats.silver.duplicates} duplicates dropped · ${stats.silver.quarantined} quarantined · ${nf(stats.silver.masked)} identities masked`;
  if (task === 'gold' && stats.gold)
    return `${nf(stats.gold.rows)} store × SKU positions · ${stats.gold.related.map((r) => nf(r.rows)).join(' + ')} supporting rows`;
  if (task === 'train' && stats.train)
    return `Model v${stats.train.version} · error ${stats.train.metrics.wape}% vs ${stats.train.metrics.wape_spreadsheet}% spreadsheet · ${nf(stats.train.forecast_rows)} forecasts`;
  if (task === 'publish' && stats.publish)
    return `${stats.publish.signals} signals and ${stats.publish.recommendations} recommendations raised`;
  return '';
}

function RunLog({ status, stats }: { status: Record<TaskId, State>; stats: RunStats }) {
  return (
    <section aria-labelledby="runlog" className="rounded-xl border bg-card p-4">
      <h3 id="runlog" className="m-0 mb-3 text-sm font-semibold">
        Job tasks
      </h3>
      <ol className="m-0 flex list-none flex-col gap-2.5 p-0">
        {TASKS.map((t, i) => {
          const st = status[t.id];
          const ms = (stats[t.id] as { ms?: number } | undefined)?.ms;
          return (
            <li key={t.id} className="grid grid-cols-[20px_minmax(0,1fr)_auto] items-start gap-2">
              <StateIcon state={st} className="mt-0.5 size-4" />
              <div className="min-w-0">
                <p className={cn('m-0 text-sm', st === 'idle' ? 'text-muted-foreground' : 'font-medium')}>
                  {i + 1}. {t.label}
                </p>
                {st === 'done' && <p className="m-0 text-xs text-muted-foreground">{summary(t.id, stats)}</p>}
              </div>
              <span className="text-xs tabular-nums text-muted-foreground">
                {ms !== undefined ? `${(ms / 1000).toFixed(2)} s` : ''}
              </span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function Governance({ stats, status, config }: { stats: RunStats; status: Record<TaskId, State>; config: UiConfig }) {
  const ready = status.gold === 'done';
  const rows: { icon: LucideIcon; title: string; lines: string[] }[] = [
    {
      icon: Network,
      title: 'Lineage',
      lines: [
        `4 sources → ${config.uc.bronze.split('.').slice(1).join('.')} → ${config.uc.silver.split('.').slice(1).join('.')} → ${config.uc.gold.split('.').slice(1).join('.')}`,
        '→ forecast model → dashboard and Agent Decisions; every agent figure traces back to a source row',
      ],
    },
    {
      icon: CircleCheck,
      title: 'Data quality',
      lines: stats.silver
        ? [
            `${stats.silver.expectations.length} expectations on every run`,
            `${stats.silver.duplicates} replayed POS rows dropped; ${stats.silver.quarantined} bad stock and booking messages quarantined, not deleted`,
          ]
        : ['Expectations run in silver'],
    },
    {
      icon: Lock,
      title: 'Access control',
      lines: [
        'Store managers: row filter, their own store only',
        'Customer identity: hashed in silver; e-mails never leave bronze',
        'Agent app: reads gold, writes only the outbox and draft orders',
      ],
    },
  ];
  return (
    <section aria-labelledby="gov" className="rounded-xl border bg-card p-4">
      <h3 id="gov" className="m-0 mb-3 text-sm font-semibold">
        Governance in Unity Catalog
      </h3>
      <div className={cn('flex flex-col gap-3 transition-opacity', !ready && 'opacity-50')}>
        {rows.map((r) => (
          <div key={r.title} className="grid grid-cols-[20px_minmax(0,1fr)] gap-2">
            <r.icon aria-hidden className="mt-0.5 size-4 text-muted-foreground" />
            <div>
              <p className="m-0 text-sm font-medium">{r.title}</p>
              {r.lines.map((l) => (
                <p key={l} className="m-0 text-xs text-muted-foreground">
                  {l}
                </p>
              ))}
            </div>
          </div>
        ))}
        <p className="m-0 border-t pt-2 text-[11px] leading-snug text-muted-foreground">
          Demo build: the tables are materialised in a Lakebase schema with the same names and rules; in production they
          are Delta tables in Unity Catalog run by a Lakeflow job.
        </p>
      </div>
    </section>
  );
}

function DashboardPreview({ dash, metrics }: { dash: Dashboard; metrics: ModelMetrics }) {
  const maxLost = Math.max(...dash.stores.map((s) => s.lost_sales), 1);
  const maxWaste = Math.max(...dash.stores.map((s) => s.waste_risk), 1);
  return (
    <section aria-labelledby="dash" className="rise-in rounded-xl border bg-card p-4">
      <div className="mb-3 flex flex-wrap items-baseline gap-x-2">
        <h3 id="dash" className="m-0 text-sm font-semibold">
          Insights dashboard
        </h3>
        <span className="text-xs text-muted-foreground">Preview of the AI/BI dashboard the job refreshes</span>
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <table className="w-full border-collapse text-sm">
            <caption className="sr-only">Sales at risk and fresh waste risk by store</caption>
            <thead>
              <tr className="text-left text-xs text-muted-foreground">
                <th className="pb-1 font-medium">Store</th>
                <th className="pb-1 text-right font-medium">At risk</th>
                <th className="pb-1 pl-3 font-medium">Sales at risk, 7 days</th>
                <th className="pb-1 pl-3 font-medium">Fresh waste risk</th>
              </tr>
            </thead>
            <tbody>
              {dash.stores.map((s) => (
                <tr key={s.store_id} className="border-t">
                  <td className="py-1.5">{s.store}</td>
                  <td className="py-1.5 text-right tabular-nums">{s.at_risk}</td>
                  <td className="py-1.5 pl-3">
                    <Bar value={s.lost_sales} max={maxLost} label={money(s.lost_sales)} className="bg-series-demand" />
                  </td>
                  <td className="py-1.5 pl-3">
                    <Bar value={s.waste_risk} max={maxWaste} label={money(s.waste_risk)} className="bg-series-stock" />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div>
          <p className="m-0 mb-1 text-xs font-medium text-muted-foreground">
            Forecast error by category (lower is better)
          </p>
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="text-left text-xs text-muted-foreground">
                <th className="pb-1 font-medium">Category</th>
                <th className="pb-1 text-right font-medium">Model</th>
                <th className="pb-1 text-right font-medium">Spreadsheet</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(metrics.by_category).map(([c, v]) => (
                <tr key={c} className="border-t">
                  <td className="py-1.5">{c}</td>
                  <td className="py-1.5 text-right font-medium tabular-nums">{v.model}%</td>
                  <td className="py-1.5 text-right tabular-nums text-muted-foreground">{v.spreadsheet}%</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="m-0 mt-1 text-[11px] text-muted-foreground">
            Backtest {metrics.backtest_week}, {metrics.grain}; spreadsheet = last year&apos;s same days + 3%.
          </p>
        </div>
      </div>
    </section>
  );
}

function Bar({ value, max, label, className }: { value: number; max: number; label: string; className: string }) {
  return (
    <div className="flex items-center gap-2">
      <div className="h-2 w-24 shrink-0 overflow-hidden rounded-full bg-secondary md:w-32">
        <div className={cn('h-full rounded-full', className)} style={{ width: `${(100 * value) / max}%` }} />
      </div>
      <span className="text-xs tabular-nums">{label}</span>
    </div>
  );
}
