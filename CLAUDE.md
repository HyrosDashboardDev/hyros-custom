# HYROS Custom Dashboard

A static page, one per account. Inside HYROS (an iframe) HYROS hands it a
short-lived token over `postMessage`. Opened at its own url it signs in with
the HYROS account through the MCP OAuth server (authorization code with PKCE,
scope `mcp:read`). Either way the browser calls the HYROS MCP directly with
`Authorization: Bearer <token>` and the credential is read-only. HYROS sets
`HYROS_MCP_URL` on the Vercel project when it provisions the dashboard, and
`npm run build` bakes it into the page as a meta tag; `?mcp=qa|prod` is only
for local runs and manual deploys without the variable.
Static files, no API key, no secret: the only credential is the token.
Inside HYROS the page also follows the HYROS theme (dark or white), posted
over the same contract; at its own url it starts white and has its own
dark/white switch, hidden inside HYROS.

## Working on the template itself

This file is written for the owner of one dashboard. When
`git remote get-url origin` ends in `HyrosEngineeringAI/hyros-custom.git`,
this is the template every dashboard is generated from and updated from,
worked on by HYROS developers. Then:

- A new tab is a template tab: an id without the `custom-` prefix, added to
  `TEMPLATE_VIEWS` in `src/views/registry.js`. Every dashboard gets it on
  its next update.
- Never change `src/views/custom.js`. It belongs to each dashboard; a change
  here reaches every dashboard as one of its own tabs or conflicts with
  their own list on update. It stays with both arrays empty.
- A change to a file a dashboard owner edits (`styles.css`, `index.html`,
  `CLAUDE.md`) conflicts in every dashboard that edited it too. Keep such
  changes small, and prefer a new file or a view's own `style.css`.
- "GitHub access and deploys" and the `update-from-template` skill do not
  apply: this repository is public, the developer uses their own GitHub
  credentials, and changes go through pull requests to `main`.

## Read order

1. `VIEWS.md`: the view contract (folder layout, the `view` object, `ctx`,
   the shared markup kit, `SPEC.md`). Read before adding or changing any tab.
2. `UI-STYLE-GUIDE.md`: tokens, fonts, brand assets, components. Read before
   any visual change; never invent colors or fonts.
3. `docs/RECIPES.md`: the data of each view (which tools, which arguments,
   how to shape the rows).
4. `docs/PROTOCOL.md`: how the dashboard gets its credential and its theme
   (the `postMessage` contract with HYROS, and the HYROS sign-in).

## Rules

- **`src/core/` is the core. Do not edit it without asking.** Config, auth,
  the theme, the MCP client, dates and time limits live there.
- **Views talk to HYROS only through `ctx.data`.** A view never imports
  `src/core/mcp.js`, `src/core/auth.js` or `src/core/config.js` and never calls
  `fetch`. Need a tool the data API has no getter for? `ctx.data.call`,
  `ctx.data.paged` or `ctx.data.pagedInfo`.
- **Tokens are never stored or logged.** Not in `localStorage`, a cookie,
  the url, `console.*` or an error message. The sign-in keeps only its client
  id in `localStorage` (the theme switch keeps the theme there too) and, while the user is on the HYROS sign-in page, its
  state and PKCE verifier in `sessionStorage`.
- **Read tools only.** `READ_TOOLS` in `src/core/mcp.js` is the list; anything
  else fails with `not_allowed` before a request is made.
- **What the HYROS iframe sandbox blocks:** no `alert`, `confirm` or `prompt`
  (they do nothing), no downloads (no `allow-downloads`). `localStorage` only
  inside `try/catch`: the frame is partitioned and Safari can block it.
