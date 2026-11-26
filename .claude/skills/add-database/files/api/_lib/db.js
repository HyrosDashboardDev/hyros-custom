// add-database v2. Copied by the add-database skill: do not edit, run the skill again to update it.
/**
 * The dashboard's own Postgres database, for the functions under `api/` only. The browser never sees
 * SUPABASE_DB_URL: HYROS sets it on the Vercel project as a sensitive variable when it creates the database.
 *
 * It goes through Supabase's pooler in transaction mode: every function instance opens its own connection,
 * and the pooler is what keeps many short-lived instances within the database's connection limit. Transaction
 * mode does not support prepared statements, hence `prepare: false`.
 */
import postgres from 'postgres';

const url = process.env.SUPABASE_DB_URL;

/** False until HYROS created the database; every route answers `no_database` meanwhile. */
export const hasDatabase = Boolean(url);

/** Tagged-template SQL: `await sql\`select * from notes where id = ${id}\``. Values are always sent as parameters. */
export const sql = hasDatabase
  ? postgres(url, { prepare: false, max: 1, idle_timeout: 20, connect_timeout: 10 })
  : null;
