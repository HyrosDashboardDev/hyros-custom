# How the dashboard gets its credential

Two ways, picked when the page loads (`src/app.js`):

- **Inside HYROS** (the page runs in a frame): the `postMessage` contract
  below. HYROS (the host) hands the token over, so it never travels in a url.
- **At its own url**: the HYROS sign-in, at the end of this document.

Either way the credential is the same kind: read-only, accepted at `/mcp`
only, held in memory.

# postMessage contract, version 1

## Messages

| Direction | Message | When |
|---|---|---|
| dashboard to host | `{ type: 'ready', version: 1 }` | the first request after the page loads |
| dashboard to host | `{ type: 'token-request', version: 1, reason }` | every later request; `reason` is `expiring`, `unauthorized` or `retry` |
| host to dashboard | `{ type: 'token', version: 1, token, expiresAt? }` | the answer to either |

- `version` is the number `1`. A string `"1"` is not accepted on either side.
- No `source` field: both sides identify each other by `event.origin` and
  `event.source`.
- `expiresAt` is optional, epoch milliseconds. The dashboard ignores it unless
  it is a finite number in the future.

## Dashboard rules (`src/core/auth.js`)

- Each request is posted to `window.parent` once per origin in
  `CONFIG.hostOrigins`, with that origin as `targetOrigin`. The browser only
  delivers the one that matches the real parent.
- A token is accepted only if `event.source === window.parent`, the origin is
  in `CONFIG.hostOrigins`, `type === 'token'`, `version === 1` and `token` is a
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

## Host rules

- Accept a message only if `event.origin` is the dashboard url's origin and
  `event.source` is the iframe's `contentWindow`, and it matches the contract.
- Post the token to that exact origin, never to `'*'`.

## What HYROS does today

Branch `HMCP-339-custom-dashboard-embed`, `customDashboardChannel.ts` and
`customDashboardProtocol.ts`:

| | Today |
|---|---|
| `ready` | Accepted, calls `onReady`, answered with a token if there is one |
| `token-request` | Accepted (any `reason`, or none), answered like `ready`, does not call `onReady` |
| `expiresAt` | Sent in the `token` message when the token source provides a finite number |
| token | Asked from `getCustomDashboardToken()` on every request. It resolves `undefined`, so nothing is answered |
| iframe sandbox | `allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox`, `allow="clipboard-write"` |

So inside HYROS the dashboard always reaches the 10 s timeout. That is
expected until HYROS issues a token.

## Missing in HYROS

- A `getCustomDashboardToken()` that returns a real short-lived token with
  read-only scope, accepted only by `/mcp`, and its expiry as `expiresAt`.
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
