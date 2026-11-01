// server/lib/bootstrap.ts — create + seed the app schema on first start, as the app's service
// principal (so the SP owns it), then run the pipeline once so the Agent Decisions screen has data
// before anyone presses Run. Runs ONLY when DEMO_BOOTSTRAP=true, which is set in app.yaml and never
// in the local .env, so a local `pnpm dev` can never create the schema under YOUR identity.
// Re-seeds when DEMO_RESEED=true or when called with force=true (the "Reset demo" button).
import { runAll } from '../app/pipeline';
import { DDL, SCHEMA, SEED } from '../app/schema';
import { exec, sql } from './db';

export async function bootstrap(force = false): Promise<'seeded' | 'kept' | 'skipped'> {
  if (process.env.DEMO_BOOTSTRAP !== 'true') {
    console.log("[demo] DEMO_BOOTSTRAP is not 'true' — schema bootstrap skipped (deploy first)");
    return 'skipped';
  }
  try {
    const found = await sql(
      `SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND table_name = 'pipeline_runs'`,
      [SCHEMA]
    );
    if (found.length > 0 && !force && process.env.DEMO_RESEED !== 'true') {
      const done = await sql(`SELECT 1 FROM ${SCHEMA}.pipeline_runs WHERE status = 'succeeded' LIMIT 1`);
      if (done.length === 0) await runAll('system (first start)');
      return 'kept';
    }
    await exec(DDL);
    await exec(SEED);
    await runAll('system (first start)');
    console.log(`[demo] (re)created schema ${SCHEMA}, seeded the sources and ran the pipeline once`);
    return 'seeded';
  } catch (err) {
    // Keep the server up so /logz and the UI can show the error instead of a crash loop.
    console.error('[demo] bootstrap failed:', err);
    if (force) throw err;
    return 'kept';
  }
}
