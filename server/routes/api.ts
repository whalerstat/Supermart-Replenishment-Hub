// server/routes/api.ts — HTTP surface for the two screens.
//   Shared view:          GET /api/pipeline/live (also returns the view), POST /api/view
//   Screen 1 (pipeline):  POST /api/pipeline/runs, GET /api/pipeline/live, GET /api/pipeline/latest,
//                         GET /api/pipeline/history
//   Screen 2 (decisions): GET /api/decisions, POST /api/decisions/recs/:id/{draft|revise|approve|reject}
//   POST /api/reset re-seeds the schema (only with DEMO_ALLOW_RESET=true)
import type { Application, Request, Response } from 'express';
import { z } from 'zod';
import { REVISE_SYSTEM, approve, draftEmail, getDecisions, reject, reviseContext } from '../app/agent';
import { TASKS, latestRun, runHistory, runTask, startRun, type TaskId } from '../app/pipeline';
import { AS_OF, SCHEMA as S, UC } from '../app/scenario';
import { bootstrap } from '../lib/bootstrap';
import { sql } from '../lib/db';
import { completeStream, modelService } from '../lib/llm';

function who(req: Request): string {
  return req.header('x-forwarded-email') ?? req.header('x-forwarded-user') ?? 'local-dev';
}

function fail(res: Response, err: unknown): void {
  console.error('[api]', err);
  res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
}

