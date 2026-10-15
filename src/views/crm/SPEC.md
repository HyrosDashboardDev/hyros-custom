# CRM: view spec

**id** `crm` · **version** 0.1.0 · **tools** `hyros_get_user_info`, `hyros_get_stages`,
`hyros_get_leads`, `hyros_get_leads_aggregation`, `hyros_get_sales`, `hyros_get_sales_aggregation`,
`hyros_get_calls`, `hyros_get_calls_aggregation`, `hyros_get_subscriptions`, `hyros_get_lead_journey`,
`hyros_get_lead_clicks`

## Purpose
The people behind the numbers: the leads, sales, calls and subscriptions of
a date range, newest first, with the account totals for that range on top.
A click on an email opens that lead's journey and click history. It answers
"who joined, bought or booked in this range, and where did they come from".

## Data
Four sub-tabs (`.chipset` with a `.chip-count` each). **One render loads only
the active sub-tab** (leads on entry); the others load when their chip is
clicked and stay in `ctx.data.cached` until Refresh.

Range: today, yesterday, last 7 days, last 30 days (`buildRanges(now, tz)`)
or custom (two `<input type=date>`; end <= today in the account zone and
start <= end, otherwise nothing is called and the view says why). Request
dates: `fromDate = dayStart(start, tz)`, `toDate = dayEnd(end, tz, now)`, so
"today" ends at the current time and no bound is in a future month (the
aggregations reject that).

Every call of a render runs **in series**: `account()` (cached), then
`stages()` on the leads tab (cached getter, for the stage select), then the
aggregations, then the list.

| Sub-tab | Aggregations (tiles) | List |
|---|---|---|
| Leads | `hyros_get_leads_aggregation { attribute: 'STAGE', groupsLimit: 1000, ...range, ...filters }` and `{ attribute: 'FIRST_SOURCE_TAG', groupsLimit: 1000, ...}` | `hyros_get_leads` |
| Sales | `hyros_get_sales_aggregation { attribute: 'FIRST_SOURCE_TAG', groupsLimit: 1000, ... }` | `hyros_get_sales` |
| Calls | `hyros_get_calls_aggregation { attribute: 'CALL_QUALIFICATION', groupsLimit: 1000, ... }` and, unless a qualified filter is set, the same with `qualified: true` | `hyros_get_calls` |
| Subscriptions | none (no aggregation tool) | `hyros_get_subscriptions` |

Lists: `ctx.data.pagedInfo(tool, { request: { fromDate, toDate, ...filters } },
{ maxPages: 8, pageSize: 250, deadline, timeoutMs })`: at most 2,000 rows,
newest first. Aggregations: `ctx.data.call(tool, { request }, { timeoutMs })`.
`timeoutMs = clampTimeout(TIMEOUTS.default, deadline)`.

Filters are tool parameters (names and enum values from the MCP request DTOs);
the aggregation of a sub-tab gets the same filters as its list, so the tiles
and the table describe the same set:

| Sub-tab | Control | Parameter |
|---|---|---|
| all | email search (prefix, at least 3 characters, 400 ms debounce, lower-cased) | `emails: [text]` |
| Leads | stage select (options from `ctx.data.stages()`) | `stage: [name]` |
| Leads | tags (comma separated, max 50) | `tags: [...]` (OR) |
| Sales | recurring | `isRecurringSale: RECURRING \| NON_RECURRING` (ALL is not sent) |
| Sales | refund | `saleRefundedState: REFUNDED \| NON_REFUNDED` (ALL is not sent) |
| Calls | qualified | `qualified: true \| false` |
| Calls | qualification stage (options from the `CALL_QUALIFICATION` groups) | `qualificationStages: [name]` |
| Subscriptions | status | `subscriptionStates: [ACTIVE \| TRIALING \| CANCELED \| PAST_DUE \| INCOMPLETE \| INCOMPLETE_EXPIRED \| UNPAID \| COMPLETED \| PAUSED \| UNKNOWN]` |

Client side only, on the loaded rows: header sort (`src/ui/table.js`) and,
on leads, the "with / without a source" filter (`hasAttribution`; the API has
no such parameter).

Cache keys (`ctx.data.cached`): `crm:<tab>:<start>:<end>:<filters JSON>:list`
and `...:agg:<name>`. A list that came back cut by the time budget or an
expired cursor (`pagedInfo` answered `error`) is shown but its key is retired,
so the next render loads it again instead of keeping the partial list. A failed
call is never cached (the data API drops rejected loaders).

Cost of one cold render, worst case: leads 1 (stages) + 2 + 8 pages; sales
1 + 8; calls 2 + 8; subscriptions 8. The journey drawer costs 2 more
(`openLeadJourney`). A warm render (same tab, range and filters) costs none.

Time: deadline of a load = start + `VIEW_LOAD_MS` - 15 s (105 s). No call
starts after it. A module-level render counter stops an older load before
its next call when a newer one started (control change, sub-tab, Refresh)
or when its root left the page (a switch to another tab).

