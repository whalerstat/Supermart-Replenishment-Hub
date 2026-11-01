// client/src/components/DecisionsScreen.tsx — Screen 2: the Replenishment Hub "Agent Decisions" app.
// Two signals from the latest pipeline run. Each reads as a thread: Signal (chart + forecast) → Why
// (customer and data insight) → Agent recommendations (two costed options) → Logged. Choosing an
// option opens the e-mail draft panel: the agent drafts, a planner edits and approves, and only
// then is the e-mail queued, the order written back to store ordering, and the decision logged.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  CircleAlert,
  CircleCheck,
  FileText,
  Info,
  Loader2,
  Mail,
  PackageX,
  RefreshCw,
  Send,
  Sparkles,
  Square,
  Trash2,
  TriangleAlert,
  Undo2,
  Users,
  X,
} from 'lucide-react';
import { Alert, AlertDescription, Badge, Button, Input, Skeleton, Textarea } from '@databricks/appkit-ui/react';
import { cn } from '../lib/utils';
import {
  HttpError,
  dLong,
  postJson,
  postStream,
  relTime,
  useJson,
  type Check,
  type Decisions,
  type Draft,
  type Rec,
  type RecPayload,
  type Signal,
  type UiConfig,
} from '../lib/api';
import { DriverBars, ForecastChart } from './ForecastChart';

function Entry({
  n,
  stage,
  title,
  meta,
  last = false,
  children,
}: {
  n: number;
  stage: string;
  title: string;
  meta?: ReactNode;
  last?: boolean;
  children: ReactNode;
}) {
  const id = `sig-${stage.toLowerCase().replace(/\s+/g, '-')}`;
  return (
    <li className="grid grid-cols-[28px_minmax(0,1fr)] gap-x-3 md:gap-x-4">
      <div className="flex flex-col items-center" aria-hidden>
        <span className="flex size-7 shrink-0 items-center justify-center rounded-full border bg-background text-xs font-semibold tabular-nums">
          {n}
        </span>
        {!last && <span className="w-px flex-1 bg-border" />}
      </div>
      <section aria-labelledby={id} className={cn('flex min-w-0 flex-col gap-3', !last && 'pb-8')}>
        <div className="flex min-h-7 flex-wrap items-baseline gap-x-2 gap-y-1">
          <h3 id={id} className="m-0 text-base font-semibold leading-7">
            <span className="text-muted-foreground">{stage} · </span>
            {title}
          </h3>
          {meta && <span className="text-xs text-muted-foreground">{meta}</span>}
        </div>
        {children}
      </section>
    </li>
  );
}

function statusChip(status: string) {
  if (status === 'e-mail sent')
    return (
      <span className="inline-flex items-center gap-1 text-xs font-medium">
        <CircleCheck aria-hidden className="size-3.5 text-success" /> E-mail sent
      </span>
    );
  return (
    <span className="inline-flex items-center gap-1 text-xs font-medium">
      <span aria-hidden className="size-2 rounded-full bg-warning" /> Awaiting decision
    </span>
  );
}

function SignalCard({ s, i, selected, onSelect }: { s: Signal; i: number; selected: boolean; onSelect: () => void }) {
  const Icon = s.payload.kind === 'stockout' ? PackageX : Trash2;
  const head = s.payload.headline[0];
  return (
    <button
      type="button"
      role="tab"
      aria-selected={selected}
      onClick={onSelect}
      className={cn(
        'flex min-w-0 flex-col gap-1.5 rounded-xl border bg-card p-3 text-left transition-colors hover:border-foreground/30 focus-visible:outline-2 focus-visible:outline-ring md:p-4',
        selected && 'border-brand ring-1 ring-brand'
      )}
    >
      <span className="flex items-center gap-2 text-xs text-muted-foreground">
        <Icon aria-hidden className={cn('size-4', selected && 'text-brand')} />
        Signal {i + 1} · {s.payload.store.store} · {s.payload.category}
        <span className="ml-auto">{statusChip(s.status)}</span>
      </span>
      <span className="text-sm font-semibold leading-snug md:text-base">{s.payload.title}</span>
      {head && (
        <span className="text-xs text-muted-foreground">
          {head.label}: <span className="font-semibold tabular-nums text-foreground">{head.value}</span>
        </span>
      )}
    </button>
  );
}

