// server/lib/db.ts — one Lakebase handle shared by Express routes AND agent tools.
// The handle is parked on globalThis so it survives the production bundle, where
// server/agents/*/agent.ts is compiled as a separate entry (a module-level `let`
// could be duplicated per chunk and stay null inside the agent).

export interface LakebaseLike {
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

const KEY = '__retailDemoLakebase';

function isLakebase(x: unknown): x is LakebaseLike {
  return typeof x === 'object' && x !== null && 'query' in x && typeof (x as { query: unknown }).query === 'function';
}

/** Call once from createApp({ onPluginsReady }) with appkit.lakebase. */
export function setDb(db: LakebaseLike): void {
  Reflect.set(globalThis, KEY, db);
}

function db(): LakebaseLike {
  const handle: unknown = Reflect.get(globalThis, KEY);
  if (!isLakebase(handle)) throw new Error('Lakebase is not ready yet');
  return handle;
}

/** One parameterised statement ($1, $2 …). Returns the rows. */
export async function sql(text: string, params: unknown[] = []): Promise<Record<string, unknown>[]> {
  const { rows } = await db().query(text, params);
  return rows;
}

/** A multi-statement script with NO parameters (DDL, seed). Uses the simple protocol. */
export async function exec(script: string): Promise<void> {
  await db().query(script);
}
