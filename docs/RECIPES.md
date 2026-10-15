# Recipes

How to build a view on this dashboard. Every view runs in the browser and
reaches HYROS only through `ctx.data`: it loads what it shows when it
renders, straight from the MCP, with the token the shell holds. Each recipe
below says which tools to call, with
which arguments, and how to turn the answers into rows. The official
reference for every tool is https://api-docs.hyros.com; when this file and
the docs disagree, the docs win.

## Every recipe

- Call tools through `ctx.data.call(tool, args, opts)`,
  `ctx.data.paged(...)` or `ctx.data.pagedInfo(...)`. `pagedInfo` answers
  `{ rows, truncated, error? }`: when `truncated` is true the list hit the
  page cap, the cursor expired or a call failed, so say "showing newest N
  rows" instead of presenting the table as complete.
- Only tools in `READ_TOOLS` (`src/core/mcp.js`) can be called.
- Every tool wants its arguments under `{ request: { ... } }`; flat arguments
  are rejected. Enum values go in upper case (`ACCOUNT`, `FIRST_CLICK`).
- The rate limit is per account: 30 requests per second and 1,000 per
  minute by default, shared by every caller of the account. Run calls for
  one account in sequence, or a few at a time; parallel fan-out trades rows
  for 429s.
- Array filters (`ids`, `emails`, `tags`, `leadIds`, `stages`) take at most
  50 items; `pageSize` is 1 to 250; `hyros_get_lead_journey` takes at most
  50 leads per call.
- A view loads what it shows when it renders. Anything slow needs its own
  partial states, and one failing call should become a warning in the view,
  never a blank page.
- `src/core/dates.js`: `parseTimezone`, `ymdInTz`, `dayStart`, `dayEnd`,
  `parseHyrosDate`, `addDays`, `offsetSuffix`. The account timezone comes
  from `ctx.data.account().timezone` as HYROS stores it (`"-05:00"`,
  `"UTC"`, `"America/New_York"`).
- `src/core/budget.js` has `TIMEOUTS` (`default` 15 s, `slow` 45 s) and
  `clampTimeout` for per-call timeouts.
- `ctx.data.account()`, `adAccounts()`, `sources()` and `stages()` are
  cached for the life of the page; three views asking cost one call. Any
  other load a view wants to keep goes through `ctx.data.cached(key, loader)`,
  which Refresh clears too.
- `src/data/metrics.js` is the metric engine (`CATALOG`, `derive`,
  `aggregate`, `rollup`) and `src/data/report-levels.js` the report's level
  model (`REPORT_FIELDS`, `LEVELS_BY_TYPE`, `normalizeRow`, `buildLevels`,
  `buildRanges`). Import them; do not copy the formulas.

## Start a view

Copy `src/views/_template/` to `src/views/<id>/`, set the `view` fields,
write `SPEC.md` first, add the id to `CUSTOM_VIEWS` in `src/views/custom.js`. The contract
(the `view` object, `ctx`, the shared markup kit, `SPEC.md`) is `VIEWS.md`;
`npm run check` verifies it. `src/views/account/` is the worked example.

## Report (Performance Report)

One `hyros_get_attribution_report` call per ad account, per level, per date
range, then rollups in the browser. The HYROS report screen's Campaign,
Traffic and Account tabs are not report levels: they are built by joining
ad-set rows to `hyros_get_sources` and grouping. `src/views/report/` is this
recipe built (its `SPEC.md` has the cache keys other tabs can read).

### 1. Date ranges

Ranges are `YYYY-MM-DD` in the account timezone:

| Key | Start | End |
|---|---|---|
| `today` | `ymdInTz(now, tz)` | same |
| `yesterday` | `addDays(today, -1)` | same |
| `7d` | `addDays(today, -6)` | today |
| `30d` | `addDays(today, -29)` | today |

The request takes `startDate: dayStart(range.start, tz)` and
`endDate: dayEnd(range.end, tz, now)`. The report rejects any date after the
current time, so "today" ends now, not at 23:59:59.

### 2. Levels per ad account type

`ctx.data.adAccounts()` gives `{ id, name, type }`. The `level` enum each
type accepts (the live MCP names them in upper case):

