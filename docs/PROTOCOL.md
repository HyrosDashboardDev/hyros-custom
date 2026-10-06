# postMessage contract, version 1

HYROS (the host) embeds the dashboard in an iframe and hands it the token
over `postMessage`, so the token never travels in a url.

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
- `exposedHeaders: Retry-After, X-RateLimit-Limit, X-RateLimit-Remaining,
  X-RateLimit-Reset` in the CORS config of `/mcp`. Until then the dashboard
  cannot read `Retry-After` and waits a fixed 1 s, then 2 s, on a 429.
- `allow-downloads` in the sandbox, only if a future view exports files.
