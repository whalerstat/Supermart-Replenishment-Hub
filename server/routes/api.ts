// server/routes/api.ts — HTTP surface for the two screens.
//   Screen 1 (pipeline):  POST /api/pipeline/runs, POST /api/pipeline/runs/:id/:task, GET /api/pipeline/latest
//   Screen 2 (decisions): GET /api/decisions, POST /api/decisions/recs/:id/{draft|approve|reject}
import type { Application, Request, Response } from 'express';
import { z } from 'zod';
import { approve, draftEmail, getDecisions, reject } from '../app/agent';
import { TASKS, latestRun, runTask, startRun, type TaskId } from '../app/pipeline';
import { AS_OF, SCHEMA as S, UC } from '../app/scenario';
import { bootstrap } from '../lib/bootstrap';
import { sql } from '../lib/db';
import { modelService } from '../lib/llm';

function who(req: Request): string {
  return req.header('x-forwarded-email') ?? req.header('x-forwarded-user') ?? 'local-dev';
}

function fail(res: Response, err: unknown): void {
  console.error('[api]', err);
  res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
}

const ApproveBody = z.object({ subject: z.string().min(3).max(300), body: z.string().min(20).max(6000) });
const RejectBody = z.object({ reason: z.string().max(500).optional() });

/** One pipeline run at a time: a second click while a run is going gets a 409. */
let activeRun: { id: number; startedAt: number } | null = null;

export function registerRoutes(app: Application): void {
  app.get('/api/whoami', (req, res) => {
    res.json({ email: req.header('x-forwarded-email') ?? null, user: req.header('x-forwarded-user') ?? null });
  });

  app.get('/api/config', (_req, res) => {
    res.json({
      title: 'Replenishment & Availability Hub',
      subtitle: 'Harmoni Mart · fictional data',
      persona: 'replenishment planners',
      as_of: AS_OF,
      uc: UC,
      model_service: modelService(),
      dashboard_url: process.env.DASHBOARD_URL || null,
      reset_enabled: process.env.DEMO_ALLOW_RESET === 'true',
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

  app.post('/api/pipeline/runs', async (req, res) => {
    // A run abandoned mid-way (browser closed) frees the lock after 2 minutes.
    if (activeRun && Date.now() - activeRun.startedAt < 120_000) {
      res.status(409).json({ error: `Run #${activeRun.id} is still in progress` });
      return;
    }
    try {
      const id = await startRun(who(req));
      activeRun = { id, startedAt: Date.now() };
      res.json({ run_id: id, tasks: TASKS });
    } catch (err) {
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
    if (activeRun?.id !== id) {
      res.status(409).json({ error: `Run #${id} is not the active run` });
      return;
    }
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

  app.post('/api/decisions/recs/:id/approve', async (req, res) => {
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

  app.post('/api/demo/reset', async (_req, res) => {
    if (process.env.DEMO_ALLOW_RESET !== 'true') {
      res.status(403).json({ error: 'set DEMO_ALLOW_RESET=true in app.yaml to enable' });
      return;
    }
    try {
      activeRun = null;
      res.json({ result: await bootstrap(true) });
    } catch (err) {
      fail(res, err);
    }
  });
}
