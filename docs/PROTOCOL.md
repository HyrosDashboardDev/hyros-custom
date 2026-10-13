# How the dashboard gets its credential and its theme

Two ways, picked when the page loads (`src/app.js`):

- **Inside HYROS** (the page runs in a frame): the `postMessage` contract
  below. HYROS (the host) hands the token over, so it never travels in a url.
- **At its own url**: the HYROS sign-in, at the end of this document.

Either way the credential is the same kind: read-only, accepted at `/mcp`
only, held in memory. Inside HYROS the same contract also carries the theme
of the HYROS user; at its own url the page starts in its default theme and
the user can switch it.

# postMessage contract, version 2

## Messages

| Direction | Message | When |
|---|---|---|
| dashboard to host | `{ type: 'ready', version: 2 }` | the first request after the page loads |
| dashboard to host | `{ type: 'token-request', version: 2, reason }` | every later request; `reason` is `expiring`, `unauthorized` or `retry` |
| host to dashboard | `{ type: 'theme', version: 2, theme }` | the answer to `ready`, before the token, and again whenever the HYROS user switches theme; `theme` is `dark` or `white` |
| host to dashboard | `{ type: 'token', version: 2, token, expiresAt? }` | the answer to `ready` and `token-request` |
| dashboard to host | `{ type: 'theme-applied', version: 2, theme }` | after each `theme`, once the page shows in it |

- `version` is the number `2`. A string `"2"`, and any message of version 1,
  is not accepted on either side.
- No `source` field: both sides identify each other by `event.origin` and
  `event.source`.
- `expiresAt` is optional, epoch milliseconds. The dashboard ignores it unless
  it is a finite number in the future.
- Version 2 added the theme. Version 1 had only `ready`, `token-request` and
  `token`.

## Dashboard rules: the token (`src/core/auth.js`)

- Each request is posted to `window.parent` once per origin in
  `CONFIG.hostOrigins`, with that origin as `targetOrigin`. The browser only
  delivers the one that matches the real parent.
- A token is accepted only if `event.source === window.parent`, the origin is
  in `CONFIG.hostOrigins`, `type === 'token'`, `version === 2` and `token` is a
  non-empty string. Anything else is ignored silently. A token that arrives
  while no request is pending is ignored too.
- No answer within 10 s: the request fails with `NO_TOKEN` and the dashboard
  shows "HYROS did not hand over the dashboard credential" with Try again,
  which sends `token-request` with reason `retry`.
- With `expiresAt` the dashboard asks again (`expiring`) 2 minutes before it
  expires, in the background. Without it, the token is kept until the MCP
  answers 401; then the dashboard drops it, asks once (`unauthorized`) and
  retries the call. A second 401 is shown as "HYROS rejected the dashboard
  credential".
- The token lives only in memory.

## Dashboard rules: the theme (`src/core/theme.js`)

- In a frame, `index.html` marks `<html data-theme-pending>` before the
  stylesheet loads, and `styles.css` keeps the page invisible and transparent
  while the mark is there. The page never paints in the wrong theme.
- A theme is accepted only if `event.source === window.parent`, the origin is
  in `CONFIG.hostOrigins`, `type === 'theme'`, `version === 2` and `theme` is
  `dark` or `white`. The dashboard sets `<html data-theme>` to it, removes the
  pending mark and answers `theme-applied` to that same origin.
- Every later `theme` repaints the page at once: no reload, and the data on
  screen stays.
- No theme within 1.5 s: the page shows itself in the default theme, `white`,
  so an error screen is never hidden. A theme that arrives later still applies.
- At its own url there is no host: the page shows at once in `white`, or in
  the theme the user picked with the page's own switch (kept in
  `localStorage` under `hyros-dashboard-theme`, applied by `index.html` before
  the first paint). The switch is hidden inside HYROS, and the saved choice is
  never read there.

## Host rules

