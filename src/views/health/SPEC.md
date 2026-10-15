# Health: view spec

**id** `health` · **version** 0.1.0 · **tools** `hyros_get_user_info`, `hyros_get_ad_accounts`, `hyros_get_domains`, `hyros_check_tracking_parameters_for_integrations`, `hyros_assert_script_presence_on_domain`, `hyros_get_leads`, `hyros_get_lead_clicks`

## Purpose
"Is tracking actually working?", answered with HYROS's own checks: is the
universal script on the sites behind the verified tracking domains, and do
the Google ad links carry the tracking parameters attribution needs. Just as
important, it says plainly when a check could not run: a `-` in a tile is
never left unexplained.

## Data
Getters (cached for the life of the page): `ctx.data.account()` and
`ctx.data.adAccounts()`. Then four checks, **in series**, cheapest first, so
a slow answer never starves the others. Each check records
`{ status: ok | empty | skipped | failed, reason?, ms? }` (plus `pending`
while it runs).

| Step | Call | Timeout | When |
|---|---|---|---|
| 1 Domains | `hyros_get_domains` with `{}` (the tool takes no arguments; it answers `List<String>`) | `clampTimeout(TIMEOUTS.default, deadline)` | always |
| 2 Params | `hyros_check_tracking_parameters_for_integrations { request: { type } }`, `type` = `SEARCH` then `PERFORMANCE_MAX` | default | only with an ad account of type `GOOGLE` or `GOOGLE_V2` |
| 3 Script | `hyros_assert_script_presence_on_domain { request: { domains: [<= 3 urls] } }`, batches in series | `clampTimeout(TIMEOUTS.slow, deadline)`; a batch is not started with less than 8 s left | last of the three checks |
| 4 Visits | `hyros_get_leads { request: { pageSize: 50 } }` (the 50 newest leads), then `hyros_get_lead_clicks { request: { leadIds, fromDate: today - 7 } }` through `pagedInfo` (`pageSize: 250`, `maxPages: 4`) | default | only when some checked URL did not answer `SUCCESSFUL` or `SCRIPT_DETECTED` |

- Script targets: each verified (tracking) domain is reduced to its
  registrable site (`data.shop.com` -> `shop.com`, `co.uk`-style suffixes
  kept), and both `https://<site>/` and `https://www.<site>/` are checked,
  apex and www together, so the 12-URL cap leaves whole sites out, never half
  of one. The MCP takes at most 3 URLs per call (`AssertScriptPresenceRequest.MAX_DOMAINS`).
- Script outcomes (`TrackingScriptVerificationEvent`): `SUCCESSFUL` and
  `SCRIPT_DETECTED` mean the script is there; `SCRIPT_NOT_FOUND` is the only
  outcome that means it is missing; `TIMEOUT_ERROR`, `UNKNOWN_ERROR` and
  `DOMAIN_NOT_FOUND` are inconclusive ("couldn't check"). Older spellings
  (`SCRIPT_FOUND`, `FOUND`, `OK`, `PRESENT`, `INSTALLED`) still read as found.
- Visits: the script check reads the raw page, so a script a site builder
  injects at runtime reads "not found" on pages HYROS is tracking. The hosts
  (without `www.`) of the clicks' `page` (or `trackedUrl`) prove a site is
  tracked; a visit on a subdomain counts for its site.
- Each step's answer is memoised with `ctx.data.cached`
  (`health:domains`, `health:params:<type>`, `health:script:<urls>`,
  `health:leads`, `health:clicks:<fromDate>`); Refresh clears them.
- Deadline: `start + VIEW_LOAD_MS - 15 s`. No call starts after it; a check
  that cannot start reads "skipped: time budget". A module-level render
  counter stops the series of an older render before its next call.
- `render` resolves after the domains and params checks are painted; the
  script and visits checks fill in afterwards.
