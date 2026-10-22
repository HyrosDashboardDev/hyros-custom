# Recipes

How to build a view on this dashboard. Every view runs in the browser and
reaches HYROS only through `ctx.data`: it loads what it shows when it
renders, straight from the HYROS API (`/api/v1.0`), with the token the
shell holds. Each recipe below says which paths to call, with which query
parameters, and how to turn the answers into rows. The official reference
for every path is https://api-docs.hyros.com; when this file and the docs
disagree, the docs win.

## Every recipe

- Call paths through `ctx.data.call(path, params, opts)` (one GET, the body
  as the API sends it: usually `{ result, nextPageId?, message? }`),
  `ctx.data.paged(...)` or `ctx.data.pagedInfo(...)`
  (walk `pageId`, `pageSize` and `maxPages` in the options). `pagedInfo`
  answers `{ rows, pages, truncated, error? }`: when `truncated` is true the
  list hit the page cap, the time budget or an expired cursor, so say
  "showing newest N rows" instead of presenting the table as complete. With
  `call`, send `pageSize` yourself.
- Only paths in `READ_PATHS` (`src/core/api.js`) can be called; anything
  else fails with `not_allowed` before a request is made.
- Parameters are flat (`{ fromDate, emails }`), sent in the query string. An
  array goes as one comma-separated parameter; `null` and `undefined` are
  left out. Enum casing is per path and matched exactly: `/attribution`
  takes lowercase names (`facebook_adset`, `last_click`, `all_sources`),
  `/sales`, `/subscriptions` and the aggregations take uppercase ones
  (`RECURRING`, `ACTIVE`, `FIRST_SOURCE_TAG`). Copy them from the recipe.
  A 200 that carries only `message` and no `result` is thrown as an error.
