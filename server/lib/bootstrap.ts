// server/lib/bootstrap.ts — create + seed the app schema on first start, as the app's service
// principal (so the SP owns it). Nothing else runs: Agent Decisions stays empty until someone runs the
// pipeline on Screen 1. Runs ONLY when DEMO_BOOTSTRAP=true, which is set in app.yaml and never in the
// local .env, so a local `pnpm dev` can never create the schema under YOUR identity.
// Re-seeds when DEMO_RESEED=true, when the schema carries an older SEED_TAG, or when called with
// force=true (POST /api/reset).
import { DDL, SCHEMA, SEED, SEED_TAG } from '../app/schema';
import { exec, sql } from './db';

export async function bootstrap(force = false): Promise<'seeded' | 'kept' | 'skipped'> {
  if (process.env.DEMO_BOOTSTRAP !== 'true') {
    console.log("[app] DEMO_BOOTSTRAP is not 'true' — schema bootstrap skipped (deploy first)");
    return 'skipped';
  }
  try {
    const [found] = await sql(
      `SELECT obj_description(oid, 'pg_namespace') AS tag FROM pg_namespace WHERE nspname = $1`,
      [SCHEMA]
    );
    if (found?.tag === SEED_TAG && !force && process.env.DEMO_RESEED !== 'true') return 'kept';
    await exec(DDL);
    await exec(SEED);
    console.log(`[app] (re)created schema ${SCHEMA} and seeded the sources (${SEED_TAG})`);
    return 'seeded';
  } catch (err) {
    // Keep the server up so /logz and the UI can show the error instead of a crash loop.
    console.error('[app] bootstrap failed:', err);
    if (force) throw err;
    return 'kept';
  } finally {
    await grantReaders();
  }
}

/** The curated tables the Genie space exposes (genie/space.json); raw source and bronze rows stay private. */
const GENIE_TABLES = [
  'gold_replenishment_position',
  'gold_store_travel_daily',
  'gold_knowledge_clauses',
  'ml_forecast',
  'agent_signals',
  'agent_recommendations',
  'decision_log',
  'outbox',
];

/**
 * Genie queries the schema through the Lakebase catalog as the signed-in user, but the schema is owned
 * by the app's service principal, so each reader's Postgres role needs USAGE + SELECT. GENIE_READER_ROLES
 * is a comma-separated list of Postgres role names (a Databricks user's role is their e-mail).
 */
async function grantReaders(): Promise<void> {
  const roles = (process.env.GENIE_READER_ROLES ?? '')
    .split(',')
    .map((r) => r.trim())
    .filter(Boolean);
  for (const role of roles) {
    try {
      const [found] = await sql(`SELECT 1 FROM pg_roles WHERE rolname = $1`, [role]);
      if (!found) {
        console.warn(`[app] Postgres role ${role} not found; skipped Genie read grant`);
        continue;
      }
      const r = `"${role.replace(/"/g, '""')}"`;
      // Re-run on every start because a reset drops and recreates the tables, which drops their grants.
      // The revokes undo any wider grant an earlier build made, so only the curated tables stay readable.
      const tables = GENIE_TABLES.map((t) => `${SCHEMA}.${t}`).join(', ');
      await exec(
        `REVOKE SELECT ON ALL TABLES IN SCHEMA ${SCHEMA} FROM ${r};
         ALTER DEFAULT PRIVILEGES IN SCHEMA ${SCHEMA} REVOKE SELECT ON TABLES FROM ${r};
         GRANT USAGE ON SCHEMA ${SCHEMA} TO ${r};
         GRANT SELECT ON ${tables} TO ${r};`
      );
      console.log(`[app] granted read on ${SCHEMA} to ${role}`);
    } catch (err) {
      console.error(`[app] Genie read grant for ${role} failed:`, err);
    }
  }
}