- Accept a message only if `event.origin` is the dashboard url's origin and
  `event.source` is the iframe's `contentWindow`, and it matches the contract.
- Post the theme and the token to that exact origin, never to `'*'`.
- Answer `ready` with the theme first, then the token. Post the theme again on
  every switch.
- Keep the dashboard covered until `theme-applied` arrives, with a fallback
  shortly after the iframe `load` for a page that does not speak the contract.

## What HYROS does (`customDashboardChannel.ts`, `customDashboardProtocol.ts`)

| | |
|---|---|
| `ready` | Calls `onReady`, posts the theme of the HYROS user, then a token |
| `token-request` | Answered like `ready` without the theme (any `reason`, or none), does not call `onReady` |
| theme switch | Posts `theme` again (HMCP-392) |
| `theme-applied` | Removes the HYROS loading overlay (HMCP-392) |
| token | A short-lived, read-only dashboard credential with its `expiresAt` (HMCP-368) |
| iframe sandbox | `allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox`, `allow="clipboard-write"` |

## Missing in HYROS

- `allow-downloads` in the sandbox, only if a future view exports files.

# The HYROS sign-in (the dashboard at its own url)

The dashboard signs in through the HYROS MCP OAuth server, the one MCP
clients such as Claude Code use: authorization code with PKCE, as a public
client (no secret). `src/core/auth.js`, `createOAuthProvider`.

| | |
|---|---|
| OAuth server | the origin of the MCP url (`https://mcp.hyros.com` for `https://mcp.hyros.com/mcp`) |
| Registration | `POST /connect/register` once per page url and server; the `client_id` is kept in `localStorage` |
| Sign-in | `GET /oauth2/authorize`, `scope=mcp:read`, `code_challenge_method=S256` |
| Tokens | `POST /oauth2/token`: the code for an access and a refresh token, later the refresh token for new ones |
| Redirect uri | the page url, keeping only `?mcp=` from the query |

## Dashboard rules

- Opened without `?code=`, the page goes straight to the HYROS sign-in. It
  shows a "Sign in with HYROS" button instead when the sign-in failed, the
  session ended, or the user came back from the sign-in page without
  finishing, so it never loops. `?code=` and `?error=` leave the address bar
  (`history.replaceState`) as soon as the page reads them.
- `state` and the PKCE verifier wait in `sessionStorage` while the user is on
  the HYROS sign-in page, and are removed when HYROS redirects back. A code
  whose `state` does not match is refused without calling HYROS.
- The access and the refresh token live in memory only. A new page load signs
  in again.
- A token response whose `scope` lacks `mcp:read` is refused: the dashboard
  never holds more than read access.
- With `expires_in` the token is renewed 2 minutes before it expires, in the
  background. HYROS rotates the refresh token on every use, so the newest one
  is always the one sent, and concurrent requests share one refresh.
- `invalid_grant` (the session was revoked, expired or the refresh token was
  used) and any other OAuth error drop the session and show "Sign in with
  HYROS" again. `invalid_client` also forgets the `client_id`.
- A sign-in that started in this tab and never came back forgets the
  `client_id`, so the next attempt registers again: HYROS shows its own error
  page, instead of redirecting back, for a `client_id` it does not know.

## What HYROS does (HMCP-375)

- Grants `mcp:read` to every dynamically registered client. A token granted
  it is issued as a custom dashboard credential: read-only and accepted at
  `/mcp` only, on refresh too.
- CORS on the OAuth endpoints for any origin, without credentials.
- `Retry-After`, `X-RateLimit-Limit`, `X-RateLimit-Remaining` and
  `X-RateLimit-Reset` exposed to the browser. The dashboard waits what
  `Retry-After` says on a 429.
- Revoking the session in HYROS cuts the dashboard off: `/mcp` answers 401
  and the refresh answers `invalid_grant`.
- No consent screen yet: HYROS signs a user with a live session in without
  asking. Tracked as its own card.