- The rate limit is per account and endpoint: 30 requests per second and
  1,000 per minute by default, shared by every dashboard page open on the
  account (the account's API keys have their own). Run calls for
  one account in sequence, or a few at a time; parallel fan-out trades rows
  for 429s.
- Array filters (`ids`, `emails`, `tags`, `leadIds`, `stages`) take at most
  50 items; `pageSize` is 1 to 250; `/leads/journey` takes at most 50 leads
  per call.
- A view loads what it shows when it renders. Anything slow needs its own
  partial states, and one failing call should become a warning in the view,
  never a blank page.
- `src/core/dates.js`: `parseTimezone`, `ymdInTz`, `dayStart`, `dayEnd`,
  `parseHyrosDate`, `addDays`, `offsetSuffix`. The account timezone is
  `ctx.data.account().timezone`: the offset HYROS applies today to dates
  sent without one, read from the newest lead's date (`"-04:00"`); without a
  lead it is `userProfile.timezone` as HYROS stores it (`"-05:00"`, `"UTC"`,
  `"America/New_York"`), which ignores daylight saving.
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
write `SPEC.md` first, add the id to `CUSTOM_VIEWS` in `src/views/custom.js`. The id
starts with `custom-` (in the template itself: no prefix, and the id goes to
`TEMPLATE_VIEWS` in `src/views/registry.js`). The contract
(the `view` object, `ctx`, the shared markup kit, `SPEC.md`) is `VIEWS.md`;
`npm run check` verifies it. `src/views/account/` is the worked example.

## Report (Performance Report)

One GET `/attribution` call per ad account, per level, per date range,
then rollups in the browser. The HYROS report screen's Campaign, Traffic
and Account tabs are not report levels: they are built by joining ad-set
rows to GET `/sources` and grouping. `src/views/report/` is this recipe
built (its `SPEC.md` has the cache keys other tabs can read).

### 1. Date ranges

Ranges are `YYYY-MM-DD` in the account timezone:

| Key | Start | End |
|---|---|---|
| `today` | `ymdInTz(now, tz)` | same |
| `yesterday` | `addDays(today, -1)` | same |
| `7d` | `addDays(today, -6)` | today |
| `30d` | `addDays(today, -29)` | today |

The request takes `startDate: dayStart(range.start, tz)` and
`endDate: dayEnd(range.end, tz, now)` (`2026-09-15T00:00:00-05:00`: no
milliseconds, the API's date pattern refuses them). The report rejects any
date after the current time, so "today" ends now, not at 23:59:59.

### 2. Levels per ad account type

`ctx.data.adAccounts()` gives `{ id, name, type }`. The `level` each type
takes, in the API's lowercase spelling (matched exactly: `FACEBOOK_ADSET`
is refused):

| Ad account `type` | ad-set level | ad level |
|---|---|---|
| `FACEBOOK` | `facebook_adset` | `facebook_ad` |
| `GOOGLE` (classic) | `google_campaign` | `google_ad` |
| `GOOGLE_V2` | `google_v2_adgroup` | `google_v2_ad` |
| `TIKTOK` | `tiktok_adgroup` | `tiktok_ad` |
| `SNAPCHAT` | `snapchat_adsquad` | `snapchat_ad` |
| `PINTEREST` | `pinterest_adgroup` | `pinterest_ad` |
| `TWITTER` | `twitter_adgroup` | `twitter_ad` |
| `BING` | `bing_adgroup` | `bing_ad` |
| `LINKEDIN` | `linkedin_campaign` | `linkedin_ad` |

An ad row's `parent_id` is the id of its ad set, the id the ad-set level and
GET `/sources` use. Classic `GOOGLE` and `LINKEDIN` have no ad set: their
ad-set column is the campaign, so their ads hang from the campaign.

Any other type (`REDDIT`, `APPLOVIN`, `WHOP_ADS`, ...) has no attribution
level: skip it with a warning. "Accepted" is not "supported": classic
`GOOGLE` rejects `google_adgroup`, so stay with the table. Snapchat's ad
set is `snapchat_adsquad`; `snapchat_adset` is refused.

### 3. The call

```js
const page = await ctx.data.pagedInfo('/attribution', {
  attributionModel: 'last_click',          // or first_click, scientific (lowercase, exact)
  startDate: dayStart(range.start, tz),
  endDate: dayEnd(range.end, tz, now),
  level,                                   // from the table above
  ids: [adAccountId],                      // exactly one with isAdAccountId
  isAdAccountId: true,
  timeGroupingOption: 'source_link',       // the only grouping an ad-account id allows
  newestFirst: true,                       // oldest-first fills the page with ads that no longer run
  sourceConfiguration: 'all_sources',      // how the report screens attribute; see below
  reportSourceVisibility: true,            // leave deleted source links out, like the report screens
  fields: REPORT_FIELDS,                   // every metric you will show; unrequested ones are left out
  // windowAttributionDaysRange: 7,        // LAST_CLICK only, 1 to 365
  // lead_stage: ['Customer'],             // must match account stage names, see ctx.data.stages()
}, { maxPages: 8, pageSize: 250, deadline, timeoutMs: clampTimeout(TIMEOUTS.default, deadline) });
```

The params are flat in the query string; `fields` and `ids` go as one
comma-separated value each. `attributionModel`, `level` and `fields` are
matched exactly in lowercase; a wrong spelling is a 400. `sourceConfiguration`
is not checked: `all_sources` (or `include_organic`) attributes like the
report screens, and anything else, `ALL_SOURCES` included, silently becomes
`ignore_organic`. `timeGroupingOption` is read in any case. Send no parameter
outside the documented list: the endpoint checks for unknown ones and can
answer 400.

Run the calls in sequence, and give the render a deadline
(`start + VIEW_LOAD_MS - 15000`): an account with many ad accounts needs one
call per ad account, so the last ones may not fit; list them as skipped
instead of failing the view. 8 pages are the newest 2,000 sources of an ad
account; say so when `truncated` is true. One ad account failing
(unsupported level, disconnected integration, a 200 with only `message`)
becomes a warning for that account, never a failed view. Rows carry `id`,
`name`, `parent_id`, `parent_name` and the metrics, but no category or
traffic source: stamp the ad account id of the call on each row
(`_account`) and get the rest from the join (step 6).

### 4. Normalize a row

The API publishes row keys in snake_case (its `camelToSnakeCaseWithNumber`:
`total_revenue`, `cost_per_lead`, `new_m_r_r`, `ltv_30_days`), except
`contributionProfit`, published as declared. `revenue` is a string
(`"997.00"`); every other metric is a number. `normalizeRow` in
`src/data/report-levels.js` reads them once, so everything after it uses the
camelCase catalog keys:

- `id` as a string, `name`, `parentName` (from `parent_name`), and
  `parentId` (from `parent_id`: ad-level rows carry the id of their ad set;
  it is what links ads to ad sets).
- Each catalog metric from `wireKey(k)` (the "Response key" column of the
  catalog), as a number. Drop nulls: a requested metric with no value comes
  back as `null`, which means not computed. `reported` comes from
  `reported_result`.
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
ctx.data.pagedInfo('/sources', {
  adSourceIds: ids,                           // at most 50 ad-set row ids
  includeOrganic: true, includeDisregarded: true,
}, { maxPages: 2, pageSize: 250, deadline, timeoutMs });
```

Both flags default to true on the API; send them anyway so the join never
depends on that default. A row's `id` matches the source's
`adSource.adSourceId`. The source gives `name` (ad-set rows sometimes come
back unnamed), `tag`, `category.name` and `trafficSource.name`. An ad row
joins through its `parentId` (the ad set). `buildLevels` in
`src/data/report-levels.js` does the grouping:

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

`fields` value to request, the key the API publishes it under, and the row
key after `normalizeRow` (`CATALOG` in `src/data/metrics.js`: `f` and `k`;
`wireKey(k)` gives the response key). Rollup: `sum` is added on rollup,
`derive` is recomputed from the sums, `none` is native rows only. Always
request `name` and `parent_name` too.

| Group | `fields` value | Response key | Row key | Type | Rollup |
|---|---|---|---|---|---|
| Core | `clicks` | `clicks` | `clicks` | int | sum |
| Core | `cost` | `cost` | `cost` | money | sum |
| Core | `total_revenue` | `total_revenue` | `totalRevenue` | money | sum |
| Core | `revenue` | `revenue` | `revenue` | money | sum |
| Core | `profit` | `profit` | `profit` | money | derive |
| Core | `reported_result` | `reported_result` | `reported` | money | sum |
| Core | `reported_vs_revenue` | `reported_vs_revenue` | `reportedVsRevenue` | money | derive |
| Core | `shop_reported_result` | `shop_reported_result` | `shopReportedResult` | money | sum |
| Core | `sales` | `sales` | `sales` | int | sum |
| Core | `unique_sales` | `unique_sales` | `uniqueSales` | int | sum |
| Core | `roi` | `roi` | `roi` | pct | derive |
| Core | `roas` | `roas` | `roas` | ratio | derive |
| Core | `leads` | `leads` | `leads` | int | sum |
| Core | `new_leads` | `new_leads` | `newLeads` | int | sum |
| Core | `leads_optins` | `leads_optins` | `leadsOptins` | int | sum |
| Core | `impressions` | `impressions` | `impressions` | int | sum |
| Core | `ctr` | `ctr` | `ctr` | pct | derive |
| Core | `cpm` | `cpm` | `cpm` | money | derive |
| Core | `cvr` | `cvr` | `cvr` | pct | derive |
| Core | `new_visits` | `new_visits` | `newVisits` | int | sum |
| Core | `partial_video_views` | `partial_video_views` | `partialVideoViews` | int | sum |
| Cost per | `cost_per_click` | `cost_per_click` | `costPerClick` | money | derive |
| Cost per | `cost_per_lead` | `cost_per_lead` | `costPerLead` | money | derive |
| Cost per | `cost_per_new_lead` | `cost_per_new_lead` | `costPerNewLead` | money | derive |
| Cost per | `cost_per_sale` | `cost_per_sale` | `costPerSale` | money | derive |
| Cost per | `cost_per_unique_sale` | `cost_per_unique_sales` | `costPerUniqueSales` | money | derive |
| Cost per | `cost_per_call` | `cost_per_call` | `costPerCall` | money | derive |
| Cost per | `cost_per_qualified_call` | `cost_per_qualified_call` | `costPerQualifiedCall` | money | derive |
| Cost per | `cost_per_unique_call` | `cost_per_unique_call` | `costPerUniqueCall` | money | derive |
| Cost per | `cost_per_new_visit` | `cost_per_new_visit` | `costPerNewVisit` | money | derive |
| Cost per | `cost_per_unique_customer` | `cost_per_unique_customer` | `costPerUniqueCustomer` | money | derive |
| Cost per | `cost_per_new_subscriptions` | `cost_per_new_subscriptions` | `costPerNewSubscriptions` | money | derive |
| Cost per | `cost_per_new_trials` | `cost_per_new_trials` | `costPerNewTrials` | money | derive |
| Cost per | `cost_per_atc` | `cost_per_atc` | `costPerAtc` | money | derive |
| Cost per | `cac` | `cac` | `cac` | money | none |
| Calls | `calls` | `calls` | `calls` | int | sum |
| Calls | `qualified_calls` | `qualified_calls` | `qualifiedCalls` | int | sum |
| Calls | `unqualified_calls` | `unqualified_calls` | `unqualifiedCalls` | int | sum |
| Calls | `unique_calls` | `unique_calls` | `uniqueCalls` | int | sum |
| Calls | `canceled_calls` | `canceled_calls` | `canceledCalls` | int | sum |
| Calls | `no_show_calls` | `no_show_calls` | `noShowCalls` | int | sum |
| Customers | `customers` | `customers` | `customers` | int | sum |
| Customers | `unique_customers` | `unique_customers` | `uniqueCustomers` | int | sum |
| Customers | `total_customers` | `total_customers` | `totalCustomers` | int | sum |
| Customers | `recurring_customers` | `recurring_customers` | `recurringCustomers` | int | sum |
| Customers | `returning_customers` | `returning_customers` | `returningCustomers` | int | sum |
| Customers | `new_customers_orders` | `new_customers_orders` | `newCustomersOrders` | int | sum |
| Customers | `unique_customers_revenue` | `unique_customers_revenue` | `uniqueCustomersRevenue` | money | sum |
| Customers | `returning_customers_revenue` | `returning_customers_revenue` | `returningCustomersRevenue` | money | sum |
| Customers | `aov` | `average_order_value` | `averageOrderValue` | money | derive |
| Customers | `new_customers_percentage` | `new_customers_percentage` | `newCustomersPercentage` | pct | none |
| Customers | `recurring_customers_percentage` | `recurring_customers_percentage` | `recurringCustomersPercentage` | pct | none |
| Customers | `returning_customers_rate` | `returning_customers_rate` | `returningCustomersRate` | pct | none |
| Customers | `returning_customers_revenue_rate` | `returning_customers_revenue_rate` | `returningCustomersRevenueRate` | pct | none |
| Customers | `new_customers_roas` | `new_customers_roas` | `newCustomersRoas` | ratio | none |
| Customers | `new_customers_aov` | `new_customers_aov` | `newCustomersAov` | money | none |
| Revenue detail | `recurring_revenue` | `recurring_revenue` | `recurringRevenue` | money | sum |
| Revenue detail | `one_time_sales` | `one_time_sales` | `oneTimeSales` | int | sum |
| Revenue detail | `refund` | `refund` | `refund` | money | sum |
| Revenue detail | `refund_count` | `refund_count` | `refundCount` | int | sum |
| Revenue detail | `refunded_sales_percentage` | `refunded_sales_percentage` | `refundedSalesPercentage` | pct | derive |
| Revenue detail | `refunded_revenue_percentage` | `refunded_revenue_percentage` | `refundedRevenuePercentage` | pct | derive |
| Revenue detail | `hard_costs` | `hard_costs` | `hardCosts` | money | sum |
| Revenue detail | `taxes` | `taxes` | `taxes` | money | sum |
| Revenue detail | `cost_of_goods` | `cost_of_goods` | `costOfGoods` | money | sum |
| Revenue detail | `shipping_value` | `shipping_value` | `shippingValue` | money | sum |
| Revenue detail | `net_profit` | `net_profit` | `netProfit` | money | none |
| Revenue detail | `net_profit_percentage` | `net_profit_percentage` | `netProfitPercentage` | pct | none |
| Revenue detail | `gross_margins` | `gross_margins` | `grossMargins` | pct | none |
| Revenue detail | `contribution_profit` | `contributionProfit` | `contributionProfit` | money | none |
| Revenue detail | `contribution_margin` | `contribution_margin` | `contributionMargin` | pct | none |
| Subscriptions | `new_subscriptions` | `new_subscriptions` | `newSubscriptions` | int | sum |
| Subscriptions | `canceled_subscriptions` | `canceled_subscriptions` | `canceledSubscriptions` | int | sum |
| Subscriptions | `direct_subscriptions` | `direct_subscriptions` | `directSubscriptions` | int | sum |
| Subscriptions | `mrr` | `mrr` | `mrr` | money | sum |
| Subscriptions | `new_mrr` | `new_m_r_r` | `newMRR` | money | sum |
| Subscriptions | `arr` | `arr` | `arr` | money | sum |
| Subscriptions | `churn_rate` | `churn_rate` | `churnRate` | pct | none |
| Subscriptions | `new_trials` | `new_trials` | `newTrials` | int | sum |
| Subscriptions | `converted_trials` | `converted_trials` | `convertedTrials` | int | sum |
| Subscriptions | `canceled_trials` | `canceled_trials` | `canceledTrials` | int | sum |
| Forecasts | `subscription_30_days_forecast` | `subscription_30_days_forecast` | `subscription30DaysForecast` | money | none |
| Forecasts | `subscription_60_days_forecast` | `subscription_60_days_forecast` | `subscription60DaysForecast` | money | none |
| Forecasts | `subscription_90_days_forecast` | `subscription_90_days_forecast` | `subscription90DaysForecast` | money | none |
| Forecasts | `subscription_6_months_forecast` | `subscription_6_months_forecast` | `subscription6MonthsForecast` | money | none |
| Forecasts | `subscription_1_year_forecast` | `subscription_1_year_forecast` | `subscription1YearForecast` | money | none |
| Ecom | `carts` | `carts` | `carts` | int | sum |
| Ecom | `atc_events` | `atc_events` | `atcEvents` | int | sum |
| Ecom | `purchased_carts` | `purchased_carts` | `purchasedCarts` | int | sum |
| Ecom | `atc_cvr` | `atc_cvr` | `atcCvr` | pct | derive |
| Ecom | `atc_rate` | `atc_rate` | `atcRate` | pct | none |
| Attribution | `time_of_sale_attribution` | `time_of_conversion_attribution_avg` | `timeOfConversionAttributionAvg` | ratio | none |
| Attribution | `time_of_call_attribution` | `time_of_call_attribution_avg` | `timeOfCallAttributionAvg` | ratio | none |

Leave the LTV fields (`30_days_ltv` ... `1_year_ltv`, and their `_forecast`
forms) out: HYROS returns 0 for every one of them today (HMCP-359), and on
an account without forecasting metrics the API answers 400 to any of them.
The `fields` list drives computation, so request every metric the view may
show and add columns client side.

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
const page = await ctx.data.pagedInfo('/leads',
  { fromDate, toDate, ...filters },
  { maxPages: 8, pageSize: 250, deadline, timeoutMs: clampTimeout(TIMEOUTS.default, deadline) });
```

The lists come newest first, so a `truncated` list is "showing newest
2,000". Filter on the server, with the endpoint's own parameters: `emails`
(prefixes), `stage` (singular, the current stage names) and `tags` on
`/leads`, `isRecurringSale` and `saleRefundedState` on `/sales`
(`RECURRING | NON_RECURRING | ALL`, `REFUNDED | NON_REFUNDED | ALL`, exact),
`qualified` (`true`/`false`) and `qualificationStages` on `/calls`,
`subscriptionStates` (upper case) on `/subscriptions`. `/sales` and `/calls`
filter by lead with `leadIds`; `/leads` has no `leadIds`, its lead ids go
in `ids`. These endpoints answer 400 to a parameter they do not know, so
send only theirs. Leads have no parameter for "has a source": filter that
on the loaded rows and say it applies to them.

Counts for the tiles come from the aggregation endpoints, not from the
loaded rows, so they hold when the list is cut short. Send them the same
range and filters as the list, with `ctx.data.call` (no paging: an
aggregation answers 400 to `pageSize` or `pageId`, to any parameter its
list does not take, and to a repeated one):

| Path | `attribute` | What it answers |
|---|---|---|
| `/leads/aggregation` | `STAGE` | `totalCount` = leads in the range; the `Customer` group |
| `/leads/aggregation` | `FIRST_SOURCE_TAG` | leads with a first source = sum of `groups[].count` + `remainingCount` |
| `/sales/aggregation` | `FIRST_SOURCE_TAG` | `totalCount` = sales; `groups[].details.revenue` is USD (HYROS stable price) and covers sales with a first source only |
| `/calls/aggregation` | `CALL_QUALIFICATION` | `totalCount` = calls; the groups are qualification stage names, which do not say which one counts as qualified: ask again with `qualified: true` for that tile |

Each answers `{ result: { groups: [{ key, count, details? }], remainingCount, totalCount } }`.
The groups are not a total: a lead without the attribute is in no group,
and with `TAG` a lead is in one group per tag. Pass `groupsLimit: 1000`
(the cap; the default is 250). There is no aggregation for subscriptions;
count the loaded rows and mark the tile "+" when the list was cut.

Dates: lead dates and every source `clickDate` are ISO in the account
timezone (`2026-09-01T10:00:00-05:00`). Sale and call
`creationDate`, `refundDate` and the subscription dates come in the legacy
Java form `EEE MMM dd HH:mm:ss zzz yyyy` (`Wed May 01 13:00:00 UTC 2024`).
Read every date with `parseHyrosDate(value, offsetSuffix(tz))`, which takes
both, and sort on `Date.parse` of its answer.

Money on a sale or subscription: the `price` object (`price.price`,
`price.currency`) is in the account currency and wins; the undocumented
`usdPrice` is a USD conversion, use it only when `price` is missing. A
mixed-currency account sums face values. Each price object also carries
`refunded`, the refunded amount (full or partial): a total of sales subtracts
it, because HYROS revenue is the price minus the refunded amount.

What to keep from each row:

| List | Fields |
|---|---|
| Lead | `id`, `email`, name (`firstName` + `lastName`), `joined` = `creationDate`, `updated` = `lastUpdatedDate`, `stage` = `currentStage.name`, `stageDate` = `currentStage.date`, `consent` = `adOptimizationConsent`, `tags`, `phoneNumbers`, `firstSource` and `lastSource` flattened to `{ name, tag, organic, trafficSource.name, category.name, clickDate }`, `hasAttribution` = either source present. A lead with `originLead` was merged into another: drop it |
| Sale | `id`, `lead.email`, lead name, `date` = `creationDate`, amount and currency, `product.name`, `recurring`, refunded = `refundDate` present, `firstSource.name`, `lastSource.name` |
| Call | `id`, `lead.email`, lead name, `date` = `creationDate`, `name` or `tag`, `state` (else `QUALIFIED` / `UNQUALIFIED` from `qualified`), the ad = `firstSource.sourceLinkAd.name` or `lastSource.sourceLinkAd.name`. Calls carry full attribution on the call itself, richer than the lead row |
| Subscription | `id` or `subscriptionId`, `lead.email`, `date` = `startDate` or `creationDate`, `endDate`, `name` or `planId`, price, `periodicity`, `status`, `provider.integration.name` |

Income per lead: the lead object has no revenue field. Show it where one
lead is open (the Drill journey sums its sales in the account currency, net of refunds)
rather than joining every sale of the window to every lead.
`ctx.data.stages()` gives the stage names for the stage filter.

## Drill

`src/ui/drill.js` implements this recipe (`openCohortDrill`,
`openLeadJourney`); a view calls it instead of repeating the steps.

The click-through behind a number. Sources carry a `tag`; a rolled-up
row carries the union of its members' tags (Report step 6).

- Credited (Last click, First click): the source a model credits is the one
  stored on the sale, call or lead as its last or first source (with every
  source included, `sourceConfiguration: 'ALL_SOURCES'`). Sales and calls:
  `ctx.data.pagedInfo('/sales' | '/calls', { lastSourceTags | firstSourceTags, fromDate, toDate })`
  (the report's range), the row's tags with the clicked column above 0 in
  batches of 50 (the filter's cap), in sequence, at most 40 pages of 250 per
  batch. List refunded sales but leave them out of the count and the total,
  as the report's Sales and Revenue do. Say in the panel what was matched and
  that the attribution window is not applied.
- Credited (Scientific): Scientific gives the whole sale to its first source
  when it came within 30 days of the first click (`scientificDaysRange`,
  which the Report never sends, so HYROS uses its default of 30), and to its
  last source otherwise. Run both filters over the row's tags and keep a
  record from `firstSourceTags` when its `creationDate` is at most 30 days
  after its `firstSource.clickDate`, and one from `lastSourceTags` when it is
  later; keep each record once, by `id`.
- Leads, under every model: `ctx.data.pagedInfo('/leads', { tags, fromDate, toDate }, { pageSize: 250, maxPages: 8 })`,
  the leads that joined in the range and touched the row's sources. The last
  source stored on a lead moves with its later clicks, so filtering on it
  does not give the cell; say in the panel that the list is the touched
  leads, not the credited count, and when more pages exist, that older leads
  were not read.
- Touched (a model with no credited rule): the cohort is
  `ctx.data.pagedInfo('/leads', { tags }, { pageSize: 250, maxPages: 8 })`,
  the leads that touched those sources, newest first, which is not the
  attribution-credited count in the cell; say so in the panel. The cohort has
  no date filter: a source tag only records the lead's first touch of that
  source. Its sales or calls: the cohort's lead ids on `/sales` / `/calls`
  with `{ leadIds, fromDate, toDate }` in batches of 50 (the filter's cap),
  in sequence, at most 4 pages of 250 per batch. When the cohort has more
  than 8 pages, say that older leads were not queried, also in the empty
  state. A drill stops starting calls after 60 seconds and says so.
- The `tags` filter of `/leads` is OR and takes at most 50 tags: a rolled-up
  row sends the tags of its members with the clicked column above 0, the
  biggest first, and when some are left out the panel says "first N of M
  sources" instead of showing a bare 0. A tag holding a comma cannot be sent
  on any of these filters (the array goes as one comma-separated value), so
  it counts as left out.
- One lead: `ctx.data.call('/leads/journey', { emails: [email], includeEvents: true })`
  gives `result: [{ lead, sales, calls, carts, subscriptions, linkedLeads, journey: [{ type, date, name, keyword, extra, subNames }] }]`
  (no paging; `ids` instead of `emails` must be the leads' SHA-256 ids).
  `ctx.data.pagedInfo('/leads/clicks', { emails: [email], fromDate }, { pageSize: 250, maxPages: 2 })`
  (`fromDate` a year back) gives rows
  `{ date, page | trackedUrl, previousUrl, sourceLinkName, adspendType }`;
  when more pages exist the count reads "N+ tracked clicks, list cut short".
  `/leads/clicks` takes exactly one of `leadId`, `email` (deprecated),
  `leadIds` or `emails`; two of them is a 400. Journey event dates are ISO;
  sale, call and click dates are the legacy form (CRM "Dates"). The clicks
  call is best effort: a failure must not blank the journey.
- Open the drill as a panel inside the view. No modals.

## Scale (marginal CAC)

One GET `/attribution/marginal-cac-curve` call per target, in sequence,
each one independent: a curve that errors is stored with its message so the
tab can say why it is empty. `src/views/scale/` is this recipe built.

- Targets: the ad accounts the user picks at `level: 'account'`, plus the
  top 6 ad sets by 30-day cost at `level: 'source_link'`. Ranking ad sets
  needs the Report's 30-day ad-set rows: read them with
  `ctx.data.peek('report:LAST_CLICK:0:<start>:<end>:adset')` (it never loads
  anything) and leave the ad sets out when they are not there.
- Request: `ctx.data.call('/attribution/marginal-cac-curve', { id, level, startDate, endDate, attributionModel: 'last_click' }, { timeoutMs })`
  with `startDate` 89 days before `endDate`, both `YYYY-MM-DD` (account
  level caps history at 90 days). The endpoint is strict: a parameter other
  than `id`, `level`, `startDate`, `endDate`, `ltvWindow`, `cacCeiling`,
  `attributionModel`, or a repeated one, is a 400. `level` (`ad`,
  `source_link`, `campaign`, `account`) and `attributionModel`
  (`first_click`, `last_click`) are read in any case. The default model is
  `first_click`; send `last_click` so the curve speaks the Report's default
  model. Account level has no LTV and rejects `ltvWindow`, so its ceiling is
  a caller `cacCeiling` or none (without one the only saturation it reports
  is spend that buys no extra customers); ad sets get HYROS's LTV break-even
  ceiling (`ceilingBasis` says which).
- The curve is computed live from 90 days of spend and often needs more than
  15 s: use `TIMEOUTS.slow`.
- Response, inside `{ request_id, result }`: `curve: [{ spendPerDay, days, newCustomers, avgCac, marginalCac }]`
  sorted by spend, `saturationPoint: { efficientSpendPerDay, saturatedSpendPerDay, reason } | null`,
  `cacCeiling`, `ceilingBasis: CALLER_PROVIDED | LTV_BREAKEVEN`, `daysSampled`,
  `notes: [NO_SPEND_DATA | NO_CUSTOMERS | INSUFFICIENT_DATA | LTV_CEILING_UNAVAILABLE]`.
  A 200 with only `message` (no data to build a curve) is thrown as an
  error by `ctx.data.call`.
- Render the curve as inline SVG with markers for the efficient and saturated
  spend and a line for the ceiling; a thin curve (few spend levels, levels
  with no customers) deserves a warning even when `notes` is empty.