/** Deep link to the Genie space, or null when the space or the workspace host is unknown. */
function genieSpaceUrl(): string | null {
  const id = process.env.DATABRICKS_GENIE_SPACE_ID;
  const host = process.env.DATABRICKS_HOST?.replace(/^https?:\/\//, '').replace(/\/+$/, '');
  return id && host ? `https://${host}/genie/rooms/${id}` : null;
}

const ApproveBody = z.object({ subject: z.string().min(3).max(300), body: z.string().min(20).max(6000) });
const ReviseBody = z.object({
  subject: z.string().max(300),
  body: z.string().min(1).max(6000),
  instruction: z.string().trim().min(1).max(500),
});
const RejectBody = z.object({ reason: z.string().max(500).optional() });

/**
 * One pipeline run at a time: a second click while a run is going gets a 409. The lock expires after
 * RUN_IDLE_MS without a step starting (the longest step holds 17.5 s), so a stuck run cannot hold it.
 * id -1 is a claim held while a run row is being created or the schema is being reset.
 */
const RUN_IDLE_MS = 60_000;
let activeRun: { id: number; lastSeen: number } | null = null;

function runBusy(): boolean {
  return activeRun !== null && Date.now() - activeRun.lastSeen < RUN_IDLE_MS;
}

/**
 * The run plays on the server so every device shows the same progress: each step holds for its share of
 * the 30 s (bronze, silver and gold under 2 s each). Publish holds first, so decisions appear, and the
 * lock frees, as the animation ends.
 */
const HOLD_MS: Record<TaskId, number> = { ingest: 1_500, silver: 1_500, gold: 1_500, train: 17_500, publish: 8_000 };

interface LiveRun {
  run_id: number;
  tasks: Record<TaskId, 'idle' | 'running' | 'done' | 'failed'>;
  stats: Partial<Record<TaskId, unknown>>;
  error: string | null;
  finished: boolean;
}
/** The current or last run since the server started; null after a reset. */
let live: LiveRun | null = null;
/**
 * Bumped when a run starts or ends and when a reset completes, so a screen that missed the moment
 * (polls failed, tab asleep, other device) still refreshes its history and decisions.
 */
let epoch = 0;

/**
 * The view every open screen mirrors (desktop and phone): which screen, signal and recommendation are open
 * and the draft being edited. Last writer wins. `v` orders changes; `boot` tells clients the server restarted.
 */
const ViewPatch = z.object({
  tab: z.enum(['pipeline', 'decisions']).optional(),
  signal: z.number().int().min(0).max(50).optional(),
  recId: z.string().max(80).nullable().optional(),
  draftRec: z.string().max(80).nullable().optional(),
  subject: z.string().max(300).nullable().optional(),
  body: z.string().max(6000).nullable().optional(),
});
type View = Required<z.infer<typeof ViewPatch>> & { v: number };
const VIEW0: Omit<View, 'v'> = { tab: 'pipeline', signal: 0, recId: null, draftRec: null, subject: null, body: null };
let view: View = { ...VIEW0, v: 0 };
const BOOT = Date.now();
/** Bumped when a decision is recorded, so every screen refetches Agent Decisions. */
let decisionsVersion = 0;

function decided(): void {
  decisionsVersion++;
  view = { ...view, draftRec: null, subject: null, body: null, v: view.v + 1 };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function playRun(id: number): Promise<void> {
  // Keep the lock alive for as long as a step's queries run, however slow, so no run or reset overlaps.
  const keepAlive = setInterval(() => {
    if (activeRun?.id === id) activeRun.lastSeen = Date.now();
  }, 10_000);
  try {
    await playSteps(id);
  } finally {
    clearInterval(keepAlive);
    if (activeRun?.id === id) activeRun = null;
    epoch++;
  }
}

async function playSteps(id: number): Promise<void> {
  for (const task of TASKS) {
    if (live?.run_id !== id) return;
    live.tasks[task] = 'running';
    try {
      const stats =
        task === 'publish'
          ? await sleep(HOLD_MS[task]).then(() => runTask(id, task))
          : (await Promise.all([runTask(id, task), sleep(HOLD_MS[task])]))[0];
      if (live?.run_id !== id) return;
      live.stats[task] = stats;
      live.tasks[task] = 'done';
    } catch (err) {
      console.error(`[api] run #${id} ${task}`, err);
      if (live?.run_id === id) {
        live.tasks[task] = 'failed';
        live.error = err instanceof Error ? err.message : String(err);
        live.finished = true;
      }
      return;
    }
  }
  if (live?.run_id === id) live.finished = true;
}

function busyMessage(): string {
  return activeRun && activeRun.id > 0 ? `Run #${activeRun.id} is still in progress` : 'The app is being reset';
}

export function registerRoutes(app: Application): void {
  // A run the process was playing when it last stopped can never finish: close it out on start.
  void sql(`UPDATE ${S}.pipeline_runs SET status = 'failed', finished_at = now() WHERE status = 'running'`).catch(
    (err: unknown) => console.error('[api] closing interrupted runs', err)
  );

  app.get('/api/whoami', (req, res) => {
    res.json({ email: req.header('x-forwarded-email') ?? null, user: req.header('x-forwarded-user') ?? null });
  });

  app.get('/api/config', (_req, res) => {
    res.json({
      title: 'Supermart Replenishment Hub',
      subtitle: 'Supermart · 6 stores · Singapore',
      persona: 'replenishment planners',
      as_of: AS_OF,
      uc: UC,
      model_service: modelService(),
      dashboard_url: process.env.DASHBOARD_URL || null,
      reset_enabled: process.env.DEMO_ALLOW_RESET === 'true',
      genie_enabled: Boolean(process.env.DATABRICKS_GENIE_SPACE_ID),
      genie_space_url: genieSpaceUrl(),
    });
  });

  // ── Screen 1 ──
  app.get('/api/pipeline/latest', async (_req, res) => {
    try {
      const run = await latestRun();
      const [model] = await sql(
        `SELECT version, train_rows, metrics, stage FROM ${S}.ml_model_registry ORDER BY version DESC LIMIT 1`
      );
      res.json({ run, model: model ?? null, active: activeRun?.id ?? null });
    } catch (err) {
      fail(res, err);
    }
  });

  app.get('/api/pipeline/history', async (_req, res) => {
    try {
      res.json({ runs: await runHistory() });
    } catch (err) {
      fail(res, err);
    }
  });

  app.post('/api/pipeline/runs', async (req, res) => {
    if (runBusy()) {
      res.status(409).json({ error: busyMessage() });
      return;
    }
    // Claim before the first await so two near-simultaneous clicks cannot both start a run.
    activeRun = { id: -1, lastSeen: Date.now() };
    try {
      const id = await startRun(who(req));
      activeRun = { id, lastSeen: Date.now() };
      live = {
        run_id: id,
        tasks: Object.fromEntries(TASKS.map((t) => [t, 'idle'])) as LiveRun['tasks'],
        stats: {},
        error: null,
        finished: false,
      };
      epoch++;
      void playRun(id);
      res.json({ run_id: id, tasks: TASKS });
    } catch (err) {
      activeRun = null;
      fail(res, err);
    }
  });

  // Every open screen (desktop and phone) polls this and plays the same run.
  app.get('/api/pipeline/live', (_req, res) => {
    res.json({ live, epoch, view, dv: decisionsVersion, boot: BOOT });
  });

  app.post('/api/view', (req, res) => {
    const parsed = ViewPatch.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid view' });
      return;
    }
    view = { ...view, ...parsed.data, v: view.v + 1 };
    res.json({ v: view.v });
  });

  // ── Screen 2 ──
  app.get('/api/decisions', async (_req, res) => {
    try {
      res.json(await getDecisions());
    } catch (err) {
      fail(res, err);
    }
  });

  app.post('/api/decisions/recs/:id/draft', async (req, res) => {
    try {
      const draft = await draftEmail(String(req.params.id));
      if (!draft) res.status(404).json({ error: 'Recommendation not found' });
      else res.json(draft);
    } catch (err) {
      fail(res, err);
    }
  });

  // Streams the copilot's rewrite of the body as plain text chunks. 503 means no text was produced, so
  // the client keeps the planner's draft and manual editing.
  app.post('/api/decisions/recs/:id/revise', async (req, res) => {
    const parsed = ReviseBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'body and an instruction (1-500 characters) are required' });
      return;
    }
    if (!modelService()) {
      res.status(503).json({ error: 'MODEL_SERVICE is not set' });
      return;
    }
    const ctrl = new AbortController();
    let closed = false;
    // 'close' also fires after a normal end, when aborting is a no-op.
    res.on('close', () => {
      closed = true;
      ctrl.abort();
    });
    try {
      const prompt = await reviseContext(String(req.params.id), parsed.data);
      if (!prompt) {
        res.status(404).json({ error: 'Recommendation not found' });
        return;
      }
      await completeStream(
        REVISE_SYSTEM,
        prompt,
        (text) => {
          if (!res.headersSent) {
            res.status(200).set({
              'Content-Type': 'text/plain; charset=utf-8',
              'Cache-Control': 'no-cache',
              'X-Accel-Buffering': 'no',
            });
            res.flushHeaders();
          }
          res.write(text);
        },
        ctrl.signal
      );
      // EOT marks a complete rewrite: a proxy can turn res.destroy() into a clean end, so the client
      // only trusts a body that ends with it (STREAM_END in client/src/lib/api.ts).
      if (res.headersSent) res.end('\u0004');
      else res.status(503).json({ error: 'Model returned no text' });
    } catch (err) {
      if (closed) return;
      console.error('[api] revise', err);
      // Mid-stream there is no status left to change: cut the connection so the client sees a failure.
      if (res.headersSent) res.destroy();
      else res.status(503).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/decisions/recs/:id/approve', async (req, res) => {
    if (runBusy()) {
      res.status(409).json({ error: `${busyMessage()}; reload the decisions when it finishes` });
      return;
    }
    const parsed = ApproveBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'subject and body are required' });
      return;
    }
    try {
      const out = await approve(String(req.params.id), parsed.data.subject, parsed.data.body, who(req));
      if (out.status < 300) decided();
      res.status(out.status).json(out);
    } catch (err) {
      fail(res, err);
    }
  });

  app.post('/api/decisions/recs/:id/reject', async (req, res) => {
    if (runBusy()) {
      res.status(409).json({ error: `${busyMessage()}; reload the decisions when it finishes` });
      return;
    }
    const parsed = RejectBody.safeParse(req.body ?? {});
    try {
      const out = await reject(String(req.params.id), parsed.success ? (parsed.data.reason ?? '') : '', who(req));
      if (out.status < 300) decided();
      res.status(out.status).json(out);
    } catch (err) {
      fail(res, err);
    }
  });

  app.get('/api/activity', async (_req, res) => {
    try {
      const decisions = await sql(
        `SELECT id, created_at, source, actor, entity_type, entity_id, action, detail
         FROM ${S}.decision_log ORDER BY id DESC LIMIT 25`
      );
      const outbox = await sql(
        `SELECT id, created_at, channel, recipient, subject, body, status FROM ${S}.outbox ORDER BY id DESC LIMIT 25`
      );
      res.json({ decisions, outbox });
    } catch (err) {
      fail(res, err);
    }
  });

  // Re-seeds the sources and the run history; Agent Decisions stays empty until the next run.
  app.post('/api/reset', async (_req, res) => {
    if (process.env.DEMO_ALLOW_RESET !== 'true') {
      res.status(403).json({ error: 'set DEMO_ALLOW_RESET=true in app.yaml to enable' });
      return;
    }
    if (runBusy()) {
      res.status(409).json({ error: busyMessage() });
      return;
    }
    // Hold the run lock while the schema is dropped and re-seeded, so no run or second reset starts on
    // half-built tables. Release only our own claim: the lock may have expired and been taken since.
    const claim = { id: -1, lastSeen: Date.now() };
    activeRun = claim;
    const keepAlive = setInterval(() => (claim.lastSeen = Date.now()), 10_000);
    live = null;
    view = { ...VIEW0, v: view.v + 1 };
    decisionsVersion++;
    try {
      res.json({ result: await bootstrap(true) });
    } catch (err) {
      fail(res, err);
    } finally {
      clearInterval(keepAlive);
      if (activeRun === claim) activeRun = null;
      epoch++;
    }
  });
}
