import { describe, expect, it, vi } from 'vitest';
import type { RecPayload, SignalPayload } from './agent';

// Keeps the test off the workspace client: only the pure prompt builder is exercised.
vi.mock('../lib/llm', () => ({ complete: vi.fn(), modelService: () => null }));
const { REVISE_SYSTEM, revisePrompt } = await import('./agent');

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