**MCP limits:** at most 50 emails, tags or stages per call (one email
prefix, one stage, up to 50 tags); `pageSize` 250; 15 s per call; one rate
limit per account, so everything runs in series. The token is applied by
the MCP client; the view never sees it.

## Rows shape
```json
{
  "aggs": {
    "stage":       { "total": 1200, "groups": [{ "key": "Customer", "count": 80 }], "grouped": 1100, "remaining": 0 },
    "firstSource": { "total": 1200, "grouped": 900, "remaining": 12, "revenueUsd": null }
  },
  "aggErrors": [{ "name": "firstSource", "message": "" }],
  "list": { "rows": [], "truncated": false, "error": null },
  "listError": null
}
```
Lead row: `{ id, email, name, joined, joinedMs, stage, consent, tags, tagList,
firstSource: { name, tag, organic, trafficSource, category, clickDate },
lastSource, firstSourceName, lastSourceName, lastSourceDate, lastSourceMs,
hasAttribution }`. Leads with `originLead` (merged into another) are dropped.
Sale row: `{ id, email, leadName, date, dateMs, amount, currency, usdAmount?,
product, recurring, refunded, refundDate, firstSource, lastSource }`
(`amount`/`currency` from `priceOf`). Call row: `{ id, email, leadName,
date, dateMs, name, state, qualified, firstSource, ad, lastSource }`.
Subscription row: `{ id, email, leadName, date, dateMs, endDate, name,
price, currency, periodicity, status, provider }`.

Dates are ISO (`parseHyrosDate(v, offsetSuffix(tz))`: lead and sale/call
`creationDate` already ISO, `refundDate`, subscription dates and
source `clickDate` may be legacy `EEE MMM dd HH:mm:ss zzz yyyy`). `*Ms` are
the same dates as epoch milliseconds, the sort keys.

Tiles:
- Leads: Leads = STAGE `totalCount`; With a first source = sum of the
  FIRST_SOURCE_TAG groups + `remainingCount` (each lead has at most one first
  source); Customers = the STAGE group `Customer`.
- Sales: Sales = `totalCount`; With a first source = groups + remaining;
  Revenue (USD, HYROS stable price) = sum of `groups[].details.revenue.amount`,
  which covers only sales with a first source, and is a lower bound ("+") when
  `remainingCount > 0`. Behind `SHOW_USD_REVENUE` so it can be dropped.
  Plus "Revenue in rows" in the account currency from the loaded rows.
- Calls: Calls = `totalCount`; Qualified = `totalCount` of the `qualified:
  true` aggregation (the CALL_QUALIFICATION groups are stage names, they do
  not say which stage counts as qualified).
- Subscriptions: count, active or trialing, canceled, active value, all from
  the loaded rows with "+" when the list is cut.

## View states
- Data: range line, tiles, controls, `table.dense` sorted newest first.
- Cut list: "N+ leads, showing newest N" beside the title and "+" on the chip.
- Time budget or cursor cut: same, plus the reason.
- One aggregation failed: its tiles print `-` and a `.note.err` says which;
  the table still renders.
- The list failed: `.note.err` with the message and a Retry button for the
  sub-tab; the tiles still render.
- Attribution filter on: note "on the N rows shown" (and "newest N of M+"
  when the list is cut).
- Empty: `.empty` "No leads joined between <start> and <end>" (or the
  filters matched nothing).
- Invalid custom range: `.note.err` with the reason, no call made.

## Rules honoured
- Data only through `ctx.data`; read tools only; calls in series.
- Every string from HYROS escaped with `ctx.esc`; numbers and money through
  `ctx.fmt` (`moneyIn` for a sale or subscription in its own currency).
- Counts are taken from `totalCount`, never by summing groups (a lead with
  several tags is in several TAG groups; one without the attribute in none).
- View-specific classes prefixed `crm-`, tokens only; no long dashes.

## Porting notes
Needs `ctx.data` with `account()`, `stages()`, `call`, `pagedInfo`,
`cached`, `peek`, `now`, and `src/ui/drill.js` (`openLeadJourney`,
`priceOf`) and `src/ui/table.js`. The pure parts (`filters.js`: requests,
range; `rows.js`: row shapes and aggregation readers; `load.js`: the
orchestration; `markup.js`: tiles, chips and tables as HTML strings) run
without a DOM.

## Open limitations
- No per-lead income column: the window's sales would have to be loaded
  with the leads (two lists per render).
- Search is an email prefix only (the tools have no name search).
- "With / without a source" on leads is client side, so it covers only the
  loaded rows; the tile "With a first source" is the account figure.
- `pagedInfo` walks its pages without the render counter: a stale load
  finishes its current list (at most 8 pages) before it stops.
- The USD revenue tile excludes sales without a first source and sales in
  groups past `groupsLimit` (then marked "+").
