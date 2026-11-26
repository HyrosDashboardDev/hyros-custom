// add-database v2. Copied by the add-database skill: do not edit, run the skill again to update it.
/**
 * Applies the dashboard's migrations, `supabase/migrations/*.sql` in name order, each once. `build.mjs` runs
 * this before it builds the page, so a push deploys its schema change and the code that needs it together.
 * A failing migration fails the build, and Vercel keeps the previous deployment live.
 *
 * Each migration runs in its own transaction together with its row in `schema_migrations`, under a
 * transaction-level advisory lock, so two builds running at once never apply the same file twice. An applied
 * migration is never run again, even if its file changes: a schema change is always a new file.
 *
 * Without SUPABASE_DB_URL (a local build, or a dashboard whose database was not created yet) it does nothing.
 */
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations');
/** Any constant: it only has to be the same in every build of this dashboard. */
const LOCK_KEY = 4815162342;
export const MIGRATION_NAME = /^\d{4}_[a-z0-9_]+\.sql$/;

/** The migration files in the order they apply. A name out of the `0001_what_it_does.sql` pattern fails the build. */
export async function migrationFiles(dir = DIR) {
  const names = (await readdir(dir).catch(() => [])).filter((name) => name.endsWith('.sql')).sort();
  const bad = names.filter((name) => !MIGRATION_NAME.test(name));
  if (bad.length) throw new Error(`Migration names must look like 0001_create_notes.sql: ${bad.join(', ')}`);
  return names;
}

export async function migrate({ url = process.env.SUPABASE_DB_URL, dir = DIR, log = console.log } = {}) {
  if (!url) {
    log('[migrate] SUPABASE_DB_URL is not set: no database, nothing to migrate');
    return [];
  }
  const names = await migrationFiles(dir);
  const { default: postgres } = await import('postgres');
  const sql = postgres(url, { prepare: false, max: 1, connect_timeout: 15, onnotice: () => {} });
  const applied = [];
  try {
    await sql`create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())`;
    for (const name of names) {
      const body = await readFile(join(dir, name), 'utf8');
      const ran = await sql.begin(async (tx) => {
        await tx`select pg_advisory_xact_lock(${LOCK_KEY})`;
        const [done] = await tx`select 1 from schema_migrations where name = ${name}`;
        if (done) return false;
        await tx.unsafe(body);
        await tx`insert into schema_migrations (name) values (${name})`;
        return true;
      });
      if (ran) {
        applied.push(name);
        log(`[migrate] applied ${name}`);
      }
    }
    log(`[migrate] ${applied.length} applied, ${names.length - applied.length} already there`);
    return applied;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  migrate().catch((err) => {
    console.error(`[migrate] failed: ${err.code ? `${err.code} ` : ''}${err.message}`);
    process.exit(1);
  });
}
