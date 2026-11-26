<!-- add-database v2. Copied by the add-database skill: do not edit, run the skill again to update it. -->
# The dashboard's database

This dashboard has its own Postgres database (Supabase), created by HYROS when the owner asked for it, and
this folder holds the server functions that reach it. These rules add to the root `AGENTS.md`; where they
meet "Static files, no API key, no secret", these win: there is a secret, but only in Vercel's server
environment, never in the page.

## How it fits

- **The page never talks to the database.** Views call `db` from `src/core/db.js`, which calls the routes
  under `/api/db/` on the dashboard's own origin. A view never calls `fetch`, the same rule as `ctx.data`.
- **Every route checks the caller.** The routes are public urls. `route(...)` in `api/_lib/respond.js` sends
  the page's HYROS token to HYROS (`GET /user-info`) and accepts only the account that owns this dashboard
  (`DASHBOARD_ACCOUNT_ID`). A route a Vercel cron calls says so (`callers: ['cron']`, below) and is checked
  against `CRON_SECRET` instead. Never write a handler without `route(...)`.
- **The connection string never leaves the server.** `SUPABASE_DB_URL` is a sensitive Vercel variable,
  read only by `api/_lib/db.js` and `supabase/migrate.mjs`. Never print it, return it, bake it into the page
  or ask the user for it. Nobody can read it back, not even from Vercel.
- **SQL only through the `sql` tagged template.** Values go in `${...}` and are sent as parameters. Never
  build SQL by concatenating strings; `sql.unsafe` is only for `supabase/migrate.mjs`.

## Changing the schema

- A schema change is a new file in `supabase/migrations/`, named `NNNN_what_it_does.sql` with the next
  number (`0002_add_notes_stage.sql`). Never edit or rename a file already pushed: it ran once and never
  runs again.
- Migrations run in the Vercel build, before the page is built (`build.mjs` calls `supabase/migrate.mjs`).
  A failing one fails the deploy and the previous deployment stays live. They cannot run on the user's
  computer: the connection string exists only in Vercel.
- Keep a migration safe on existing data: `create table if not exists`, new columns nullable or with a
  default. Ask the user before a migration that drops a table or a column: the data is gone for good.

## Adding a route

One file per resource: `api/db/<name>.js`, reached as `db.get('<name>')` from a view.

```js
import { route, badRequest, notFound } from '../_lib/respond.js';

export default route(['GET', 'POST', 'DELETE'], async ({ req, sql }) => {
  if (req.method === 'GET') return sql`select id, text, created_at from notes order by created_at desc limit 200`;
  if (req.method === 'POST') {
    const text = String(req.body?.text ?? '').trim();
    if (!text || text.length > 2000) throw badRequest('text is required, at most 2000 characters');
    const [note] = await sql`insert into notes (text) values (${text}) returning id, text, created_at`;
    return note;
  }
  const [gone] = await sql`delete from notes where id = ${req.query.id} returning id`;
  if (!gone) throw notFound();
});
```

- Validate every input from the page: lengths, types, which columns may be written. Cap every list
  (`limit`).
- Return only what the view shows. Errors the page should read are `badRequest(...)` and `notFound(...)`;
  anything else answers 500 and stays in the function log.
- Files under `api/_lib/` are not routes (the underscore). Shared helpers of your own go in
  `api/_lib/own/`, never in the fixed files.

## Scheduled jobs (cron)

Work that runs with nobody on the dashboard (syncing another tool, processing what a route saved) is a
route that only a Vercel cron job may call:

```js
// api/cron/sync-notes.js
import { route } from '../_lib/respond.js';

export default route(['GET'], async ({ sql }) => {
  const stale = await sql`select id from notes where synced_at is null order by created_at limit 20`;
  // ...do the work for each row, within the function's time limit...
  return { synced: stale.length };
}, { callers: ['cron'] });
```

- Declare it in `vercel.json`, `crons`: `{ "path": "/api/cron/sync-notes", "schedule": "0 * * * *" }`. Vercel calls
  it with GET and `Authorization: Bearer <CRON_SECRET>`, which HYROS sets on the project with the database.
  The page cannot call it, and the cron secret opens no other route.
- `callers` is `['user']` unless said otherwise. Give a route both (`['user', 'cron']`) only when the page and
  the job really run the same thing; the handler then reads `caller`, and `user` is null for the cron.
- Each run does a bounded batch (`limit`) and leaves the rest for the next one. A job that can overlap the
  previous run marks the rows it takes before working on them.
- Schedule within what the Vercel plan allows; a schedule the plan refuses fails the deploy, and the previous
  deployment stays live.

## Limits to know

- **Disk:** 8 GB. When it fills, the database turns read only and writes answer `storage_full` (507). Keep
  tables lean and delete what is no longer needed.
- **Connections:** each function instance holds one through the pooler; keep queries short.
- **Functions:** a request must answer within Vercel's time limit; long work does not belong in a route.

## Fixed files

`api/_lib/auth.js`, `api/_lib/db.js`, `api/_lib/errors.js`, `api/_lib/respond.js`, `api/db/health.js`,
`supabase/migrate.mjs`, `src/core/db.js` and this file are copied by the `add-database` skill and start
with an `add-database v<N>` line. Never edit them: a fix comes from the template, by running the skill
again after updating from the template.

## Checking it works

`GET /api/db/health` answers `{ ok: true, migrations: <n> }` on the deployed dashboard with a valid token.
Locally, `npm run dev` serves only the page and the routes do not run: the connection string exists only
in Vercel. Check database work on the deployed dashboard.
