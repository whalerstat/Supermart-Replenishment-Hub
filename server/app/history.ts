// server/app/history.ts — run timings and the run history shown on Screen 1.
import { AS_OF } from './scenario';

/** Minutes each task takes in the story (the browser plays them back in 90 s). */
export const TASK_MINUTES = { ingest: 4, silver: 3, gold: 3, train: 6, publish: 2 } as const;
export const RUN_MINUTES = Object.values(TASK_MINUTES).reduce((a, m) => a + m, 0);

export interface HistoryRun {
  run_id: number;
  started_at: string;
  status: 'succeeded' | 'failed' | 'running';
  duration_min: number | null;
  triggered_by: string;
  rows_ingested: number | null;
}

const num = (v: unknown): number | null => (v === null || v === undefined || v === '' ? null : Number(v));
const text = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');

/**
 * One pipeline_runs row for the history list. Expects run_id, status, triggered_by, seeded, the start as
 * Singapore sgt_date and sgt_time, duration_min and rows_ingested (see runHistory in pipeline.ts).
 */
export function shapeRun(r: Record<string, unknown>): HistoryRun {
  const seeded = r.seeded === true || r.seeded === 'true';
  const status = r.status === 'succeeded' || r.status === 'failed' ? r.status : 'running';
  // Runs started from the app happen on today's wall clock, but the story is pinned to AS_OF:
  // keep their time of day and move them onto the business date.
  const date = seeded ? text(r.sgt_date) : AS_OF;
  return {
    run_id: Number(r.run_id),
    started_at: `${date}T${text(r.sgt_time)}+08:00`,
    status,
    duration_min: status === 'succeeded' ? (num(r.duration_min) ?? (seeded ? null : RUN_MINUTES)) : null,
    triggered_by: text(r.triggered_by),
    rows_ingested: num(r.rows_ingested),
  };
}
