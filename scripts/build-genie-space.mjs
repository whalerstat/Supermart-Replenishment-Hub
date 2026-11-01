#!/usr/bin/env node
// scripts/build-genie-space.mjs — builds the Genie serialized_space payload from genie/space.json and
// creates the space, or updates it (the one GENIE_SPACE_ID names, else the one with the same title). No dependencies.
//   node scripts/build-genie-space.mjs              create or update, print the space id
//   node scripts/build-genie-space.mjs --dry-run    print the payload only, never call Databricks
// Env: DATABRICKS_CONFIG_PROFILE (default BenV), CATALOG (default retail_lakebase), WAREHOUSE_ID,
//      GENIE_SPACE_ID (update this space; needed when the title in genie/space.json changed).
// The Genie API rejects: ids that are not 32-hex, id-keyed arrays that are not sorted by id, tables not
// sorted by identifier, column_configs not sorted by column_name, string (not array) question/sql/content,
// and more than one text_instructions item. The builder below enforces all of them.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const profile = process.env.DATABRICKS_CONFIG_PROFILE ?? 'BenV';
const catalog = process.env.CATALOG ?? 'retail_lakebase';
const warehouseId = process.env.WAREHOUSE_ID ?? 'babf1edddc36b6d3';
const specPath =
  args.find((a) => !a.startsWith('--')) ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'genie', 'space.json');
const spec = JSON.parse(readFileSync(specPath, 'utf8'));

const id = (s) => createHash('md5').update(s).digest('hex'); // stable 32-hex ids keep re-runs idempotent
const byId = (a, b) => (a.id < b.id ? -1 : 1);
const fill = (s) => s.replaceAll('{{catalog}}', catalog);

const tables = spec.tables
  .map((t) => {
    const entry = { identifier: `${catalog}.${spec.schema}.${t.name}` };
    const cols = (t.columns ?? [])
      .map((c) => {
        const cfg = { column_name: c.name };
        if (c.description) cfg.description = [c.description];
        if (c.synonyms?.length) cfg.synonyms = c.synonyms;
        if (c.entity) {
          cfg.enable_format_assistance = true;
          cfg.enable_entity_matching = true;
        }
        return cfg;
      })
      .sort((a, b) => (a.column_name < b.column_name ? -1 : 1));
    if (cols.length) entry.column_configs = cols;
    return entry;
  })
  .sort((a, b) => (a.identifier < b.identifier ? -1 : 1));

const payload = {
  version: 2,
  config: {
    sample_questions: spec.sample_questions.map((q) => ({ id: id(`sq:${q}`), question: [q] })).sort(byId),
  },
  data_sources: { tables },
  instructions: {
    example_question_sqls: spec.example_sqls
      .map((e) => ({ id: id(`ex:${e.question}`), question: [e.question], sql: [fill(e.sql)] }))
      .sort(byId),
    text_instructions: [{ id: id(`ti:${spec.title}`), content: spec.instructions.map(fill) }],
  },
};
const serialized = JSON.stringify(payload);

if (dryRun) {
  process.stdout.write(
    JSON.stringify(
      {
        title: spec.title,
        description: spec.description,
        warehouse_id: warehouseId,
        profile,
        serialized_space: payload,
      },
      null,
      2
    ) + '\n'
  );
  process.exit(0);
}

function databricks(...cliArgs) {
  const out = execFileSync('databricks', [...cliArgs, '--profile', profile, '-o', 'json'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: 120_000,
  });
  return out.trim() ? JSON.parse(out) : {};
}

function findSpaceId() {
  let token;
  do {
    const page = databricks('genie', 'list-spaces', ...(token ? ['--page-token', token] : []));
    const hit = (page.spaces ?? []).find((s) => s.title === spec.title);
    if (hit) return hit.space_id ?? hit.id;
    token = page.next_page_token;
  } while (token);
  return null;
}

const existing = process.env.GENIE_SPACE_ID?.trim() || findSpaceId();
const space = existing
  ? databricks(
      'genie',
      'update-space',
      existing,
      '--serialized-space',
      serialized,
      '--title',
      spec.title,
      '--description',
      spec.description,
      '--warehouse-id',
      warehouseId
    )
  : databricks(
      'genie',
      'create-space',
      warehouseId,
      serialized,
      '--title',
      spec.title,
      '--description',
      spec.description
    );

const spaceId = existing ?? space.space_id ?? space.id;
if (!spaceId) throw new Error(`No space id in the Databricks response: ${JSON.stringify(space)}`);
process.stderr.write(`${existing ? 'Updated' : 'Created'} Genie space "${spec.title}" on warehouse ${warehouseId}\n`);
process.stdout.write(`${spaceId}\n`);