- **Colors only as tokens in `styles.css`.** Every color token has a value in
  `:root` (white theme) and in `:root[data-theme="dark"]`; a new one goes in
  both. No hex literal in `src/` (views' `style.css` included) or in inline
  styles; `npm run check` fails on one. A color written by hand does not
  follow the theme.
- **Derived metrics are re-derived after summing, never averaged** (ROAS,
  ROI, CPL, CTR: `docs/RECIPES.md` "Derived metrics").
- **Every view ships a `SPEC.md`** next to its `view.js`.
- **View-specific classes are prefixed with the view id** and live in the
  view's `style.css`, using tokens only.
- No frameworks, no dependencies, no build step. ES modules served as they are.
- No long dashes in code, comments or docs. Comments say what the code does
  and why.
- No model identifiers in commits, code or docs.

## Add a view

Details in `VIEWS.md`; the `add-view` skill walks the same steps. These are
the steps in a dashboard; in the template itself, see "Working on the
template itself" above.

1. Pick an id starting with `custom-` (e.g. `custom-funnel`), then
   `cp -r src/views/_template src/views/<id>` and set `id` (equal to the
   folder name), `title`, `version`, `description`, `style`, `tools` and
   `author` on the `view` object.
2. Write `SPEC.md` first: the tools, the rows shape, the states.
3. Write `render(ctx)` (`ctx = { root, data, fmt, esc, kpis, now }`) with
   the shared kit, then add `'<id>'` to `CUSTOM_VIEWS` in
   `src/views/custom.js`. Never edit `src/views/registry.js`: it lists the
   template's tabs and changes with template updates. To hide a template
   tab, add its id to `HIDDEN_VIEWS` in `custom.js`.
4. `npm run check`, then `npm run dev` and look at the tab through the
   harness.

The shell shows "Loading…" while `render` runs, an error card with Retry if
it throws or takes longer than 2 minutes, and calls it again on Refresh (after
`ctx.data.invalidate()`) and on every tab switch. Escape every value from
HYROS with `ctx.esc` before it reaches `innerHTML`.

## Commands

```bash
npm run check   # node:test, no deps: auth, MCP client, data API, these rules
npm run dev     # dashboard on http://localhost:4321, harness on http://localhost:4323
```

The harness plays HYROS: paste an MCP access token, it answers the
dashboard's `ready` and `token-request`. Opened directly, the dashboard goes
to the HYROS sign-in of production (`?mcp=qa` for QA).

## Updating from the template

This dashboard was generated from the public template
`https://github.com/HyrosEngineeringAI/hyros-custom` (branch `main`). When
the user asks to update the dashboard, or to bring in the template's latest
fixes or tabs, follow the `update-from-template` skill. Never update
without the user asking.

## Where things are

- `docs/RECIPES.md`: how to build the Report, CRM, Drill, Scale and Health
  views on this dashboard: which tools to call and how to shape the rows.
- `docs/PROTOCOL.md`: the `postMessage` contract (token and theme) and the
  HYROS sign-in.

## GitHub access and deploys
This repo is private, under `HyrosEngineeringAI` on GitHub, and Vercel
deploys it: **a push to `main` is a production deploy**; any other branch
gets a deployed preview.

The user has no GitHub credentials for it and must never need any. Access
comes from a token issued by the HYROS MCP tool
`hyros_get_dashboard_repository_token` (your client may show it with a
prefix). A token works for this one repository only (clone, pull, push) and
expires one hour after it is issued.

Before any command that talks to GitHub (`clone`, `fetch`, `pull`, `push`;
local ones such as `status`, `diff` or `commit` need nothing):
1. Get the repository name: `basename -s .git "$(git remote get-url origin)"`.
   Before the first clone, ask the user for it; it looks like
   `dash-<number>-<7 hex chars>`.
2. Call `hyros_get_dashboard_repository_token` with that name. Besides the
  token it returns `commitAuthorName` and `commitAuthorEmail`.
3. Set them as this repository's commit author (never `--global`):
   ```
   git config user.name "<commitAuthorName>"
   git config user.email "<commitAuthorEmail>"
   ```
4. Point `origin` at the token, then run the command:
   ```
   git remote set-url origin "https://x-access-token:<token>@github.com/HyrosEngineeringAI/<repo>.git"
   git push origin <branch>
   ```
   First clone: `git clone "https://x-access-token:<token>@github.com/HyrosEngineeringAI/<repo>.git"`.

Rules:
- `Authentication failed`, `403` or `could not read Username` means the
 token expired: request a new one and retry once, never with the old one.
- Never ask the user for a GitHub username, password, token or SSH key, and
 never switch the remote to SSH.
- The token lives only in the `origin` URL inside `.git/config`. Never write
 it into a tracked file, a commit message, a script or an env file, and do
 not print it back unless the user asks.
- Before pushing to `main`, summarize the changes and confirm the user wants
 them in production. To check a change first, push a branch and use its
 preview.
- Tool not available: the HYROS MCP server is not connected. Ask the user to
 add `https://mcp.hyros.com/mcp` as an MCP server in their client and sign
 in with their HYROS account. Tool refused as not enabled ("Custom
 dashboards are not enabled for this account."): the feature is off for
 their account; they should contact HYROS support.
- Commits are authored as the dashboard owner returned by the tool, not as the user.
  Do not override the repository's `user.name` or `user.email`