function Lines({ rec }: { rec: RecPayload }) {
  if (rec.kind === 'transfer') {
    const by = new Map<string, { name: string; total: number; parts: string[] }>();
    for (const l of rec.lines) {
      const g = by.get(l.sku) ?? { name: l.name, total: 0, parts: [] };
      g.total += l.qty;
      g.parts.push(`${l.qty} ${l.from}`);
      by.set(l.sku, g);
    }
    return (
      <LineTable
        heads={['Product', 'Units', 'From']}
        rows={[...by.entries()].map(([sku, g]) => [`${g.name}`, sku, String(g.total), g.parts.join(', ')])}
      />
    );
  }
  if (rec.kind === 'amend')
    return (
      <LineTable
        heads={['Product', 'Ordered', 'Amend to']}
        rows={rec.lines.map((l) => [l.name, l.sku, String(l.current ?? ''), String(l.qty)])}
      />
    );
  if (rec.kind === 'split') {
    const rows: string[][] = [];
    for (let i = 0; i < rec.lines.length; i += 2) {
      const a = rec.lines[i];
      const b = rec.lines[i + 1];
      rows.push([a.name, a.sku, `${a.qty} + ${b?.qty ?? 0}`, String(a.current ?? '')]);
    }
    const d1 = rec.lines[0]?.note ?? '';
    const d2 = (rec.lines[1]?.note ?? '').split(' (')[0];
    return <LineTable heads={['Product', `${d1} + ${d2}`, 'Was']} rows={rows} />;
  }
  return (
    <LineTable
      heads={['Product', 'Units', 'Packs']}
      rows={rec.lines.map((l) => [l.name, l.sku, String(l.qty), l.note ?? ''])}
    />
  );
}

