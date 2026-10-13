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

## Read order

1. `VIEWS.md`: the view contract (folder layout, the `view` object, `ctx`,
   the shared markup kit, `SPEC.md`). Read before adding or changing any tab.
2. `UI-STYLE-GUIDE.md`: tokens, fonts, brand assets, components. Read before
   any visual change; never invent colors or fonts.
3. `docs/RECIPES.md`: the data of each view (which tools, which arguments,
   how to shape the rows).
4. `docs/PROTOCOL.md`: how the dashboard gets its credential (the
   `postMessage` contract with HYROS, and the HYROS sign-in).

## Rules

- **`src/core/` is the core. Do not edit it without asking.** Config, auth,
  the MCP client, dates and time limits live there.
- **Views talk to HYROS only through `ctx.data`.** A view never imports
  `src/core/mcp.js`, `src/core/auth.js` or `src/core/config.js` and never calls
  `fetch`. Need a tool the data API has no getter for? `ctx.data.call`,
  `ctx.data.paged` or `ctx.data.pagedInfo`.
- **Tokens are never stored or logged.** Not in `localStorage`, a cookie,
  the url, `console.*` or an error message. The sign-in keeps only its client
  id in `localStorage` and, while the user is on the HYROS sign-in page, its
  state and PKCE verifier in `sessionStorage`.
- **Read tools only.** `READ_TOOLS` in `src/core/mcp.js` is the list; anything
  else fails with `not_allowed` before a request is made.
- **What the HYROS iframe sandbox blocks:** no `alert`, `confirm` or `prompt`
  (they do nothing), no downloads (no `allow-downloads`). `localStorage` only
  inside `try/catch`: the frame is partitioned and Safari can block it.
- **Colors only as tokens in `styles.css` `:root`.** No hex literal in `src/`
  (views' `style.css` included) or in inline styles; `npm run check` fails
  on one.
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

Details in `VIEWS.md`; the `add-view` skill walks the same steps.

1. `cp -r src/views/_template src/views/<id>` and set `id` (equal to the
   folder name), `title`, `version`, `description`, `style`, `tools` and
   `author` on the `view` object.
2. Write `SPEC.md` first: the tools, the rows shape, the states.
3. Write `render(ctx)` (`ctx = { root, data, fmt, esc, kpis, now }`) with
   the shared kit, then add `'<id>'` to `VIEWS` in `src/views/registry.js`.
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

## Where things are

- `docs/RECIPES.md`: how to build the Report, CRM, Drill, Scale and Health
  views on this dashboard: which tools to call and how to shape the rows.
- `docs/PROTOCOL.md`: the `postMessage` contract and the HYROS sign-in.

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