| Ad account `type` | ad-set level | ad level |
|---|---|---|
| `FACEBOOK` | `FACEBOOK_ADSET` | `FACEBOOK_AD` |
| `GOOGLE` (classic) | `GOOGLE_CAMPAIGN` | `GOOGLE_AD` |
| `GOOGLE_V2` | `GOOGLE_V2_ADGROUP` | none |
| `TIKTOK` | `TIKTOK_ADGROUP` | `TIKTOK_AD` |
| `SNAPCHAT` | `SNAPCHAT_ADSET` | `SNAPCHAT_AD` |
| `PINTEREST` | `PINTEREST_ADGROUP` | `PINTEREST_AD` |
| `TWITTER` | `TWITTER_ADGROUP` | none |
| `BING` | `BING_ADGROUP` | `BING_AD` |
| `LINKEDIN` | `LINKEDIN_CAMPAIGN` | none |

Any other type (`REDDIT`, `APPLOVIN`, `WHOP_ADS`, ...) has no attribution
level: skip it with a warning. "Accepted" is not "supported": classic
`GOOGLE` rejects `GOOGLE_ADGROUP`, so stay with the table.

### 3. The call

```js
const page = await ctx.data.pagedInfo('hyros_get_attribution_report', {
  request: {
    attributionModel: 'LAST_CLICK',          // or FIRST_CLICK, SCIENTIFIC
    startDate: dayStart(range.start, tz),
    endDate: dayEnd(range.end, tz, now),
    level,                                   // from the table above
    ids: [adAccountId],
    isAdAccountId: true,
    timeGroupingOption: 'SOURCE_LINK',       // the only grouping an ad-account id allows
    newestFirst: true,                       // oldest-first fills the page with ads that no longer run
    sourceConfiguration: 'ALL_SOURCES',      // how the report screens attribute
    reportSourceVisibility: true,            // leave deleted source links out, like the report screens
    fields: REPORT_FIELDS,                   // every metric you will show; unrequested ones come back null
    // windowAttributionDaysRange: 7,        // LAST_CLICK only, 1 to 365
    // leadStage: ['Customer'],              // must match account stage names, see ctx.data.stages()
  },
}, { maxPages: 8, pageSize: 250, deadline, timeoutMs: clampTimeout(TIMEOUTS.default, deadline) });
```

Run the calls in sequence, and give the render a deadline
(`start + VIEW_LOAD_MS - 15000`): an account with many ad accounts needs one
call per ad account, so the last ones may not fit; list them as skipped
instead of failing the view. 8 pages are the newest 2,000 sources of an ad
account; say so when `truncated` is true. One ad account failing
(unsupported level, disconnected integration) becomes a warning for that
account, never a failed view. Rows carry `id`, `name`, `parentId`,
`parentName` and the metrics, but no category or traffic source: stamp the
ad account id of the call on each row (`_account`) and get the rest from
the join (step 6).

### 4. Normalize a row

- `id` as a string, `name`, `parentName`, and `parentId` (ad-level rows
  carry the id of their ad set; it is what links ads to ad sets).
- Keep every metric the API populated; drop nulls (null means not computed).
  `reported` comes from the response key `reportedResult`.
- Zero the additive base so derived math is stable: `cost`, `revenue`,
  `totalRevenue`, `sales`, `leads`, `calls`, `clicks`, `impressions`,
  `reported`.
- Then derive (next step).

### 5. Derived metrics

`derive(row)` in `src/data/metrics.js` computes them and
`tests/metrics.test.mjs` checks it against a real report screen; the table
below is what it does. Native rows keep HYROS's own numbers; a derived value is computed only when
the API did not supply one, except the core set, which is always recomputed
so totals agree with their parts. Never average a derived metric across
children: sum the additive parts and re-derive.