- Cost of one render, worst case: 1 + 2 + 4 script batches (45 s each at
  most, the deadline cuts the ones that do not fit) + 1 + up to 4.
- **MCP limits**: at most 50 lead ids per clicks call; `pageSize` 1 to 250;
  one rate limit per account, so everything runs in series. The token is
  applied by the MCP client; the view never sees it.

Replies are read tolerantly (a bare list, or the list under `result`,
`domains` or `ads`; the script map bare or under `result`, or an array of
`{ url | domain, status | result | present }`). A reply the code cannot read
is a **failed** check ("unexpected reply shape"), never an empty one.

## Rows shape
```json
{ "domains": ["data.shop.com"],
  "sites": [{ "url": "https://shop.com/", "trackingDomain": "data.shop.com" }],
  "scripts": { "https://shop.com/": "SCRIPT_NOT_FOUND", "https://www.shop.com/": "SUCCESSFUL" },
  "visitedHosts": ["shop.com"],
  "trackingParams": [{ "type": "SEARCH", "rows": [{ "customerId": "", "campaignId": 0, "campaignName": "", "adGroupId": 0,
      "adGroupName": "", "trackingUrlTemplate": "", "finalUrlSuffix": "", "valid": true }] }],
  "checks": {
    "domains": { "status": "ok", "ms": 412 },
    "params":  { "status": "ok", "ms": 1730, "channels": { "SEARCH": "ok", "PERFORMANCE_MAX": "empty" } },
    "script":  { "status": "ok", "ms": 22000, "reason": "checked 6 of 12 URLs; the rest: time budget", "unchecked": ["https://..."] },
    "visits":  { "status": "skipped", "reason": "every checked URL has the script" } } }
```
A parameter row is flagged when `valid === false` (the DTO's boolean); a
row without `valid` falls back to `missing` or `ok === false`.

## View states
- KPI tiles: Verified domains, Script present (`N / M` sites, green when
  every checked site has it, terracotta when one has neither the script nor
  visits, neutral otherwise), Ads missing tracking params, Check errors.
  A tile whose check did not run shows `-` with "skipped: time budget",
  "failed: <reason>", "no verified domains" or "no Google ad accounts".
- "Checks this render" panel: one row per check with its status pill,
  reason and duration; "Check errors" panel when a check failed.
- Script presence: one row per site with its apex and www outcomes and a
  pill: script found, not detected but visits tracked (amber), couldn't
  check (amber), script not found (terracotta), not checked. Sites cut by
  the cap or the deadline are listed as "not checked".
- Ad link tracking parameters: one row per ad group or campaign; "No ads
  reported by the check in the last hour" only when the check ran empty.
- Account and access: ad accounts, agency relationships, attribution window.
- Running: a check still pending says "running".
- No verified domains: the Verified domains tile reads 0 and the script
  panel says "No verified domains on this account: add one in HYROS".
- Params failed: `failed` with the message; the other checks still run.

## Rules honoured
- Data only through `ctx.data`; read tools only; calls in series.
- Every HYROS string escaped with `ctx.esc`; numbers via `ctx.fmt`.
- Classes prefixed `health-`, tokens only; no color in markup.

## Porting notes
Another dashboard reuses `view.js`, `checks.js` and `style.css` if its
`ctx.data` has `account()`, `adAccounts()`, `call`, `pagedInfo`, `cached`
and `now`. HYROS-specific: the 3-URL cap of the script tool, the outcome
enum above, and Google as the only integration the parameter check covers.

## Open limitations
- The parameter check only covers the integrations HYROS saw in the last
  hour, and only the two Google channels.
- The script check fetches every page live; 45 s is a ceiling, not a
  guarantee, so on a slow account the later batches are skipped.
- The visits cross-check reads the 50 newest leads by join date, so a site
  whose visitors are older leads can read "script not found" while tracked.
- The ad accounts' report warnings (unsupported type, rate limited) that
  hyros-ai showed as pills are not shown: this dashboard has no snapshot.
