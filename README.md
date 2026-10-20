# HYROS Custom Dashboard

A per-account dashboard. It reads the account's data straight from the HYROS
customer API (`/api/v1.0`) in the browser, with a read-only credential that lives in memory for the
life of the page. It gets that credential one of two ways:

- **Inside HYROS** (an iframe): HYROS hands it a short-lived token over
  `postMessage`.
- **At its own url**: the user signs in with their HYROS account through the
  MCP OAuth server, the same sign-in MCP clients such as Claude Code use.
  The dashboard asks for the `mcp:read` scope, so HYROS issues the same
  read-only credential it hands the iframe. No API key: the API takes that
  credential as a bearer, with read roles only.

## How it works

```
HYROS page ──iframe──> dashboard (static files)
     │                      │
     │  ready / token-request
     │ <────────────────────┤  postMessage, origins checked on both sides
     │  theme, token        │
     ├────────────────────> │
     │  theme-applied       │
     │ <────────────────────┤
                            │  GET https://api.hyros.com/v1/api/v1.0/...
                            │  Authorization: Bearer <token>
                            └────────────────────> HYROS API

dashboard at its own url
     │  "Sign in with HYROS": register once (client id in localStorage),
     │  then authorize with PKCE and scope mcp:read
     ├──────────────────────────────> HYROS sign-in (MCP OAuth server)
     │ <──── redirect back with ?code
     │  POST /oauth2/token: code -> access + refresh token (in memory)
     │  GET /api/v1.0/... with the access token, refresh before it expires
```

- `src/core/`: config, auth (postMessage and the HYROS sign-in), the theme,
  the API client, dates, time limits.
- `src/data/data.js`: the data API views get as `ctx.data`.
- `src/views/`: one folder per tab. `src/views/registry.js` lists the
  template's tabs and `src/views/custom.js` the account's own.
  `src/views/_template/` is the skeleton of a new one.
- `src/app.js`: boot, the connection gate, header, tabs, Refresh.
- `styles.css` and `assets/`: the design system, the self-hosted fonts and
  the brand assets.

## Tabs

- **Performance Report**: spend, revenue and ROAS by traffic source, ad
  account, campaign, ad set or ad, for a range and an attribution model,
  with a drill from a number to the leads, sales or calls behind it.
- **CRM**: the leads, sales, calls and subscriptions of a range, with
  server-side filters, counts from the aggregation endpoints and one lead's
  journey.
- **Scale**: the marginal CAC curve of the chosen ad accounts (and of the
  top ad sets once the Report has loaded the last 30 days).
- **Account**: the account the dashboard is looking at.

Each tab's data and states are in its `SPEC.md`; the API paths behind them in
`docs/RECIPES.md`.

Tokens stay in memory. Both ways of getting one, and how the theme arrives,
are in `docs/PROTOCOL.md`;
the rules for adding views are in `CLAUDE.md` and `VIEWS.md`.

## Design system

The HYROS CL1 look: a cream ground, white windows with a hairline and a
mono address bar, mono labels, serif figures, Inter for the rest, and one
purple accent that marks what HYROS attributed or selected. Every color is
a token in `styles.css`; fonts and brand assets are self-hosted under
`assets/`. Read `UI-STYLE-GUIDE.md` before any visual change.

## The theme

HYROS has two themes, dark (its default) and white, and the dashboard follows
the one its user has. Inside HYROS the theme arrives with the token, before the
page shows, and again whenever the user switches it. At its own url the
dashboard starts white, and a sun/moon switch next to Refresh (and on the
sign-in screen) lets the user pick dark; the choice is kept in this browser's
`localStorage`. Inside HYROS the switch is hidden: HYROS decides.

- The theme is on `<html data-theme="dark">` or `<html data-theme="white">`.
- `styles.css` defines every color token twice: in `:root` (white) and in
  `:root[data-theme="dark"]`. Anything styled with tokens follows the theme on
  its own, including a view's `style.css`.
- A color written by hand does not follow it. Use a token, or add one to both
  blocks.
- Code that draws colors itself (a canvas chart, for example) reads
  `document.documentElement.dataset.theme`, or the token values with
  `getComputedStyle(document.documentElement).getPropertyValue('--brand')`,
  and draws again when `data-theme` changes (a `MutationObserver` on
  `<html>`).

## Run it locally

```bash
npm run dev
```

- `http://localhost:4321`: the dashboard. Opened directly it goes to the
  HYROS sign-in of production and reads the production API;
  `http://localhost:4321/?mcp=qa` signs in against QA and reads the QA API.
- `http://localhost:4323`: the harness, which plays HYROS. It frames the
  dashboard with the same sandbox HYROS uses, answers `ready` with the theme
  and the token you paste and `token-request` with the token, and logs every
  message (never the token). Pick `prod` or `qa` to choose the environment (`?mcp=qa`
  on the dashboard url). Switch the theme selector to see the dashboard follow
  it. Tick "send expiresAt" to exercise background renewal.

Use `localhost`, not `127.0.0.1`: the dashboard only accepts tokens from the
origins in `src/core/config.js`, and the sign-in sends you back to the exact
url you started from.

```bash
npm run check   # node:test, no dependencies
```

## Deploy

Static files on Vercel. HYROS sets `HYROS_MCP_URL` on the Vercel project when
it provisions the dashboard, and `npm run build` copies the site into
`public/` with that url baked into the page as
`<meta name="hyros-mcp-url">`, which wins over `?mcp=`. The build fails
without the variable. The data comes from the customer API of the same
environment (`api.hyros.com` for `mcp.hyros.com`, `api-staging.hyros.com`
for `mcp-qa.hyros.com`); an optional `HYROS_API_URL` is baked as
`<meta name="hyros-api-url">` and overrides it, and is required when
`HYROS_MCP_URL` is no known environment (a local server).
`?mcp=qa|prod` only matters for the local harness and
for manual deploys built without it.

`vercel.json` only sets headers:
`Content-Security-Policy: frame-ancestors https://app.hyros.com
https://ui-test.hyros.com https://localhost:8080`, `X-Content-Type-Options:
nosniff` and `Referrer-Policy: strict-origin-when-cross-origin`.
`.vercelignore` leaves out `dev/`, `scripts/`, `tests/` and `docs/`.

## Limits

- A 429 is retried at most twice, after what `Retry-After` says (1 s, then
  2 s, when it is missing). A `Retry-After` longer than the time left fails
  the call at once, and the error card says how long to wait.
- No downloads and no native dialogs (`alert`, `confirm`, `prompt`): the HYROS
  iframe sandbox blocks them.
- Read paths only (`READ_PATHS` in `src/core/api.js`), and the credential is
  read-only on the server either way.
- At its own url, every new page load signs in again: the tokens are not
  stored. With a live HYROS session that is just a redirect.
- No sign-out button yet. Revoking the session in HYROS cuts the dashboard
  off: the next call answers 401, the refresh is refused and the page asks
  to sign in again.
