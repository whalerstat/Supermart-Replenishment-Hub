import { describe, expect, it } from 'vitest';
import { RUN_MINUTES, TASK_MINUTES, inOrder, shapeRun } from './history';

const row = (over: Record<string, unknown>) => ({
  run_id: 7,
  status: 'succeeded',
  triggered_by: 'planner@supermart.example',
  seeded: null,
  sgt_date: '2026-11-01',
  sgt_time: '14:23:05',
  duration_min: '18',
  rows_ingested: '13512',
  ...over,
});

describe('run timings', () => {
  it('adds up to 18 minutes', () => {
    expect(TASK_MINUTES).toEqual({ ingest: 4, silver: 3, gold: 3, train: 6, publish: 2 });
    expect(RUN_MINUTES).toBe(18);
  });
});

describe('shapeRun', () => {
  it('keeps a seeded scheduled run on its own date', () => {
    expect(
      shapeRun(
        row({
          run_id: 1,
          seeded: 'true',
          triggered_by: 'schedule',
          sgt_date: '2026-12-02',
          sgt_time: '05:00:00',
          duration_min: '17',
          rows_ingested: '14102',
        })
      )
    ).toEqual({
      run_id: 1,
      started_at: '2026-12-02T05:00:00+08:00',
      status: 'succeeded',
      duration_min: 17,
      triggered_by: 'schedule',
      rows_ingested: 14102,
    });
  });

  it('moves a run from the app onto the business date at its real time of day', () => {
    const run = shapeRun(row({}));
    expect(run.started_at).toBe('2026-12-07T14:23:05+08:00');
    expect(run.duration_min).toBe(18);
    expect(run.rows_ingested).toBe(13512);
  });

  it('records 18 minutes for a finished app run even without a stored duration', () => {
    expect(shapeRun(row({ duration_min: null })).duration_min).toBe(RUN_MINUTES);
  });

  it('has no duration while running or after a failure', () => {
    expect(shapeRun(row({ status: 'running', duration_min: null, rows_ingested: null }))).toMatchObject({
      status: 'running',
      duration_min: null,
      rows_ingested: null,
    });
    expect(shapeRun(row({ status: 'failed' })).duration_min).toBeNull();
  });
});

describe('inOrder', () => {
  it('keeps app runs after the runs before them on the business date', () => {
    const newer = shapeRun(row({ run_id: 8, sgt_time: '09:00:00' }));
    const older = shapeRun(row({ run_id: 7, sgt_time: '17:00:00' }));
    const seeded = shapeRun(row({ run_id: 5, seeded: 'true', sgt_date: '2026-12-06', sgt_time: '05:00:00' }));
    const [a, b, c] = inOrder([newer, older, seeded]);
    expect(c.started_at).toBe('2026-12-06T05:00:00+08:00');
    expect(b.started_at).toBe('2026-12-07T17:00:00+08:00');
    expect(a.started_at).toBe('2026-12-07T17:01:00+08:00');
  });
});
