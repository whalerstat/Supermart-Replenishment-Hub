import { describe, expect, it, vi } from 'vitest';
import type { RecPayload, SignalPayload } from './agent';

// Keeps the test off the workspace client: only the pure builders are exercised.
vi.mock('../lib/llm', () => ({ completeStream: vi.fn(), modelService: () => null }));
const { REVISE_SYSTEM, checkDraft, revisePrompt, templateDraft, withStockLevel } = await import('./agent');

const person = { name: 'Mei Tan', email: 'mei.tan@supermart.example', store: 'Supermart Changi' };
const sig = {
  title: 'Winter apparel runs out before the travel peak',
  summary: 'Stock covers 3 days',
  insight: { title: 'Travel', text: 'Members booking December trips doubled.', source: 'CDP' },
  drivers: [{ source: 'Forecast', text: 'Demand up 40%' }],
} as unknown as SignalPayload;
const rec = {
  kind: 'expedite',
  title: 'Expedite from the DC',
  summary: 'Pick 4 lines from Jurong',
  action: 'Confirm the expedited order today',
  eta: '2026-12-03',
  lines: [{ sku: 'NPK-JKT-01', name: 'Down jacket', qty: 1200 }],
  clause_ids: ['NPK-4.2'],
  recipient: person,
  approval: 'Above S$2,000 needs confirmation',
  facts: { arrives: 'Thu 3 Dec' },
} as unknown as RecPayload;

describe('revisePrompt', () => {
  const prompt = revisePrompt(
    sig,
    rec,
    [{ clause_id: 'NPK-4.2', clause_title: '§4.2 Expedited DC pick', body: 'Within 48 hours.' }],
    { subject: 'Please confirm', body: 'Hi Mei,\n- Down jacket (NPK-JKT-01): 1,200', instruction: 'Make it shorter' }
  );

  it('grounds on the recommendation facts, lines and clauses', () => {
    expect(prompt).toContain('- Down jacket (NPK-JKT-01): 1,200');
    expect(prompt).toContain('Within 48 hours.');
    expect(prompt).toContain('Thu 3 Dec');
    expect(prompt).toContain('"first_name": "Mei"');
  });

  it('carries the current e-mail and the instruction', () => {
    expect(prompt).toContain('Current subject: Please confirm');
    expect(prompt).toContain("Planner's instruction: Make it shorter");
  });

  it('never sends the manager e-mail address to the model', () => {
    expect(prompt).not.toContain('mei.tan@supermart.example');
  });

  it('asks for the body only and protects the order facts', () => {
    expect(REVISE_SYSTEM).toMatch(/only the new body text/);
    expect(REVISE_SYSTEM).toMatch(/order line, quantity, date, price and clause id/);
  });
});

describe('withStockLevel', () => {
  const series = withStockLevel(
    [
      { date: '2026-12-05', actual: 100 },
      { date: '2026-12-06', actual: 0 },
      { date: '2026-12-07', forecast: 81.3, p10: 60, p90: 99 },
      { date: '2026-12-13', forecast: 90 },
      { date: '2026-12-14', forecast: 70 },
      { date: '2026-12-15', forecast: 70 },
    ],
    '2026-12-14'
  );

  it('is units sold plus 15%, from actuals and then the forecast, in whole units', () => {
    expect(series.map((p) => p.stock_level)).toEqual([115, 0, 93, 104, undefined, undefined]);
  });

  it('keeps the other series as they are', () => {
    expect(series[0].actual).toBe(100);
    expect(series[2]).toMatchObject({ forecast: 81.3, p10: 60, p90: 99 });
  });
});

describe('templateDraft', () => {
  const manager = { name: 'Siti Rahman', email: 'siti.rahman@supermart.example', store: 'Tampines Central' };
  const s1 = {
    insight: { text: '1,032 loyalty members fly to cold destinations in the next 10 days.' },
  } as unknown as SignalPayload;
  const s2 = { insight: { text: 'Last year ran a promotion.' } } as unknown as SignalPayload;
  const stockout = {
    first_line_out: 'thermal down jackets on Tue 8 Dec',
    lines_out: '4 of 4',
    next_standard_delivery: 'PO-7716 on Mon 14 Dec',
    arrives: 'Wed 9 Dec',
    order_value: 'S$3,406',
    freight: 'S$193',
    handling_cost: 'S$338',
    share_of_need_covered: '64%',
  };
  const fresh = {
    order: 'PO-7731',
    supplier: 'Greenleaf Fresh Co.',
    delivery: 'Mon 14 Dec',
    first_delivery: 'Mon 14 Dec',
    ordered_units: '2,140',
    forecast_units: '1,262',
    amendment_cutoff: 'Thu 10 Dec, 14:00',
    waste_avoided: 'S$1,980',
    second_drop_confirmed_on: 'Tue 15 Dec',
    last_year_promotion: 'Mid-December Fresh Fest (+45%)',
    households_away_pct: '14%',
  };
  const recs = [
    {
      sig: s1,
      rec: {
        kind: 'expedite',
        lines: [{ sku: 'APP-101', name: 'Thermal down jacket', qty: 48, note: '8 packs of 6' }],
        clause_ids: ['NPK-4.2', 'OPS-2.4', 'CDP-1.0'],
        facts: stockout,
      },
    },
    {
      sig: s1,
      rec: {
        kind: 'transfer',
        lines: [{ sku: 'APP-102', name: 'Thermal base-layer top', qty: 1250, from: 'Jurong East' }],
        clause_ids: ['OPS-7.3', 'OPS-2.4', 'CDP-1.0'],
        facts: stockout,
      },
    },
    {
      sig: s2,
      rec: {
        kind: 'amend',
        lines: [{ sku: 'FRS-301', name: 'Baby bok choy 300 g', qty: 640, current: 1100 }],
        clause_ids: ['GRN-3.1', 'FRS-2.1', 'PRM-1.2', 'OPS-2.4'],
        facts: fresh,
      },
    },
    {
      sig: s2,
      rec: {
        kind: 'split',
        lines: [
          { sku: 'FRS-303', name: 'Salmon fillet 200 g', qty: 160, current: 300, note: 'Mon 14 Dec' },
          { sku: 'FRS-303', name: 'Salmon fillet 200 g', qty: 150, note: 'Wed 16 Dec (confirm on 15 Dec)' },
        ],
        clause_ids: ['GRN-3.4', 'GRN-3.1', 'PRM-1.2', 'OPS-2.4'],
        facts: fresh,
      },
    },
  ].map(({ sig, rec }) => ({
    sig,
    rec: {
      ...rec,
      recipient: manager,
      impact: [{ label: 'Sales protected', value: 'S$9,120', tone: 'good' }],
      terms: 'terms',
      approval: 'approval',
    } as unknown as RecPayload,
  }));

  it.each(recs.map((r) => [r.rec.kind, r]))('writes a complete %s e-mail that passes the checks', (_, { sig, rec }) => {
    const { subject, body } = templateDraft(sig, rec);
    expect(subject.length).toBeGreaterThan(10);
    expect(body).toMatch(/^Hi Siti,/);
    expect(body).toMatch(/Replenishment planning$/);
    expect(body).not.toMatch(/undefined|NaN|\[object/);
    expect(body).not.toMatch(/fictional|demo/i);
    const checks = checkDraft(rec, body);
    expect(checks.filter((c) => c.status === 'warn' || c.status === 'fail')).toEqual([]);
  });

  it('counts sales protected over 14 days', () => {
    expect(templateDraft(recs[0].sig, recs[0].rec).body).toContain('over the next 14 days');
  });
});