| Metric | Formula |
|---|---|
| `totalRevenue` | as given; when 0 or missing, `revenue` (HYROS's ROAS counts rebills, so profit, ROI and ROAS use it) |
| `profit` | `totalRevenue - cost` |
| `roas` | `totalRevenue / cost` (null when cost is 0) |
| `roi` | `(totalRevenue - cost) / cost * 100` |
| `reportedVsRevenue` | `revenue - reported` |
| `ctr` | `clicks / impressions * 100` |
| `cpm` | `cost / impressions * 1000` |
| `costPerClick`, `costPerLead`, `costPerNewLead`, `costPerSale`, `costPerUniqueSales`, `costPerCall`, `costPerQualifiedCall`, `costPerUniqueCall`, `costPerNewVisit`, `costPerUniqueCustomer`, `costPerNewSubscriptions`, `costPerNewTrials`, `costPerAtc` | `cost / <count>` |
| `averageOrderValue` | `revenue / sales` |
| `cvr` | `sales / clicks * 100` |
| `refundedSalesPercentage` | `refundCount / sales * 100` |
| `refundedRevenuePercentage` | `refund / revenue * 100` |
| `atcCvr` | `purchasedCarts / carts * 100` |

Checked against a real Performance Report screen: revenue 560,291.77 and
reported 900.00 give Reported Vs Revenue 559,391.77; cost 4,129.58 with
revenue 0 gives profit -4,129.58 and ROI -100.00%.

### 6. Rollups

Join each ad-set row to its source by id. Do not page the whole source
list (`ctx.data.sources()`): a large account has more than 10,000 sources,
which is 40 calls and still cut short. Ask only for the ids on screen,
50 at a time, in sequence, and remember what came back for the life of the
page:

```js
ctx.data.pagedInfo('hyros_get_sources', { request: {
  adSourceIds: ids,                           // at most 50 ad-set row ids
  includeOrganic: true, includeDisregarded: true,
} }, { maxPages: 2, pageSize: 250, deadline, timeoutMs });
```

A row's `id` matches the source's `adSource.adSourceId`. The source gives
`name` (ad-set rows sometimes come back unnamed), `tag`, `category.name`
and `trafficSource.name`. An ad row joins through its `parentId` (the ad
set). `buildLevels` in `src/data/report-levels.js` does the grouping:

| Tab | Group ad-set rows by | Label |
|---|---|---|
| Campaign | `category.name` | the category |
| Traffic | `trafficSource.name` | the traffic source |
| Account | `adAccountId` | the ad account name |
| Ad set | no grouping | the ad set |
| Ad | no grouping (ad-level rows) | the ad |

A rolled-up row sums the additive metrics of its members and re-derives the
rest. Metrics HYROS computes per row and that cannot be summed show "-" on
rolled-up rows. Carry the union of the members' source `tags` (at most 40)
on every rolled-up row: it is what the Drill recipe queries.

### 7. The metric catalog

`fields` enum to response key. Rollup: `sum` is added on rollup, `derive`
is recomputed from the sums, `none` is native rows only.

| Group | `fields` value | Row key | Type | Rollup |
|---|---|---|---|---|
| Core | `CLICKS` | `clicks` | int | sum |
| Core | `COST` | `cost` | money | sum |
| Core | `TOTAL_REVENUE` | `totalRevenue` | money | sum |
| Core | `REVENUE` | `revenue` | money | sum |
| Core | `PROFIT` | `profit` | money | derive |
| Core | `REPORTED_RESULT` | `reported` (from `reportedResult`) | money | sum |
| Core | `REPORTED_VS_REVENUE` | `reportedVsRevenue` | money | derive |
| Core | `SHOP_REPORTED_RESULT` | `shopReportedResult` | money | sum |
| Core | `SALES` | `sales` | int | sum |
| Core | `UNIQUE_SALES` | `uniqueSales` | int | sum |
| Core | `ROI` | `roi` | pct | derive |
| Core | `ROAS` | `roas` | ratio | derive |
| Core | `LEADS` | `leads` | int | sum |
| Core | `NEW_LEADS` | `newLeads` | int | sum |
| Core | `LEADS_OPTINS` | `leadsOptins` | int | sum |
| Core | `IMPRESSIONS` | `impressions` | int | sum |
| Core | `CTR` | `ctr` | pct | derive |
| Core | `CPM` | `cpm` | money | derive |
| Core | `CVR` | `cvr` | pct | derive |
| Core | `NEW_VISITS` | `newVisits` | int | sum |
| Core | `PARTIAL_VIDEO_VIEWS` | `partialVideoViews` | int | sum |
| Cost per | `COST_PER_CLICK` | `costPerClick` | money | derive |
| Cost per | `COST_PER_LEAD` | `costPerLead` | money | derive |
| Cost per | `COST_PER_NEW_LEAD` | `costPerNewLead` | money | derive |
| Cost per | `COST_PER_SALE` | `costPerSale` | money | derive |
| Cost per | `COST_PER_UNIQUE_SALE` | `costPerUniqueSales` | money | derive |
| Cost per | `COST_PER_CALL` | `costPerCall` | money | derive |
| Cost per | `COST_PER_QUALIFIED_CALL` | `costPerQualifiedCall` | money | derive |
| Cost per | `COST_PER_UNIQUE_CALL` | `costPerUniqueCall` | money | derive |
| Cost per | `COST_PER_NEW_VISIT` | `costPerNewVisit` | money | derive |
| Cost per | `COST_PER_UNIQUE_CUSTOMER` | `costPerUniqueCustomer` | money | derive |
| Cost per | `COST_PER_NEW_SUBSCRIPTIONS` | `costPerNewSubscriptions` | money | derive |
| Cost per | `COST_PER_NEW_TRIALS` | `costPerNewTrials` | money | derive |
| Cost per | `COST_PER_ATC` | `costPerAtc` | money | derive |
| Cost per | `CAC` | `cac` | money | none |
| Calls | `CALLS` | `calls` | int | sum |
| Calls | `QUALIFIED_CALLS` | `qualifiedCalls` | int | sum |
| Calls | `UNQUALIFIED_CALLS` | `unqualifiedCalls` | int | sum |
| Calls | `UNIQUE_CALLS` | `uniqueCalls` | int | sum |
| Calls | `CANCELED_CALLS` | `canceledCalls` | int | sum |
| Calls | `NO_SHOW_CALLS` | `noShowCalls` | int | sum |
| Customers | `CUSTOMERS` | `customers` | int | sum |
| Customers | `UNIQUE_CUSTOMERS` | `uniqueCustomers` | int | sum |
| Customers | `TOTAL_CUSTOMERS` | `totalCustomers` | int | sum |
| Customers | `RECURRING_CUSTOMERS` | `recurringCustomers` | int | sum |
| Customers | `RETURNING_CUSTOMERS` | `returningCustomers` | int | sum |
| Customers | `NEW_CUSTOMERS_ORDERS` | `newCustomersOrders` | int | sum |
| Customers | `UNIQUE_CUSTOMERS_REVENUE` | `uniqueCustomersRevenue` | money | sum |
| Customers | `RETURNING_CUSTOMERS_REVENUE` | `returningCustomersRevenue` | money | sum |
| Customers | `AOV` | `averageOrderValue` | money | derive |
| Customers | `NEW_CUSTOMERS_PERCENTAGE` | `newCustomersPercentage` | pct | none |
| Customers | `RECURRING_CUSTOMERS_PERCENTAGE` | `recurringCustomersPercentage` | pct | none |
| Customers | `RETURNING_CUSTOMERS_RATE` | `returningCustomersRate` | pct | none |
| Customers | `RETURNING_CUSTOMERS_REVENUE_RATE` | `returningCustomersRevenueRate` | pct | none |
| Customers | `NEW_CUSTOMERS_ROAS` | `newCustomersRoas` | ratio | none |
| Customers | `NEW_CUSTOMERS_AOV` | `newCustomersAov` | money | none |
| Revenue detail | `RECURRING_REVENUE` | `recurringRevenue` | money | sum |
| Revenue detail | `ONE_TIME_SALES` | `oneTimeSales` | int | sum |
| Revenue detail | `REFUND` | `refund` | money | sum |
| Revenue detail | `REFUND_COUNT` | `refundCount` | int | sum |
| Revenue detail | `REFUNDED_SALES_PERCENTAGE` | `refundedSalesPercentage` | pct | derive |
| Revenue detail | `REFUNDED_REVENUE_PERCENTAGE` | `refundedRevenuePercentage` | pct | derive |
| Revenue detail | `HARD_COSTS` | `hardCosts` | money | sum |
| Revenue detail | `TAXES` | `taxes` | money | sum |
| Revenue detail | `COST_OF_GOODS` | `costOfGoods` | money | sum |
| Revenue detail | `SHIPPING_VALUE` | `shippingValue` | money | sum |
| Revenue detail | `NET_PROFIT` | `netProfit` | money | none |
| Revenue detail | `NET_PROFIT_PERCENTAGE` | `netProfitPercentage` | pct | none |
| Revenue detail | `GROSS_MARGINS` | `grossMargins` | pct | none |
| Revenue detail | `CONTRIBUTION_PROFIT` | `contributionProfit` | money | none |
| Revenue detail | `CONTRIBUTION_MARGIN` | `contributionMargin` | pct | none |
| Subscriptions | `NEW_SUBSCRIPTIONS` | `newSubscriptions` | int | sum |
| Subscriptions | `CANCELED_SUBSCRIPTIONS` | `canceledSubscriptions` | int | sum |
| Subscriptions | `DIRECT_SUBSCRIPTIONS` | `directSubscriptions` | int | sum |
| Subscriptions | `MRR` | `mrr` | money | sum |
| Subscriptions | `NEW_MRR` | `newMRR` | money | sum |
| Subscriptions | `ARR` | `arr` | money | sum |
| Subscriptions | `CHURN_RATE` | `churnRate` | pct | none |
| Subscriptions | `NEW_TRIALS` | `newTrials` | int | sum |
| Subscriptions | `CONVERTED_TRIALS` | `convertedTrials` | int | sum |
| Subscriptions | `CANCELED_TRIALS` | `canceledTrials` | int | sum |
| Forecasts | `SUBSCRIPTION_30_DAYS_FORECAST` | `subscription30DaysForecast` | money | none |
| Forecasts | `SUBSCRIPTION_60_DAYS_FORECAST` | `subscription60DaysForecast` | money | none |
| Forecasts | `SUBSCRIPTION_90_DAYS_FORECAST` | `subscription90DaysForecast` | money | none |
| Forecasts | `SUBSCRIPTION_6_MONTHS_FORECAST` | `subscription6MonthsForecast` | money | none |
| Forecasts | `SUBSCRIPTION_1_YEAR_FORECAST` | `subscription1YearForecast` | money | none |
| Ecom | `CARTS` | `carts` | int | sum |
| Ecom | `ATC_EVENTS` | `atcEvents` | int | sum |
| Ecom | `PURCHASED_CARTS` | `purchasedCarts` | int | sum |
| Ecom | `CART_CONVERSION_RATE` | `atcCvr` | pct | derive |
| Ecom | `ATC_RATE` | `atcRate` | pct | none |
| Attribution | `TIME_OF_SALE_ATTRIBUTION` | `timeOfConversionAttributionAvg` | ratio | none |
| Attribution | `TIME_OF_CALL_ATTRIBUTION` | `timeOfCallAttributionAvg` | ratio | none |

Leave the LTV fields (`LTV_*`, `LTV_*_FORECAST`) out: HYROS returns 0 for
every one of them today (HMCP-359). The `fields` list drives computation,
so request every metric the view may show and add columns client side.

A sensible default column set: `clicks`, `cost`, `totalRevenue`, `revenue`,
`profit`, `reported`, `reportedVsRevenue`, `sales`, `roi`, `roas`, `calls`,
`leads`, `costPerLead`, `impressions`, `ctr`, `cpm`.

## CRM

Four lists (leads, sales, calls, subscriptions) for the window the view
shows. Load only the one on screen, and the others when the user opens
them: a large account has thousands of leads and sales a month, and four
lists of 8 pages each do not fit in one render. `src/views/crm/` is this
recipe built.

```js
const fromDate = dayStart(start, tz);
const toDate = dayEnd(end, tz, now);          // never a bound in a future month
const page = await ctx.data.pagedInfo('hyros_get_leads',
  { request: { fromDate, toDate, ...filters } },
  { maxPages: 8, pageSize: 250, deadline, timeoutMs: clampTimeout(TIMEOUTS.default, deadline) });
```

The lists come newest first, so a `truncated` list is "showing newest
2,000". Filter on the server, with the tool's own parameters: `emails`
(prefixes), `stage` and `tags` on leads, `isRecurringSale` and
`saleRefundedState` on sales, `qualified` and `qualificationStages` on
calls, `subscriptionStates` on subscriptions. Leads have no parameter for
"has a source": filter that on the loaded rows and say it applies to them.

Counts for the tiles come from the aggregation tools, not from the loaded
rows, so they hold when the list is cut short. Send them the same range and
filters as the list:

| Tool | `attribute` | What it answers |
|---|---|---|
| `hyros_get_leads_aggregation` | `STAGE` | `totalCount` = leads in the range; the `Customer` group |
| `hyros_get_leads_aggregation` | `FIRST_SOURCE_TAG` | leads with a first source = sum of `groups[].count` + `remainingCount` |
| `hyros_get_sales_aggregation` | `FIRST_SOURCE_TAG` | `totalCount` = sales; `groups[].details.revenue` is USD (HYROS stable price) and covers sales with a first source only |
| `hyros_get_calls_aggregation` | `CALL_QUALIFICATION` | `totalCount` = calls; the groups are qualification stage names, which do not say which one counts as qualified: ask again with `qualified: true` for that tile |

Each answers `{ groups: [{ key, count, details? }], remainingCount, totalCount }`.
The groups are not a total: a lead without the attribute is in no group,
and with `TAG` a lead is in one group per tag. Pass `groupsLimit: 1000`.
There is no aggregation for subscriptions; count the loaded rows and mark
the tile "+" when the list was cut.

Dates: `creationDate` on leads, sales and calls is ISO; `refundDate`, the
subscription dates and click dates still come in the legacy
`EEE MMM dd HH:mm:ss zzz yyyy` form. Read every date with
`parseHyrosDate(value, offsetSuffix(tz))`, which takes both.

Money on a sale or subscription: the `price` object (`price.price`,
`price.currency`) is in the account currency and wins; the undocumented
`usdPrice` is a USD conversion, use it only when `price` is missing. A
mixed-currency account sums face values.

What to keep from each row:

| List | Fields |
|---|---|
| Lead | `id`, `email`, name (`firstName` + `lastName`), `joined` = `creationDate`, `updated` = `lastUpdatedDate`, `stage` = `currentStage.name`, `stageDate` = `currentStage.date`, `consent` = `adOptimizationConsent`, `tags`, `phoneNumbers`, `firstSource` and `lastSource` flattened to `{ name, tag, organic, trafficSource.name, category.name, clickDate }`, `hasAttribution` = either source present. A lead with `originLead` was merged into another: drop it |
| Sale | `id`, `lead.email`, lead name, `date` = `creationDate`, amount and currency, `product.name`, `recurring`, refunded = `refundDate` present, `firstSource.name`, `lastSource.name` |
| Call | `id`, `lead.email`, lead name, `date` = `creationDate`, `name` or `tag`, `state` (else `QUALIFIED` / `UNQUALIFIED` from `qualified`), the ad = `firstSource.sourceLinkAd.name` or `lastSource.sourceLinkAd.name`. Calls carry full attribution on the call itself, richer than the lead row |
| Subscription | `id` or `subscriptionId`, `lead.email`, `date` = `startDate` or `creationDate`, `endDate`, `name` or `planId`, price, `periodicity`, `status`, `provider.integration.name` |

Income per lead: the lead object has no revenue field. Show it where one
lead is open (the Drill journey sums its sales in the account currency)
rather than joining every sale of the window to every lead.
`ctx.data.stages()` gives the stage names for the stage filter.

## Drill

`src/ui/drill.js` implements this recipe (`openCohortDrill`,
`openLeadJourney`); a view calls it instead of repeating the steps.

The click-through behind a report number. Sources carry a `tag`; a rolled-up
row carries the union of its members' tags (Report step 6).

- Cohort: `hyros_get_leads` with `{ request: { tags, pageSize: 250 } }`.
  The `tags` filter is OR. Say in the panel that the cohort is the leads
  that touched those sources, which is not the attribution-credited count
  in the cell (models reassign credit).
- Sales and calls of the cohort: there is no tag filter on those tools, so
  take the cohort's lead ids and call `hyros_get_sales` / `hyros_get_calls`
  with `{ request: { leadIds } }` in batches of 50 (the filter's cap), in
  sequence, at most 4 pages of 250 per batch. Any truncation reads
  "newest shown".
- One lead: `hyros_get_lead_journey` with
  `{ request: { emails: [email], includeEvents: true } }` gives
  `{ lead, sales, calls, journey: [{ type, date, name, keyword, extra, subNames }] }`;
  `hyros_get_lead_clicks` with `{ request: { emails: [email], fromDate, pageSize: 100 } }`
  (`fromDate` a year back; `email` is deprecated) gives
  `result: [{ date, page | trackedUrl, previousUrl, sourceLinkName, adspendType }]`.
  The clicks call is best effort: a failure must not blank the journey.
- Open the drill as a panel inside the view. No modals.

## Scale (marginal CAC)

One `hyros_get_marginal_cac_curve` call per target, in sequence, each one
independent: a curve that errors is stored with its message so the tab can
say why it is empty. `src/views/scale/` is this recipe built.

- Targets: the ad accounts the user picks at `level: 'ACCOUNT'`, plus the
  top 6 ad sets by 30-day cost at `level: 'SOURCE_LINK'`. Ranking ad sets
  needs the Report's 30-day ad-set rows: read them with
  `ctx.data.peek('report:LAST_CLICK:0:<start>:<end>:adset')` (it never loads
  anything) and leave the ad sets out when they are not there.
- Request: `{ id, level, startDate, endDate, attributionModel: 'LAST_CLICK' }`
  with `startDate` 89 days before `endDate` (account level caps history at
  90 days). The tool's default model is `FIRST_CLICK`; send `LAST_CLICK` so
  the curve speaks the Report's default model. Account level has no LTV and
  rejects `ltvWindow`, so its ceiling is a caller `cacCeiling` or none
  (without one the only saturation it reports is spend that buys no extra
  customers); ad sets get HYROS's LTV break-even ceiling (`ceilingBasis`
  says which).
- The curve is computed live from 90 days of spend and often needs more than
  15 s: use `TIMEOUTS.slow`.
- Response (`result` may wrap it): `curve: [{ spendPerDay, days, newCustomers, avgCac, marginalCac }]`
  sorted by spend, `saturationPoint: { efficientSpendPerDay, saturatedSpendPerDay, reason } | null`,
  `cacCeiling`, `ceilingBasis: CALLER_PROVIDED | LTV_BREAKEVEN`, `daysSampled`,
  `notes: [NO_SPEND_DATA | NO_CUSTOMERS | INSUFFICIENT_DATA | LTV_CEILING_UNAVAILABLE]`.
- Render the curve as inline SVG with markers for the efficient and saturated
  spend and a line for the ceiling; a thin curve (few spend levels, levels
  with no customers) deserves a warning even when `notes` is empty.

## Health (tracking health)

Three independent checks (and a fourth that confirms the third), cheapest first, so a slow answer never starves the
others. Each check records `{ status: 'ok' | 'empty' | 'skipped' | 'failed', reason?, ms? }`
and the tile says it ("skipped: time budget", "HYROS did not answer").
Neither tool has a documented argument or reply shape: read replies
tolerantly, and treat a reply you cannot read as a failed check, not as an
empty result. `src/views/health/` is this recipe built.

1. Domains: `hyros_get_domains` takes no arguments (call it with `{}`) and
   answers the account's verified tracking domains as a bare list of
   strings (read `result` / `domains` and `{ domain | name | url }` too, in
   case the shape changes). Keep at most 20.
2. Google tracking parameters, only when an ad account of type `GOOGLE` or
   `GOOGLE_V2` exists: `hyros_check_tracking_parameters_for_integrations`
   with `{ request: { type } }` for `SEARCH` and `PERFORMANCE_MAX`. Rows come
   under `result` or `ads`, or as a bare array; keep at most 50.
3. Script presence, last: the verified domains are tracking domains (the
   CNAME a customer points at HYROS, `data.shop.com`); the script lives on
   the site itself. Reduce each one to its registrable domain (keep
   `co.uk`-style suffixes) and check `https://<apex>/` and
   `https://www.<apex>/`, apex and www together so a cap never leaves half a
   site out, at most 12 URLs. `hyros_assert_script_presence_on_domain`
   takes `{ request: { domains: [url, ...] } }` with **at most 3 URLs per
   call** and answers a map `url -> SUCCESSFUL | SCRIPT_DETECTED |
   SCRIPT_NOT_FOUND | DOMAIN_NOT_FOUND | TIMEOUT_ERROR | UNKNOWN_ERROR`.
   `SUCCESSFUL` and `SCRIPT_DETECTED` mean the script is there,
   `SCRIPT_NOT_FOUND` is the only answer that means it is missing, and the
   other three are inconclusive ("couldn't check"). It fetches every page
   live: use `TIMEOUTS.slow`, and skip it rather than start it with little
   time left.
4. Visits cross-check, only when some URL did not answer `SUCCESSFUL` or
   `SCRIPT_DETECTED`: the check reads the raw page, so a script a site
   builder injects at runtime is reported missing on sites HYROS is
   tracking. Recent clicks are the proof a site is tracked: take the ids of
   the 50 newest leads (`hyros_get_leads` with `{ request: { pageSize: 50 } }`
   answers newest by join date), call `hyros_get_lead_clicks` with
   `{ request: { leadIds, fromDate, pageSize: 250 } }` for the last 7 days,
   at most 4 pages, and collect the hosts of `page` (without `www.`). A host
   with visits is tracked whatever the script check said.
