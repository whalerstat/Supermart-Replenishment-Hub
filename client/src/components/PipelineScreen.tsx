// client/src/components/PipelineScreen.tsx — Screen 1: the governed data foundation pipeline.
// Pressing "Run job" calls the five job tasks in order (each is real work on the server); the flow
// animates as each one runs, and the foundation box fills bronze → silver → gold as tables land.
import { useCallback, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import {
  ArrowRight,
  Bot,
  BrainCircuit,
  CircleAlert,
  CircleCheck,
  Database,
  ExternalLink,
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
  dLong,
  moneyK,
  nf,
  postJson,
  sleep,
  useJson,
  type PipelineHistory,
  type PipelineRun,
  type RunStats,
  type TaskId,
  type UiConfig,
} from '../lib/api';

type State = 'idle' | 'running' | 'done' | 'failed';
// `hold` is the least time the step stays on screen (the animation totals 30 s, the medallion steps under 2 s
// each); `mins` is the mocked job time we record.
const TASKS: { id: TaskId; label: string; hold: number; mins: number }[] = [
  { id: 'ingest', label: 'Ingest three sources', hold: 1_500, mins: 4 },
  { id: 'silver', label: 'Clean, conform and mask', hold: 1_500, mins: 3 },
  { id: 'gold', label: 'Build the gold position', hold: 1_500, mins: 3 },
  { id: 'train', label: 'Train and register the forecast', hold: 17_500, mins: 6 },
  { id: 'publish', label: 'Publish dashboard and agent', hold: 8_000, mins: 2 },
];
const TOTAL_MINS = TASKS.reduce((a, t) => a + t.mins, 0);
/** Rough server time per task call, taken out of the publish hold so the run still ends at about 30 s. */
const TASK_CALL_MS = 1_200;
const IDLE: Record<TaskId, State> = { ingest: 'idle', silver: 'idle', gold: 'idle', train: 'idle', publish: 'idle' };

// The server still ingests the Postgres and relational systems separately; the diagram shows them as one raw source.
const SOURCES: { systems: string[]; title: string; short: string; subtitle: string; kind: string; icon: LucideIcon }[] =
  [
    {
      systems: ['managed_postgres', 'managed_relational'],
      title: 'Raw source',
      short: 'Raw source',
      subtitle: 'POS, orders, ERP, history',
      kind: 'Databases',
      icon: Database,
    },
    {
      systems: ['saas_stock_api'],
      title: 'SaaS API · stock levels',
      short: 'Stock API',
      subtitle: 'Counts every 4 h',
      kind: 'Real-time API',
      icon: PackageSearch,
    },
    {
      systems: ['saas_customer_api'],
      title: 'SaaS API · customer behaviour',
      short: 'Customer API',
      subtitle: 'Travel bookings',
      kind: 'Real-time API',
      icon: Plane,
    },
  ];

const APP_TABLES = ['agent_signals', 'agent_recommendations', 'decision_log', 'outbox'];

function useFlowPaths(
  container: RefObject<HTMLDivElement | null>,
  nodes: Record<string, RefObject<HTMLElement | null>>,
  deps: unknown[]
) {
  const [paths, setPaths] = useState<Record<string, string>>({});
  const [tag, setTag] = useState<{ x: number; y: number } | null>(null);
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
    let nextTag: { x: number; y: number } | null = null;
    const f = box('foundation');
    const ml = box('ml');
    for (let i = 0; i < SOURCES.length; i++) {
      const s = box(`src${i}`);
      if (s && f) out[`src${i}`] = curve({ x: s.r, y: s.cy }, { x: f.l, y: f.t + 56 + i * 12 });
    }
    if (f) {
      // Keep every foundation-side anchor inside the box, whatever the column heights are.
      const onF = (y: number) => Math.min(Math.max(y, f.t + 24), f.b - 24);
      if (ml) {
        let train = Math.min(ml.t + 26, ml.cy);
        let back = Math.max(ml.b - 26, ml.cy);
        // Before training the ML node is short, so keep the two edges visibly apart.
        if (back - train < 24) {
          train = ml.cy - 12;
          back = ml.cy + 12;
        }
        out.ml = curve({ x: f.r, y: onF(train) }, { x: ml.l, y: train });
        out.back = curve({ x: ml.l, y: back }, { x: f.r, y: onF(back) });
        nextTag = { x: (f.r + ml.l) / 2, y: back };
      }
      for (const k of ['dash', 'app']) {
        const o = box(k);
        if (o) out[k] = curve({ x: f.r, y: onF(o.cy) }, { x: o.l, y: o.cy });
      }
    }
    setPaths((prev) => (JSON.stringify(prev) === JSON.stringify(out) ? prev : out));
    setTag((prev) => (prev?.x === nextTag?.x && prev?.y === nextTag?.y ? prev : nextTag));
    setSize((prev) => (prev.w === rb.width && prev.h === rb.height ? prev : { w: rb.width, h: rb.height }));
  }, [container]);
  useLayoutEffect(() => {
    measure();
    const ro = new ResizeObserver(measure);
    if (container.current) ro.observe(container.current);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [measure, ...deps]);
  return { paths, tag, size };
}