function LineTable({ heads, rows }: { heads: string[]; rows: string[][] }) {
  return (
    <table className="w-full border-collapse text-xs">
      <thead>
        <tr className="text-left text-muted-foreground">
          <th className="pb-1 font-medium">{heads[0]}</th>
          <th className="pb-1 text-right font-medium">{heads[1]}</th>
          <th className="pb-1 pl-3 text-right font-medium">{heads[2]}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r[1]} className="border-t">
            <td className="py-1">
              {r[0]} <span className="text-muted-foreground">{r[1]}</span>
            </td>
            <td className="py-1 text-right font-medium tabular-nums">{r[2]}</td>
            <td className="py-1 pl-3 text-right tabular-nums text-muted-foreground">{r[3]}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function RecCard({ rec, selected, onSelect }: { rec: Rec; selected: boolean; onSelect: () => void }) {
  const p = rec.payload;
  const decided = rec.status !== 'proposed';
  return (
    <div
      className={cn(
        'flex min-w-0 flex-col gap-3 rounded-xl border bg-card p-3 transition-colors md:p-4',
        selected ? 'border-brand ring-1 ring-brand' : 'hover:border-foreground/30',
        rec.status === 'not chosen' || rec.status === 'rejected' ? 'opacity-70' : ''
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={rec.rank === 1 ? 'default' : 'secondary'} className="gap-1">
          {rec.rank === 1 && <Sparkles aria-hidden className="size-3" />}
          {rec.rank === 1 ? "Agent's pick" : 'Alternative'}
        </Badge>
        {decided && <Badge variant="outline">{rec.status.charAt(0).toUpperCase() + rec.status.slice(1)}</Badge>}
        <span className="ml-auto text-xs text-muted-foreground">{p.eta}</span>
      </div>
      <div>
        <p className="m-0 text-sm font-semibold leading-snug">{p.title}</p>
        <p className="m-0 mt-0.5 text-sm text-muted-foreground">{p.summary}</p>
      </div>
      <dl className="m-0 grid grid-cols-2 gap-2 xl:grid-cols-4">
        {p.impact.map((im) => (
          <div key={im.label} className="rounded-md border bg-background px-2 py-1.5">
            <dt className="text-[11px] leading-tight text-muted-foreground">{im.label}</dt>
            <dd className={cn('m-0 text-sm font-semibold tabular-nums', im.tone === 'good' && 'text-success')}>
              {im.value}
            </dd>
          </div>
        ))}
      </dl>
      <Lines rec={p} />
      <ul className="m-0 flex list-disc flex-col gap-0.5 pl-4 text-xs text-muted-foreground">
        {p.tradeoffs.map((t) => (
          <li key={t}>{t}</li>
        ))}
      </ul>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[11px] text-muted-foreground">Grounded on</span>
        {p.clause_ids.map((c) => (
          <code key={c} className="rounded bg-secondary px-1.5 py-0.5 text-[11px]">
            {c}
          </code>
        ))}
        <Button
          size="sm"
          variant={selected ? 'default' : 'outline'}
          className="ml-auto gap-1.5"
          onClick={onSelect}
          aria-pressed={selected}
        >
          <Mail aria-hidden className="size-4" />
          {decided ? 'View e-mail' : selected ? 'Selected' : 'Choose and draft e-mail'}
        </Button>
      </div>
    </div>
  );
}

function CheckRow({ c }: { c: Check }) {
  const icon =
    c.status === 'pass' ? (
      <CircleCheck aria-label="Pass" className="size-4 text-success" />
    ) : c.status === 'fail' ? (
      <CircleAlert aria-label="Fail" className="size-4 text-destructive" />
    ) : c.status === 'warn' ? (
      <TriangleAlert aria-label="Check" className="size-4 text-warning" />
    ) : (
      <Info aria-label="Note" className="size-4 text-muted-foreground" />
    );
  return (
    <li className="grid grid-cols-[18px_minmax(0,1fr)] gap-2">
      <span className="mt-0.5">{icon}</span>
      <span>
        <span className="font-medium">{c.label}</span>
        <span className="block text-muted-foreground">{c.detail}</span>
      </span>
    </li>
  );
}

/** Same rules as the server's checkDraft, re-run live while the planner edits. */
function liveChecks(base: Check[], rec: RecPayload, body: string): Check[] {
  const strangers = (body.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) ?? []).filter(
    (e) => !/supermart\.example$/i.test(e)
  );
  const members = body.match(/\bM-[A-Z]{3}-\d{3,}\b/g) ?? [];
  const missing = rec.lines.filter(
    (l) =>
      !(body.toLowerCase().includes(l.sku.toLowerCase()) || body.toLowerCase().includes(l.name.toLowerCase())) ||
      !(body.includes(String(l.qty)) || body.includes(l.qty.toLocaleString('en-US')))
  );
  const cited = rec.clause_ids.filter((id) => body.includes(id));
  return base.map((c) => {
    if (c.id === 'pii')
      return strangers.length + members.length === 0
        ? { ...c, status: 'pass', detail: 'Only aggregated travel counts; member identities stay hashed in silver' }
        : { ...c, status: 'fail', detail: `Remove ${[...strangers, ...members].join(', ')} before sending` };
    if (c.id === 'lines')
      return missing.length === 0
        ? { ...c, status: 'pass', detail: `All ${rec.lines.length} lines and quantities are in the e-mail` }
        : {
            ...c,
            status: 'warn',
            detail: `Check ${missing.map((l) => l.sku).join(', ')}: quantity changed or missing`,
          };
    if (c.id === 'cite')
      return cited.length > 0
        ? { ...c, status: 'pass', detail: `Cites ${cited.join(', ')}` }
        : { ...c, status: 'warn', detail: 'No clause reference in the text' };
    return c;
  });
}

const COPILOT_CHIPS = ['Make it shorter', 'Firmer tone', 'Add the delivery date up front'];

function EmailPanel({
  signal,
  rec,
  config,
  onDecided,
}: {
  signal: Signal;
  rec: Rec | null;
  config: UiConfig;
  onDecided: () => void;
}) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState<'draft' | 'send' | 'reject' | 'copilot' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ outbox_id: number; outbox_status: string; write_back: string } | null>(null);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const [ask, setAsk] = useState('');
  const [undoBody, setUndoBody] = useState<string | null>(null);
  const [copilotNote, setCopilotNote] = useState<string | null>(null);
  const askRef = useRef<HTMLInputElement>(null);
  const copilot = useRef<AbortController | null>(null);

  async function makeDraft(id: string) {
    setBusy('draft');
    setError(null);
    setUndoBody(null);
    try {
      const d = await postJson<Draft>(`/api/decisions/recs/${encodeURIComponent(id)}/draft`, {});
      setDraft(d);
      setSubject(d.subject);
      setBody(d.body);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  useEffect(() => {
    // Null the ref too, so the aborted revise() fails its ownership check and leaves the new rec alone.
    copilot.current?.abort();
    copilot.current = null;
    setBusy(null);
    setResult(null);
    setRejecting(false);
    setReason('');
    setError(null);
    setAsk('');
    setUndoBody(null);
    setCopilotNote(null);
    if (!rec) {
      setDraft(null);
      return;
    }
    if (rec.draft) {
      setDraft(rec.draft);
      setSubject(rec.draft.subject);
      setBody(rec.draft.body);
    } else if (rec.status === 'proposed') {
      setDraft(null);
      void makeDraft(rec.rec_id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rec?.rec_id]);

  useEffect(() => () => copilot.current?.abort(), []);

  // The rewrite replaces the body as it streams, so the live checks rerun on every chunk and approve
  // sends it like any manual edit.
  async function revise(instruction: string) {
    if (!rec || busy !== null || !instruction.trim()) return;
    const before = body;
    const ctrl = new AbortController();
    copilot.current = ctrl;
    setBusy('copilot');
    // A clicked chip is disabled while streaming, which would drop focus to <body>.
    askRef.current?.focus();
    setCopilotNote(null);
    setUndoBody(before);
    try {
      const text = await postStream(
        `/api/decisions/recs/${encodeURIComponent(rec.rec_id)}/revise`,
        { subject, body: before, instruction: instruction.trim() },
        setBody,
        ctrl.signal
      );
      if (text.trim()) setBody(text.trim());
      else setBody(before);
      setAsk('');
    } catch (e) {
      if (ctrl.signal.aborted) {
        if (copilot.current === ctrl) setCopilotNote('Stopped. Undo restores the previous text.');
      } else {
        setBody(before);
        setUndoBody(null);
        setCopilotNote(
          e instanceof HttpError && e.status === 503
            ? 'Copilot unavailable. You can keep editing the e-mail by hand.'
            : `Copilot unavailable (${e instanceof Error ? e.message : String(e)}). You can keep editing by hand.`
        );
      }
    } finally {
      if (copilot.current === ctrl) {
        copilot.current = null;
        setBusy(null);
        askRef.current?.focus();
      }
    }
  }

  const checks = useMemo(() => (draft && rec ? liveChecks(draft.checks, rec.payload, body) : []), [draft, rec, body]);
  const blocked = checks.some((c) => c.status === 'fail');

  async function approve() {
    if (!rec) return;
    setBusy('send');
    setError(null);
    try {
      const out = await postJson<{ outbox_id: number; outbox_status: string; write_back: string }>(
        `/api/decisions/recs/${encodeURIComponent(rec.rec_id)}/approve`,
        { subject, body }
      );
      setResult(out);
      onDecided();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function doReject() {
    if (!rec) return;
    setBusy('reject');
    try {
      await postJson(`/api/decisions/recs/${encodeURIComponent(rec.rec_id)}/reject`, { reason });
      setRejecting(false);
      onDecided();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  const manager = signal.payload.store;
  const editable = rec && draft && busy !== 'draft' && rec.status !== 'approved' && !result;
  return (
    <section aria-labelledby="email-h" className="flex flex-col rounded-xl border bg-card lg:max-h-[calc(100dvh-2rem)]">
      <header className="flex items-center gap-2 border-b px-4 py-3">
        <Mail aria-hidden className="size-4 text-brand" />
        <h3 id="email-h" className="m-0 text-sm font-semibold">
          E-mail to the store manager
        </h3>
        {rec && (
          <Badge variant={rec.status === 'approved' || result ? 'secondary' : 'outline'} className="ml-auto">
            {result || rec.status === 'approved'
              ? 'Sent'
              : rec.status === 'proposed'
                ? 'Needs your approval'
                : rec.status}
          </Badge>
        )}
      </header>

      {!rec && (
        <div className="flex flex-col items-center gap-2 px-6 py-12 text-center">
          <span className="flex size-10 items-center justify-center rounded-full bg-secondary">
            <Mail aria-hidden className="size-5" />
          </span>
          <p className="m-0 text-sm font-medium">Choose a recommendation</p>
          <p className="m-0 max-w-72 text-xs text-muted-foreground">
            The agent drafts the e-mail to {manager.name} at {manager.store}. Nothing is sent until you approve it.
          </p>
        </div>
      )}

      {rec && busy === 'draft' && (
        <div className="flex flex-col gap-3 p-4">
          <p className="m-0 flex items-center gap-2 text-sm">
            <Loader2 aria-hidden className="size-4 animate-spin text-brand" />
            {config.model_service ? 'Claude is drafting through the AI Gateway…' : 'Drafting…'}
          </p>
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
      )}

      {error && (
        <Alert variant="destructive" className="m-4 mb-0">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {rec && draft && busy !== 'draft' && (rec.status === 'approved' || result) && (
        <div className="flex flex-col gap-3 p-4">
          <div className="flex items-start gap-2 rounded-lg border border-success/40 bg-success/10 p-3">
            <CircleCheck aria-hidden className="mt-0.5 size-4 shrink-0 text-success" />
            <div className="text-sm">
              <p className="m-0 font-semibold">Approved and sent to {manager.name}</p>
              {result ? (
                <p className="m-0 text-xs text-muted-foreground">
                  Outbox #{result.outbox_id} · {result.outbox_status}. {result.write_back}.
                </p>
              ) : (
                <p className="m-0 text-xs text-muted-foreground">
                  By {rec.decided_by} · {relTime(rec.decided_at)}
                </p>
              )}
            </div>
          </div>
          <div className="rounded-lg border bg-background p-3">
            <p className="m-0 text-xs text-muted-foreground">Subject</p>
            <p className="m-0 mb-2 text-sm font-medium">{subject}</p>
            <pre className="m-0 max-h-80 overflow-auto whitespace-pre-wrap font-sans text-sm leading-relaxed">
              {body}
            </pre>
          </div>
        </div>
      )}

      {editable && (
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
          <p className="m-0 flex items-start gap-1.5 text-xs text-muted-foreground">
            <Sparkles aria-hidden className="mt-0.5 size-3.5 shrink-0 text-brand" />
            {draft.source === 'model'
              ? `Drafted by Claude through the AI Gateway (${draft.model}) in ${(draft.ms / 1000).toFixed(1)} s, from the facts below.`
              : `Drafted from the agent's template${draft.note ? ` (model not used: ${draft.note})` : ''}.`}
          </p>
          <div className="grid grid-cols-[44px_minmax(0,1fr)] items-baseline gap-x-2 gap-y-1 text-sm">
            <span className="text-xs text-muted-foreground">To</span>
            <span className="min-w-0 truncate">
              {draft.to.name} <span className="text-muted-foreground">&lt;{draft.to.email}&gt;</span>
            </span>
            <span className="text-xs text-muted-foreground">Cc</span>
            <span className="min-w-0 truncate text-muted-foreground">{draft.cc.join(', ')}</span>
          </div>
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            Subject
            <Input
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              disabled={rec.status !== 'proposed' || busy === 'copilot'}
              className="text-sm text-foreground"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            Message (you can edit it)
            <Textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={14}
              disabled={rec.status !== 'proposed'}
              readOnly={busy === 'copilot'}
              aria-busy={busy === 'copilot'}
              className="min-h-64 text-sm leading-relaxed text-foreground"
            />
          </label>
          {rec.status === 'proposed' && (
            <form
              className="flex flex-col gap-2 rounded-lg border bg-background p-2.5"
              onSubmit={(e) => {
                e.preventDefault();
                void revise(ask);
              }}
            >
              <label htmlFor="copilot-ask" className="text-xs font-medium">
                Ask the copilot to adjust this e-mail
              </label>
              <div className="flex gap-2">
                <Input
                  ref={askRef}
                  id="copilot-ask"
                  value={ask}
                  onChange={(e) => setAsk(e.target.value)}
                  maxLength={500}
                  // readOnly, not disabled, while streaming so keyboard focus stays here next to Stop.
                  readOnly={busy === 'copilot'}
                  disabled={busy !== null && busy !== 'copilot'}
                  placeholder="e.g. Mention the DC pick is already reserved"
                  className="h-8 text-sm"
                />
                {busy === 'copilot' ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => copilot.current?.abort()}
                    className="gap-1.5"
                  >
                    <Square aria-hidden className="size-3.5" /> Stop
                  </Button>
                ) : (
                  <Button type="submit" size="sm" disabled={busy !== null || !ask.trim()} className="gap-1.5">
                    <Send aria-hidden className="size-3.5" /> Send
                  </Button>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                {COPILOT_CHIPS.map((chip) => (
                  <Button
                    key={chip}
                    type="button"
                    size="sm"
                    variant="secondary"
                    disabled={busy !== null}
                    onClick={() => void revise(chip)}
                    className="h-7 rounded-full px-2.5 text-xs"
                  >
                    {chip}
                  </Button>
                ))}
                {undoBody !== null && busy !== 'copilot' && (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setBody(undoBody);
                      setUndoBody(null);
                      setCopilotNote(null);
                    }}
                    className="ml-auto h-7 gap-1 px-2 text-xs"
                  >
                    <Undo2 aria-hidden className="size-3.5" /> Undo
                  </Button>
                )}
              </div>
              <p className="m-0 flex items-center gap-1.5 text-[11px] text-muted-foreground" aria-live="polite">
                {busy === 'copilot' ? (
                  <Loader2 aria-hidden className="size-3 text-brand motion-safe:animate-spin" />
                ) : (
                  <Sparkles aria-hidden className="size-3 text-brand" />
                )}
                Copilot · Claude Haiku 5.5 via AI Gateway{busy === 'copilot' ? ' · rewriting…' : ''}
              </p>
              {copilotNote && (
                <p role="status" className="m-0 flex items-start gap-1.5 text-xs text-muted-foreground">
                  <Info aria-hidden className="mt-0.5 size-3.5 shrink-0" />
                  {copilotNote}
                </p>
              )}
            </form>
          )}
          <div>
            <p className="m-0 mb-1 text-xs font-medium">Grounded on</p>
            <ul className="m-0 flex list-none flex-wrap gap-1.5 p-0">
              {draft.grounding.map((g) => (
                <li
                  key={g.label}
                  title={g.detail}
                  className="flex items-center gap-1 rounded border bg-background px-1.5 py-0.5 text-[11px]"
                >
                  <FileText aria-hidden className="size-3 text-muted-foreground" />
                  <span className="font-medium">{g.label}</span>
                  <span className="hidden text-muted-foreground xl:inline">
                    {g.detail.length > 42 ? `${g.detail.slice(0, 40)}…` : g.detail}
                  </span>
                </li>
              ))}
            </ul>
          </div>
          <div>
            <p className="m-0 mb-1 text-xs font-medium">Checks before sending</p>
            <ul className="m-0 flex list-none flex-col gap-1.5 p-0 text-xs">
              {checks.map((c) => (
                <CheckRow key={c.id} c={c} />
              ))}
            </ul>
          </div>
        </div>
      )}
      {editable && (
        <footer className="flex flex-col gap-2 border-t p-4">
          {rec.status === 'proposed' ? (
            <>
              <p className="m-0 rounded-md bg-secondary px-2.5 py-2 text-xs">
                <span className="font-semibold">Human in the loop.</span> Nothing leaves until you approve. Your name,
                the pipeline run and the model version are stamped on the e-mail and the decision log.
              </p>
              {rejecting ? (
                <div className="flex flex-col gap-2">
                  <Input
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    placeholder="Why reject? (optional, goes to the log)"
                  />
                  <div className="flex gap-2">
                    <Button variant="destructive" size="sm" onClick={() => void doReject()} disabled={busy !== null}>
                      Reject recommendation
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => setRejecting(false)}>
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="flex flex-wrap gap-2">
                  <Button
                    onClick={() => void approve()}
                    disabled={busy !== null || blocked || subject.trim().length < 3}
                    className="gap-1.5 bg-brand-strong text-brand-foreground hover:bg-brand-strong/90"
                  >
                    {busy === 'send' ? (
                      <Loader2 aria-hidden className="size-4 animate-spin" />
                    ) : (
                      <Send aria-hidden className="size-4" />
                    )}
                    Approve and send
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => void makeDraft(rec.rec_id)}
                    disabled={busy !== null}
                    className="gap-1.5"
                  >
                    <RefreshCw aria-hidden className="size-4" /> Redraft
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={() => setRejecting(true)}
                    disabled={busy !== null}
                    className="gap-1.5"
                  >
                    <X aria-hidden className="size-4" /> Reject
                  </Button>
                </div>
              )}
            </>
          ) : (
            <p className="m-0 text-xs text-muted-foreground">
              This recommendation is {rec.status}
              {rec.decided_by ? ` (${rec.decided_by})` : ''}.
            </p>
          )}
        </footer>
      )}
    </section>
  );
}

export function DecisionsScreen({
  config,
  visits,
  onOpenPipeline,
}: {
  config: UiConfig;
  visits: number;
  onOpenPipeline: () => void;
}) {
  const [refreshKey, setRefreshKey] = useState(0);
  // `visits` changes each time the screen is opened, so a pipeline re-run shows up immediately.
  const data = useJson<Decisions>(`/api/decisions?v=${visits}`, refreshKey);
  const [sel, setSel] = useState(0);
  const [recId, setRecId] = useState<string | null>(null);

  const signals = data.data?.signals ?? [];
  const signal = signals[Math.min(sel, Math.max(signals.length - 1, 0))];
  // A re-run replaces the signals, so a stale selection simply finds nothing here.
  const rec = signal?.recs.find((r) => r.rec_id === recId) ?? null;

  if (data.loading && !data.data) return <Skeleton className="h-[640px] w-full" />;
  if (data.error && !data.data)
    return (
      <Alert variant="destructive">
        <AlertDescription>{data.error}</AlertDescription>
      </Alert>
    );
  if (!signal)
    return (
      <div className="flex flex-col items-center gap-3 rounded-xl border bg-card px-6 py-16 text-center">
        <p className="m-0 text-sm font-medium">No signals yet</p>
        <p className="m-0 max-w-sm text-sm text-muted-foreground">
          Run the pipeline to build the foundation, train the forecast and let the agent look for problems.
        </p>
        <Button onClick={onOpenPipeline}>Go to the pipeline</Button>
      </div>
    );

  const p = signal.payload;
  const model = data.data?.model;
  const log = (data.data?.log ?? []).filter((l) => l.entity_id.startsWith(signal.signal_id));

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-x-4 gap-y-1">
        <div className="min-w-0 flex-1">
          <h2 className="m-0 text-lg font-semibold leading-tight">Agent Decisions</h2>
          <p className="m-0 text-sm text-muted-foreground">
            Replenishment agent · business date {dLong(data.data!.as_of)} · pipeline run #{signal.run_id}
            {model && (
              <>
                {' '}
                · forecast model v{model.version}, error {model.metrics.wape}% vs {model.metrics.wape_spreadsheet}% for
                the spreadsheet
              </>
            )}
          </p>
        </div>
      </div>

      <div role="tablist" aria-label="Signals" className="grid gap-3 md:grid-cols-2">
        {signals.map((s, i) => (
          <SignalCard
            key={s.signal_id}
            s={s}
            i={i}
            selected={s.signal_id === signal.signal_id}
            onSelect={() => {
              setSel(i);
              setRecId(s.recs.find((r) => r.status === 'approved')?.rec_id ?? null);
            }}
          />
        ))}
      </div>

      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(360px,440px)]">
        <ol className="m-0 list-none rounded-xl border bg-card p-4 md:p-5">
          <Entry n={1} stage="Signal" title={p.title} meta={`${p.store.store} · ${p.category}`}>
            <p className="m-0 max-w-prose text-sm text-muted-foreground">{p.summary}</p>
            <dl className="m-0 grid gap-2 sm:grid-cols-3">
              {p.headline.map((h) => (
                <div key={h.label} className="rounded-lg border bg-background px-3 py-2">
                  <dt className="text-xs text-muted-foreground">{h.label}</dt>
                  <dd
                    className={cn(
                      'm-0 text-xl font-semibold tabular-nums leading-tight',
                      h.tone === 'bad' && 'text-brand-text'
                    )}
                  >
                    {h.value}
                  </dd>
                </div>
              ))}
            </dl>
            <ForecastChart signal={p} />
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="text-left text-xs text-muted-foreground">
                  <th className="pb-1 font-medium">Product</th>
                  {p.lineHeads.map((h) => (
                    <th key={h} className="pb-1 pl-3 text-right font-medium">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {p.lines.map((l) => (
                  <tr key={l.sku} className="border-t">
                    <td className="py-1.5">
                      {l.name} <span className="text-xs text-muted-foreground">{l.sku}</span>
                    </td>
                    <td className="py-1.5 pl-3 text-right tabular-nums">{l.a}</td>
                    <td className="py-1.5 pl-3 text-right tabular-nums">{l.b}</td>
                    <td className="py-1.5 pl-3 text-right font-medium tabular-nums">{l.c}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Entry>

          <Entry n={2} stage="Why" title={p.insight.title} meta="customer and data insight">
            <div className="flex items-start gap-3 rounded-lg border border-series-driver/25 bg-series-driver/5 p-3">
              <Users aria-hidden className="mt-0.5 size-4 shrink-0 text-series-driver" />
              <div className="min-w-0">
                <p className="m-0 text-sm leading-relaxed">{p.insight.text}</p>
                <p className="m-0 mt-1 text-[11px] text-muted-foreground">{p.insight.source}</p>
              </div>
            </div>
            {p.chart.driverLabel && (
              <div className="flex flex-col gap-1">
                <p className="m-0 text-xs font-medium text-muted-foreground">{p.chart.driverLabel}</p>
                <DriverBars signal={p} />
              </div>
            )}
            <ul className="m-0 flex list-none flex-col gap-2 p-0">
              {p.drivers.map((d) => (
                <li key={d.source} className="grid gap-1 text-sm sm:grid-cols-[minmax(0,190px)_minmax(0,1fr)] sm:gap-3">
                  <span className="text-xs font-medium text-muted-foreground">{d.source}</span>
                  <span>{d.text}</span>
                </li>
              ))}
            </ul>
          </Entry>

          <Entry
            n={3}
            stage="Agent recommendations"
            title="Two ways to fix it"
            meta="costed against the forecast and the agreements"
          >
            <div className="grid gap-3 2xl:grid-cols-2">
              {signal.recs.map((r) => (
                <RecCard key={r.rec_id} rec={r} selected={r.rec_id === recId} onSelect={() => setRecId(r.rec_id)} />
              ))}
            </div>
          </Entry>

          <Entry n={4} stage="Logged" title="Decision trail" last>
            {log.length === 0 ? (
              <p className="m-0 text-sm text-muted-foreground">
                No decision yet. Approvals and rejections land here with who, when and why.
              </p>
            ) : (
              <ul className="m-0 flex list-none flex-col gap-2 p-0 text-sm">
                {log.map((l) => (
                  <li key={l.id} className="rounded-lg border bg-background px-3 py-2">
                    <p className="m-0 text-xs text-muted-foreground">
                      {relTime(l.created_at)} · {l.actor} ·{' '}
                      <span className="font-medium text-foreground">{l.action}</span>
                    </p>
                    <p className="m-0">{l.detail}</p>
                  </li>
                ))}
              </ul>
            )}
          </Entry>
        </ol>

        <aside className="lg:sticky lg:top-4">
          <EmailPanel signal={signal} rec={rec} config={config} onDecided={() => setRefreshKey((k) => k + 1)} />
        </aside>
      </div>
    </div>
  );
}
