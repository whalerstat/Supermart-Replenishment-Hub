// server/lib/common.ts — tables every demo app gets, plus the two write helpers
// that both the UI routes and the agent's write tools call.
import { sql } from './db';

/** decision_log = audit trail of every human/agent decision; outbox = mocked external sends. */
export function commonDdl(schema: string): string {
  return `
CREATE TABLE ${schema}.decision_log (
  id          BIGSERIAL PRIMARY KEY,
  entity_type TEXT NOT NULL,
  entity_id   TEXT NOT NULL,
  action      TEXT NOT NULL,
  detail      TEXT,
  actor       TEXT NOT NULL,
  source      TEXT NOT NULL CHECK (source IN ('ui', 'agent', 'seed')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE ${schema}.outbox (
  id         BIGSERIAL PRIMARY KEY,
  channel    TEXT NOT NULL,
  recipient  TEXT NOT NULL,
  subject    TEXT NOT NULL,
  body       TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'queued (mock - never sent)',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);`;
}

export interface Decision {
  schema: string;
  entityType: string;
  entityId: string;
  action: string;
  detail: string;
  actor: string;
  source: 'ui' | 'agent';
}

export async function logDecision(d: Decision): Promise<Record<string, unknown>> {
  const rows = await sql(
    `INSERT INTO ${d.schema}.decision_log (entity_type, entity_id, action, detail, actor, source)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, created_at`,
    [d.entityType, d.entityId, d.action, d.detail, d.actor, d.source]
  );
  return rows[0] ?? {};
}

export interface OutboxMessage {
  schema: string;
  channel: string;
  recipient: string;
  subject: string;
  body: string;
}

/** Mock integration: nothing leaves the app — the row IS the "sent" message. */
export async function queueMessage(m: OutboxMessage): Promise<Record<string, unknown>> {
  const rows = await sql(
    `INSERT INTO ${m.schema}.outbox (channel, recipient, subject, body)
     VALUES ($1, $2, $3, $4) RETURNING id, status, created_at`,
    [m.channel, m.recipient, m.subject, m.body]
  );
  return rows[0] ?? {};
}
