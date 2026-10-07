# HYROS Custom Dashboard

A per-account dashboard HYROS shows inside an iframe. It reads the account's
data straight from the HYROS MCP in the browser, using a short-lived token
HYROS hands it. That token is the only credential, and it lives in memory
for the life of the page.

## How it works

```
HYROS page ──iframe──> dashboard (static files)
     │                      │
     │  ready / token-request
     │ <────────────────────┤  postMessage, origins checked on both sides
     │  token (+ expiresAt) │
     ├────────────────────> │
                            │  POST https://mcp.hyros.com/mcp
                            │  Authorization: Bearer <token>
                            └────────────────────> HYROS MCP
```

- `src/core/`: config, the postMessage auth, the MCP client, dates, time limits.
- `src/data/data.js`: the data API views get as `ctx.data`.
- `src/views/`: one folder per tab, listed in `src/views/registry.js`.
  `src/views/_template/` is the skeleton of a new one.
- `src/app.js`: boot, the connection gate, header, tabs, Refresh.
- `styles.css` and `assets/`: the design system, the self-hosted fonts and
  the brand assets.

The token stays in memory. The contract is in `docs/PROTOCOL.md`; the rules
for adding views are in `CLAUDE.md` and `VIEWS.md`.

## Design system

The HYROS CL1 look: a cream ground, white windows with a hairline and a
mono address bar, mono labels, serif figures, Inter for the rest, and one
purple accent that marks what HYROS attributed or selected. Every color is
a token in `styles.css`; fonts and brand assets are self-hosted under
`assets/`. Read `UI-STYLE-GUIDE.md` before any visual change.

## Run it locally

```bash
npm run dev
```

- `http://localhost:4321`: the dashboard. Opened directly it shows "Open this
  dashboard from HYROS" and makes no MCP call.
- `http://localhost:4323`: the harness, which plays HYROS. It frames the
  dashboard with the same sandbox HYROS uses, answers `ready` and
  `token-request` with the token you paste, and logs every message (never the
  token). Pick `prod` or `qa` to choose the MCP (`?mcp=qa` on the dashboard url).
  Tick "send expiresAt" to exercise background renewal.

Use `localhost`, not `127.0.0.1`: the dashboard only accepts tokens from the
origins in `src/core/config.js`.

```bash
npm run check   # node:test, no dependencies
```

## Deploy

Static files on Vercel. HYROS sets `HYROS_MCP_URL` on the Vercel project when
it provisions the dashboard, and `npm run build` copies the site into
`public/` with that url baked into the page as
`<meta name="hyros-mcp-url">`, which wins over `?mcp=`. The build fails
without the variable. `?mcp=qa|prod` only matters for the local harness and
for manual deploys built without it.

`vercel.json` only sets headers:
`Content-Security-Policy: frame-ancestors https://app.hyros.com
https://ui-test.hyros.com https://localhost:8080`, `X-Content-Type-Options:
nosniff` and `Referrer-Policy: strict-origin-when-cross-origin`.
`.vercelignore` leaves out `dev/`, `scripts/`, `tests/` and `docs/`.

## Limits

- A 429 is retried after a fixed 1 s, then 2 s: the CORS config of `/mcp`
  exposes no headers, so the browser cannot read `Retry-After`.
- No downloads and no native dialogs (`alert`, `confirm`, `prompt`): the HYROS
  iframe sandbox blocks them.
- Read tools only (`READ_TOOLS` in `src/core/mcp.js`).
- Inside HYROS the dashboard does not get a token yet. See "Missing in HYROS"
  in `docs/PROTOCOL.md`.