const ARROW_CLASS: Record<string, string> = {
  idle: 'stroke-border',
  running: 'stroke-brand',
  done: 'stroke-foreground/45',
  failed: 'stroke-destructive',
  success: 'stroke-success',
};

function Arrowheads() {
  return (
    <defs>
      {Object.entries(ARROW_CLASS).map(([k, cls]) => (
        <marker
          key={k}
          id={`pf-arrow-${k}`}
          viewBox="0 0 8 8"
          refX="7"
          refY="4"
          markerWidth="8"
          markerHeight="8"
          markerUnits="userSpaceOnUse"
          orient="auto"
        >
          <path d="M1 1 L7 4 L1 7" fill="none" strokeWidth={1.5} strokeLinecap="round" className={cls} />
        </marker>
      ))}
    </defs>
  );
}

function Edge({ d, state, tone }: { d?: string; state: State; tone?: 'success' }) {
  if (!d) return null;
  const arrow = state === 'done' && tone === 'success' ? 'success' : state;
  return (
    <path
      d={d}
      fill="none"
      strokeWidth={state === 'idle' ? 1.5 : 2}
      strokeLinecap="round"
      strokeDasharray={state === 'idle' ? '3 5' : undefined}
      markerEnd={`url(#pf-arrow-${arrow})`}
      className={cn(
        state === 'idle' && 'stroke-border',
        state === 'running' && 'flow-active stroke-brand',
        state === 'done' && (tone === 'success' ? 'stroke-success' : 'stroke-foreground/45'),
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
  if (state === 'running')
    return <Loader2 aria-label="Running" className={cn(className, 'motion-safe:animate-spin text-brand')} />;
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
            <Loader2 aria-label="Building" className="size-4 motion-safe:animate-spin text-brand" />
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

function SyncConnector({ state }: { state: State }) {
  const label = state === 'running' ? 'Syncing' : state === 'done' ? 'Synced' : 'Not synced yet';
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pl-6">
      <svg aria-hidden width="10" height="34" viewBox="0 0 10 34" className="shrink-0 overflow-visible">
        <path
          d="M5 0 V26 M1 22 L5 30 L9 22"
          fill="none"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeDasharray={state === 'idle' ? '3 5' : undefined}
          className={cn(
            state === 'idle' && 'stroke-border',
            state === 'running' && 'flow-active stroke-brand',
            state === 'done' && 'stroke-success',
            state === 'failed' && 'stroke-destructive'
          )}
        />
      </svg>
      <span
        role="status"
        className={cn(
          'rounded-full border px-2 py-0.5 text-xs font-semibold',
          state === 'done' ? 'border-success/40 text-success' : 'text-muted-foreground',
          state === 'running' && 'border-brand text-brand-text'
        )}
      >
        Synced table · continuous<span className="sr-only">: {label}</span>
      </span>
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

export function PipelineScreen({
  config,
  onOpenDecisions,
  onRunComplete,
}: {
  config: UiConfig;
  onOpenDecisions: () => void;
  onRunComplete?: () => void;
}) {
  const [status, setStatus] = useState<Record<TaskId, State>>(IDLE);
  const [stats, setStats] = useState<RunStats>({});
  const [runId, setRunId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [historyKey, setHistoryKey] = useState(0);
  const history = useJson<PipelineHistory>('/api/pipeline/history', historyKey);
  // The screen tabs are gone, so after a reload this button is the only way to decisions an earlier run made.
  const decisionsReady = Boolean(
    history.data?.runs.some((r) => r.triggered_by !== 'schedule' && r.status === 'succeeded')
  );

  const running = Object.values(status).includes('running');

  const container = useRef<HTMLDivElement>(null);
  const src0 = useRef<HTMLDivElement>(null);
  const src1 = useRef<HTMLDivElement>(null);
  const src2 = useRef<HTMLDivElement>(null);
  const foundationRef = useRef<HTMLDivElement>(null);
  const mlRef = useRef<HTMLDivElement>(null);
  const dashRef = useRef<HTMLDivElement>(null);
  const appRef = useRef<HTMLDivElement>(null);
  const srcRefs = [src0, src1, src2];
  const { paths, tag, size } = useFlowPaths(
    container,
    { src0, src1, src2, foundation: foundationRef, ml: mlRef, dash: dashRef, app: appRef },
    [status, stats]
  );

  async function run() {
    setError(null);
    setStats({});
    setStatus(IDLE);
    try {
      const { run_id } = await postJson<{ run_id: number }>('/api/pipeline/runs', {});
      setRunId(run_id);
      setHistoryKey((k) => k + 1);
      for (const t of TASKS) {
        setStatus((s) => ({ ...s, [t.id]: 'running' }));
        const call = () => postJson<Record<string, unknown>>(`/api/pipeline/runs/${run_id}/${t.id}`, {});
        let out: Record<string, unknown>;
        if (t.id === 'publish') {
          // Hold first, then publish, so the server finishes (and frees the run lock) when the animation
          // does rather than at the start of the last step.
          await sleep(Math.max(0, t.hold - TASK_CALL_MS));
          out = await call();
        } else {
          // The call and the hold overlap, so a fast medallion step really fills in under 2 s.
          [out] = await Promise.all([call(), sleep(t.hold)]);
        }
        setStats((s) => ({ ...s, [t.id]: out }));
        setStatus((s) => ({ ...s, [t.id]: 'done' }));
      }
      onRunComplete?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus((s) => {
        const next = { ...s };
        for (const k of Object.keys(next) as TaskId[]) if (next[k] === 'running') next[k] = 'failed';
        return next;
      });
    } finally {
      setHistoryKey((k) => k + 1);
    }
  }

  const ingest = stats.ingest;
  const srcRows = (systems: string[]) => {
    const found = ingest?.sources.filter((s) => systems.includes(s.system)) ?? [];
    return found.length ? found.reduce((a, s) => a + s.rows, 0) : undefined;
  };
  const edge = (task: TaskId): State => status[task];
  const step = TASKS.findIndex((t) => status[t.id] === 'running') + 1;
  const allDone = status.publish === 'done';
  const anything = Object.values(status).some((v) => v !== 'idle');
  const dash = stats.publish?.dashboard;
  const train = stats.train;
  const silver = stats.silver;
  const checks = silver?.expectations.length ?? 0;
  const checksPassed = checks - (silver?.expectations.filter((e) => e.failed > 0).length ?? 0);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="m-0 text-lg font-semibold leading-tight">Governed data foundation pipeline</h2>
          <p className="m-0 text-sm text-muted-foreground">
            Lakeflow job <code className="text-xs">supermart_replenishment_daily</code>
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="sr-only" aria-live="polite">
            {running && step > 0 ? `Step ${step} of ${TASKS.length}: ${TASKS[step - 1].label}` : ''}
            {allDone ? `Run #${runId} succeeded in ${TOTAL_MINS} minutes` : ''}
          </span>
          {running && (
            <Badge variant="secondary" className="tabular-nums">
              Run #{runId} · step {step} of {TASKS.length}
            </Badge>
          )}
          {allDone && (
            <Badge variant="secondary" className="gap-1 tabular-nums">
              <CircleCheck aria-hidden className="size-3.5 text-success" /> Run #{runId} succeeded in {TOTAL_MINS} min
            </Badge>
          )}
          <Button
            onClick={() => void run()}
            disabled={running}
            className="gap-1.5 bg-brand-strong text-brand-foreground hover:bg-brand-strong/90"
          >
            {running ? (
              <Loader2 aria-hidden className="size-4 motion-safe:animate-spin" />
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
          <Arrowheads />
          {SOURCES.map((s, i) => (
            <Edge key={s.short} d={paths[`src${i}`]} state={edge('ingest')} />
          ))}
          <Edge d={paths.ml} state={edge('train')} />
          <Edge d={paths.back} state={edge('train')} tone="success" />
          <Edge d={paths.dash} state={edge('publish')} />
          <Edge d={paths.app} state={edge('publish')} />
        </svg>
        {tag && paths.back && (
          <span
            aria-hidden
            style={{ left: tag.x, top: tag.y }}
            className={cn(
              'pointer-events-none absolute z-10 hidden -translate-x-1/2 -translate-y-1/2 rounded-full border bg-card px-1.5 text-[10px] font-semibold leading-4 lg:block',
              status.train === 'done' ? 'border-success/40 text-success' : 'text-muted-foreground',
              status.train === 'running' && 'border-brand text-brand-text'
            )}
          >
            forecast
          </span>
        )}

        <div className="relative grid gap-5 lg:grid-cols-[minmax(170px,0.75fr)_minmax(400px,2fr)_minmax(220px,1fr)] lg:gap-x-14">
          {/* Sources */}
          <div>
            <ColumnLabel>Sources</ColumnLabel>
            <div className="flex flex-col gap-3">
              {SOURCES.map((s, i) => {
                const st: State =
                  status.ingest === 'idle' ? 'idle' : srcRows(s.systems) !== undefined ? 'done' : status.ingest;
                return (
                  <Node key={s.short} nodeRef={srcRefs[i]} state={st}>
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
                      {srcRows(s.systems) !== undefined ? (
                        <span className="flex items-center gap-1 font-medium tabular-nums">
                          <CircleCheck aria-hidden className="size-3.5 text-success" />
                          {nf(srcRows(s.systems)!)} rows
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
          <div className="flex flex-col">
            <ColumnLabel>Unity Catalog</ColumnLabel>
            <div
              ref={foundationRef}
              className={cn(
                'flex min-h-[340px] flex-1 flex-col gap-3 rounded-xl border-2 p-3 transition-colors md:p-4',
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
                    Catalog <code>{config.uc.catalog}</code>
                  </p>
                </div>
              </div>

              <div
                className={cn(
                  'flex flex-1 flex-col gap-2 rounded-lg border bg-card p-3',
                  status.ingest === 'idle' && 'border-dashed'
                )}
              >
                <div className="flex flex-wrap items-baseline justify-between gap-x-2">
                  <p className="m-0 text-sm font-semibold">
                    Managed relational databases{' '}
                    <span className="font-normal text-muted-foreground">· Databricks Lakehouse</span>
                  </p>
                  <span className="text-xs font-semibold text-muted-foreground">
                    {status.ingest === 'idle' ? 'Empty' : status.gold === 'done' ? 'Ready' : 'Building'}
                  </span>
                </div>
                {status.ingest === 'idle' ? (
                  <div className="flex flex-1 flex-col items-center justify-center gap-1 rounded-lg border border-dashed px-4 py-8 text-center">
                    <p className="m-0 text-sm font-medium">No tables yet</p>
                    <p className="m-0 text-xs text-muted-foreground">Run the job to build them.</p>
                  </div>
                ) : (
                  <div className="flex flex-col gap-2">
                    <Medallion tier="Bronze" table={config.uc.bronze} rows={ingest?.rows} state={status.ingest}>
                      <ul className="m-0 grid list-none gap-x-3 gap-y-0.5 p-0 sm:grid-cols-3">
                        {SOURCES.map((s) => (
                          <li key={s.short} className="flex justify-between gap-2">
                            <span>{s.short}</span>
                            <span className="tabular-nums text-foreground">{nf(srcRows(s.systems) ?? 0)}</span>
                          </li>
                        ))}
                      </ul>
                    </Medallion>
                    <Medallion tier="Silver" table={config.uc.silver} rows={silver?.rows} state={status.silver}>
                      {checksPassed} of {checks} checks passed · {nf(silver?.quarantined ?? 0)} rows quarantined
                    </Medallion>
                    <Medallion tier="Gold" table={config.uc.gold} rows={stats.gold?.rows} state={status.gold}>
                      {stats.gold?.grain} ·{' '}
                      {stats.gold?.related.map((r, i) => (
                        <span key={r.table}>
                          {i > 0 && ', '}
                          <code>{r.table.split('.').pop()}</code> ({nf(r.rows)})
                        </span>
                      ))}
                    </Medallion>
                    {status.gold === 'done' && (
                      <ul className="rise-in m-0 flex list-none flex-wrap gap-x-4 gap-y-1 border-t p-0 pt-2 text-xs font-medium">
                        <li className="flex items-center gap-1.5">
                          <Network aria-hidden className="size-3.5" /> Column lineage
                        </li>
                        <li className="flex items-center gap-1.5">
                          <CircleCheck aria-hidden className="size-3.5" /> Quality checks
                        </li>
                        <li className="flex items-center gap-1.5">
                          <Lock aria-hidden className="size-3.5" /> Row filters, masked identities
                        </li>
                      </ul>
                    )}
                  </div>
                )}
                {status.train !== 'idle' && (
                  <div
                    className={cn(
                      'rise-in rounded-lg border bg-card p-3',
                      status.train === 'running' && 'border-brand'
                    )}
                  >
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span aria-hidden className="size-3 shrink-0 rounded-full bg-brand ring-2 ring-card" />
                      <span className="text-xs font-semibold uppercase tracking-wide">Forecast</span>
                      <code className="min-w-0 truncate text-xs text-muted-foreground">{config.uc.model}</code>
                      <span className="ml-auto text-sm font-semibold tabular-nums">
                        {train ? (
                          <>
                            {nf(train.forecast_rows)}
                            <span className="text-xs font-normal text-muted-foreground"> forecasts</span>
                          </>
                        ) : (
                          <Loader2 aria-label="Training" className="size-4 motion-safe:animate-spin text-brand" />
                        )}
                      </span>
                    </div>
                  </div>
                )}
              </div>

              <SyncConnector state={status.publish} />

              <div
                className={cn(
                  'flex flex-col gap-2 rounded-lg border bg-card p-3',
                  status.publish !== 'done' && 'border-dashed'
                )}
              >
                <div className="flex flex-wrap items-baseline justify-between gap-x-2">
                  <p className="m-0 text-sm font-semibold">
                    Managed Postgres <span className="font-normal text-muted-foreground">· Databricks Lakebase</span>
                  </p>
                  <span
                    className={cn(
                      'text-xs font-semibold',
                      status.publish === 'done' ? 'text-success' : 'text-muted-foreground'
                    )}
                  >
                    {status.publish === 'done' ? 'Synced' : 'Not synced'}
                  </span>
                </div>
                {status.publish === 'done' && (
                  <ul className="rise-in m-0 flex list-none flex-wrap gap-1.5 p-0">
                    {APP_TABLES.map((t) => (
                      <li key={t} className="rounded-md border px-2 py-0.5 font-mono text-xs">
                        {t}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          </div>

          {/* ML above Outputs */}
          <div className="flex flex-col gap-5">
            <div>
              <ColumnLabel>Machine learning</ColumnLabel>
              <Node nodeRef={mlRef} state={status.train} className="min-h-40">
                <div className="flex items-start gap-2.5">
                  <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-secondary">
                    <BrainCircuit aria-hidden className="size-4" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="m-0 text-sm font-semibold leading-tight">Forecasting ML job</p>
                    <p className="m-0 text-xs leading-snug text-muted-foreground">Many Models Forecasting</p>
                  </div>
                  <StateIcon state={status.train} />
                </div>
                {train && (
                  <div className="rise-in mt-2 flex flex-col gap-1.5 text-xs">
                    <div className="flex flex-wrap items-center gap-x-1.5">
                      <Badge variant="secondary" className="px-1.5 py-0 text-[11px]">
                        v{train.version} · Production
                      </Badge>
                      <span className="text-muted-foreground">
                        {nf(train.forecast_rows)} forecasts · {train.horizon_days} days
                      </span>
                    </div>
                    <div className="grid grid-cols-2 gap-1.5">
                      <Tile label="Forecast error" value={`${train.metrics.wape}%`} />
                      <Tile label="Spreadsheet" value={`${train.metrics.wape_spreadsheet}%`} />
                    </div>
                  </div>
                )}
              </Node>
            </div>

            <div className="flex flex-col gap-3">
              <ColumnLabel>Outputs</ColumnLabel>
              <Node nodeRef={dashRef} state={status.publish}>
                <div className="flex items-start gap-2.5">
                  <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-secondary">
                    <LayoutDashboard aria-hidden className="size-4" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="m-0 text-sm font-semibold leading-tight">Insights dashboard</p>
                    <p className="m-0 text-xs text-muted-foreground">AI/BI</p>
                  </div>
                  <StateIcon state={status.publish} />
                </div>
                {dash && (
                  <div className="rise-in mt-2 grid grid-cols-2 gap-1.5">
                    <Tile label="In stock, 14 days" value={`${dash.projected_in_stock}%`} />
                    <Tile label="SKU-stores at risk" value={nf(dash.at_risk)} tone="bad" />
                    <Tile label="Sales at risk" value={moneyK(dash.lost_sales_14d)} tone="bad" />
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
                    <p className="m-0 text-xs text-muted-foreground">Databricks App</p>
                  </div>
                  <StateIcon state={status.publish} />
                </div>
                {(stats.publish || (decisionsReady && !running)) && (
                  <div className="rise-in mt-2 flex flex-col gap-2">
                    {stats.publish && (
                      <p className="m-0 text-xs">
                        <span className="font-semibold tabular-nums">{stats.publish.signals}</span> signals ·{' '}
                        <span className="font-semibold tabular-nums">{stats.publish.recommendations}</span>{' '}
                        recommendations
                      </p>
                    )}
                    <Button size="sm" onClick={onOpenDecisions} className="gap-1.5">
                      Open Agent Decisions <ArrowRight aria-hidden className="size-4" />
                    </Button>
                  </div>
                )}
              </Node>
            </div>
          </div>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
        <RunLog status={status} stats={stats} />
        <RunHistory data={history.data} error={history.error} />
      </div>
    </div>
  );
}

function summary(task: TaskId, stats: RunStats): string {
  if (task === 'ingest' && stats.ingest) return `${nf(stats.ingest.rows)} rows from ${SOURCES.length} sources`;
  if (task === 'silver' && stats.silver)
    return `${nf(stats.silver.rows)} rows · ${stats.silver.quarantined} quarantined · ${nf(stats.silver.masked)} masked`;
  if (task === 'gold' && stats.gold) return `${nf(stats.gold.rows)} store × SKU positions`;
  if (task === 'train' && stats.train)
    return `v${stats.train.version} · error ${stats.train.metrics.wape}% vs ${stats.train.metrics.wape_spreadsheet}%`;
  if (task === 'publish' && stats.publish)
    return `${stats.publish.signals} signals · ${stats.publish.recommendations} recommendations`;
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
                {st === 'done' ? `Done · ${t.mins} min` : ''}
              </span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

// The server writes the start in the business calendar; read the wall clock as written rather than converting it.
const startLabel = (iso: string) => `${dLong(iso.slice(0, 10))} · ${iso.slice(11, 16)}`;

function RunStatus({ status }: { status: PipelineRun['status'] }) {
  if (status === 'succeeded')
    return (
      <span className="inline-flex items-center gap-1">
        <CircleCheck aria-hidden className="size-3.5 text-success" /> Succeeded
      </span>
    );
  if (status === 'failed')
    return (
      <span className="inline-flex items-center gap-1">
        <CircleAlert aria-hidden className="size-3.5 text-destructive" /> Failed
      </span>
    );
  return (
    <span className="inline-flex items-center gap-1">
      <Loader2 aria-hidden className="size-3.5 motion-safe:animate-spin text-brand" /> Running
    </span>
  );
}

function RunHistory({ data, error }: { data: PipelineHistory | null; error: string | null }) {
  const runs = data?.runs ?? [];
  return (
    <section aria-labelledby="history" className="rounded-xl border bg-card p-4">
      <h3 id="history" className="m-0 mb-3 text-sm font-semibold">
        Run history
      </h3>
      {!data ? (
        <p role={error ? 'alert' : 'status'} className="m-0 text-xs text-muted-foreground">
          {error ? 'Could not load run history.' : 'Loading…'}
        </p>
      ) : runs.length === 0 ? (
        <p className="m-0 text-xs text-muted-foreground">No runs yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <caption className="sr-only">Recent pipeline runs, newest first</caption>
            <thead>
              <tr className="text-left text-xs text-muted-foreground">
                <th scope="col" className="pb-1 pr-3 font-medium">
                  Run
                </th>
                <th scope="col" className="pb-1 pr-3 font-medium">
                  Started
                </th>
                <th scope="col" className="pb-1 pr-3 font-medium">
                  Status
                </th>
                <th scope="col" className="pb-1 pr-3 text-right font-medium">
                  Duration
                </th>
                <th scope="col" className="pb-1 pr-3 font-medium">
                  Trigger
                </th>
                <th scope="col" className="pb-1 text-right font-medium">
                  Rows
                </th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.run_id} className="border-t">
                  <th scope="row" className="whitespace-nowrap py-1.5 pr-3 text-left font-medium tabular-nums">
                    #{r.run_id}
                  </th>
                  <td className="whitespace-nowrap py-1.5 pr-3">{startLabel(r.started_at)}</td>
                  <td className="whitespace-nowrap py-1.5 pr-3">
                    <RunStatus status={r.status} />
                  </td>
                  <td className="whitespace-nowrap py-1.5 pr-3 text-right tabular-nums">
                    {r.duration_min === null ? '—' : `${r.duration_min} min`}
                  </td>
                  <td className="whitespace-nowrap py-1.5 pr-3 text-muted-foreground">
                    {r.triggered_by === 'schedule' ? 'Schedule' : r.triggered_by}
                  </td>
                  <td className="whitespace-nowrap py-1.5 text-right tabular-nums">
                    {r.rows_ingested === null ? '—' : nf(r.rows_ingested)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
