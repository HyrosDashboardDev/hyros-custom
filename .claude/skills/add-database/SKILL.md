---
name: add-database
description: Give this dashboard its own database and the server functions that use it, or update those functions after a template update. Creates the database through HYROS when the account has none, copies the fixed api/ files, then writes the tables and routes the user needs. Use when the user wants the dashboard to save, store, remember or edit its own data (notes, tags, settings, records from another tool), asks for a database or a backend, or when update-from-template reports a newer add-database version.
---

# Add a database

A dashboard is static: it reads HYROS and keeps nothing. This skill gives it its
own Postgres database (Supabase), which HYROS creates on request, and the
server functions under `api/` that reach it. The page calls those functions on
its own origin; the database and its connection string never reach the
browser.

The files under `files/` next to this skill are **fixed**: they are copied
byte for byte and never edited in the dashboard. Only what the user asked for
is written by you: migrations, routes, views.

When `git remote get-url origin` ends in `HyrosEngineeringAI/hyros-custom.git`,
this is the template itself: never run this skill here. Change the files
under `files/` instead, and raise their version line (step 3).

## 1. The database

Creating a database creates infrastructure that exists until the dashboard is
deleted. Only do it when the user asked for something that needs to store
data, and say so in one line before creating it.

1. Call `hyros_get_dashboard_database`.
2. `NOT_CREATED`: confirm with the user, then call
   `hyros_create_dashboard_database` once. `FAILED`: tell the user, then call it
   once to try again.
3. Call `hyros_get_dashboard_database` every 30 seconds until `READY`, at most
   20 times. A new database takes one to three minutes; the step goes from
   `PROJECT` to `STARTUP`.
4. Still `FAILED` after one retry, or not `READY` after 20 checks: stop and
   tell the user the database could not be created and that HYROS support
   should look at it. Do not continue with the steps below.

Once `READY`, HYROS has set the variables on the dashboard's Vercel project
(`SUPABASE_DB_URL`, `DASHBOARD_ACCOUNT_ID`, `DASHBOARD_ENCRYPTION_KEY`,
`CRON_SECRET`). They apply from the next deployment, which your push in
step 6 triggers. You never see them and never need them.

## 2. The repository

- `git status` must be clean; if not, ask the user to commit or discard
  their changes. `git switch main` and `git pull origin main`, with GitHub
  access as "GitHub access and deploys" in `AGENTS.md` says.
- `build.mjs` must run `supabase/migrate.mjs` (`grep -n migrate build.mjs`)
  and `src/core/api.js` must export `credential`. If either is missing, the
  dashboard predates databases: run the `update-from-template` skill first,
  then come back.

## 3. The fixed files

Copy every file under `files/` (next to this `SKILL.md`) to the same path in
the dashboard:

```
api/AGENTS.md
api/_lib/auth.js  api/_lib/db.js  api/_lib/errors.js  api/_lib/respond.js
api/db/health.js
supabase/migrate.mjs
src/core/db.js
```

Each starts with a line `add-database v<N>`. For each one:

- **Missing in the dashboard:** copy it.
- **Same version line:** if the content is identical, leave it. If it differs,
  someone edited it by hand: show the user the difference and ask before
  replacing it.
- **Older version line:** replace it with the new one. This is how a fix
  reaches the dashboard.

Never change a fixed file to make your own code work; your own helpers go in
`api/_lib/own/`.

Then add the database client to `package.json`, keeping everything else:
`"dependencies": { "postgres": "3.4.5" }`. Vercel installs it for the build
and the functions; the page itself does not load it.

## 4. What the user needs

Read `api/AGENTS.md` (just copied) and follow it:

1. The schema: a new `supabase/migrations/NNNN_what_it_does.sql`, the next
   number, safe on existing data.
2. The routes: `api/db/<name>.js`, each one `route([...], handler)`, validating
   every input and capping every list.
3. The views: they call `db` from `src/core/db.js` (`db.get`, `db.post`,
   `db.patch`, `db.del`) and show a `DbError` as a `.note.err` with its
   `message`. A view that writes keeps working without the database: on
   `no_database` it says the data cannot be saved yet. Follow the `add-view`
   skill for a new tab.

## 5. Check

- `npm run check` passes.
- `node --check` on every file you wrote under `api/` and on
  `supabase/migrate.mjs`.

## 6. Ship

Commit and push to `main` as "Everywhere: commits and pushes" in `AGENTS.md`
says. The push deploys: the build applies the migrations first, then the page
and the functions go live together. If the build fails on a migration, the
previous deployment stays live; fix the migration with a new file (never by
editing one already pushed) and push again.

Tell the user in one line what now saves data and where, and that the
dashboard can call `GET /api/db/health` to confirm the database answers.
