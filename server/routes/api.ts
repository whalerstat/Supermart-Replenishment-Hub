// server/routes/api.ts — HTTP surface for the two screens.
//   Screen 1 (pipeline):  POST /api/pipeline/runs, POST /api/pipeline/runs/:id/:task, GET /api/pipeline/latest,
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
 * RUN_IDLE_MS without a task call (the longest step hold is 27 s), so a closed tab frees it quickly.
 * id -1 is a claim held while a run row is being created or the schema is being reset.
 */
const RUN_IDLE_MS = 60_000;
let activeRun: { id: number; lastSeen: number } | null = null;

function runBusy(): boolean {
  return activeRun !== null && Date.now() - activeRun.lastSeen < RUN_IDLE_MS;
}

function busyMessage(): string {
  return activeRun && activeRun.id > 0 ? `Run #${activeRun.id} is still in progress` : 'The app is being reset';
}

export function registerRoutes(app: Application): void {
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
      res.json({ run_id: id, tasks: TASKS });
    } catch (err) {
      activeRun = null;
      fail(res, err);
    }
  });

  app.post('/api/pipeline/runs/:id/:task', async (req, res) => {
    const id = Number(req.params.id);
    const task = req.params.task as TaskId;
    if (!TASKS.includes(task) || !Number.isInteger(id)) {
      res.status(400).json({ error: `task must be one of ${TASKS.join(', ')}` });
      return;
    }
    if (activeRun?.id !== id || !runBusy()) {
      res.status(409).json({ error: `Run #${id} is not the active run` });
      return;
    }
    activeRun.lastSeen = Date.now();
    try {
      const stats = await runTask(id, task);
      if (task === 'publish') activeRun = null;
      res.json(stats);
    } catch (err) {
      activeRun = null;
      fail(res, err);
    }
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
    // Hold the run lock while the schema is dropped and re-seeded, so no run starts on half-built tables.
    activeRun = { id: -1, lastSeen: Date.now() };
    try {
      res.json({ result: await bootstrap(true) });
    } catch (err) {
      fail(res, err);
    } finally {
      activeRun = null;
    }
  });
}
