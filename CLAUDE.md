# HYROS Custom Dashboard

A static page HYROS shows inside an iframe, one per account. HYROS hands the
iframe a short-lived token over `postMessage`; the browser calls the HYROS MCP
(`https://mcp.hyros.com/mcp`) directly with `Authorization: Bearer <token>`.
Static files, one credential: the token HYROS hands the iframe.

## Read order

1. `VIEWS.md`: the view contract (folder layout, the `view` object, `ctx`,
   the shared markup kit, `SPEC.md`). Read before adding or changing any tab.
2. `UI-STYLE-GUIDE.md`: tokens, fonts, brand assets, components. Read before
   any visual change; never invent colors or fonts.
3. `docs/RECIPES.md`: the data of each view (which tools, which arguments,
   how to shape the rows).
4. `docs/PROTOCOL.md`: the `postMessage` contract with HYROS (the host).

## Rules

- **`src/core/` is the core. Do not edit it without asking.** Config, auth,
  the MCP client, dates and time limits live there.
- **Views talk to HYROS only through `ctx.data`.** A view never imports
  `src/core/mcp.js`, `src/core/auth.js` or `src/core/config.js` and never calls
  `fetch`. Need a tool the data API has no getter for? `ctx.data.call`,
  `ctx.data.paged` or `ctx.data.pagedInfo`.
- **The token is never stored or logged.** Not in `localStorage`, a cookie,
  the url, `console.*` or an error message.
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
dashboard's `ready` and `token-request`. Opened directly, the dashboard only
shows "Open this dashboard from HYROS".

## Where things are

- `docs/RECIPES.md`: how to build the Report, CRM, Drill, Scale and Health
  views on this dashboard: which tools to call and how to shape the rows.
- `docs/PROTOCOL.md`: the `postMessage` contract and what HYROS still lacks.

## Missing on the HYROS side

HYROS speaks the whole contract but does not issue the token yet, and the
CORS config of `/mcp` exposes no headers. Until the token lands the dashboard
inside HYROS reaches the "did not hand over the credential" card.
Details in `docs/PROTOCOL.md`.
