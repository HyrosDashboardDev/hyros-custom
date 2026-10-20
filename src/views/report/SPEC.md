# Performance Report: view spec

**id** `report` · **version** 0.1.0 · **tools** `/user-info`, `/ad-accounts`, `/attribution`, `/sources`

## Purpose
The HYROS Performance Report inside the dashboard: cost, attributed revenue,
profit, ROAS, sales, leads and calls per traffic source, ad account, campaign
(HYROS source category), ad set and ad, for a date range, an attribution model
and an attribution window. A media buyer reads it to see what each piece of
spend earned, opens a number to see the leads behind it, and walks the
hierarchy (Traffic or Account, then Campaign, Ad set, Ad) by clicking names.

## Data
All calls run in sequence (one rate limit per HYROS account). One render:

1. `ctx.data.account()` (cached getter): `timezone` for the range.
2. `ctx.data.adAccounts()` (cached getter): `{ rows: [{ id, name, type }], truncated }`.
   Each type maps to a level with `LEVELS_BY_TYPE` (`src/data/report-levels.js`).
   Types with no level (`REDDIT`, `APPLOVIN`, `WHOP_ADS`, ...) are listed in a note
   and never called. On the Ad tab, types with `ad: null` (`GOOGLE_V2`, `TWITTER`,
   `LINKEDIN`) are listed in a note too.
3. For each supported and selected ad account, one paged call per level the tab
   needs: the ad-set level for Traffic, Account, Campaign and Ad set (one load
   serves the four tabs, switching between them costs nothing), the ad level only
   for the Ad tab.

   ```js
   ctx.data.pagedInfo('/attribution', {
     attributionModel,                       // last_click | first_click | scientific
     startDate: dayStart(start, tz), endDate: dayEnd(end, tz, now),
     level,                                  // LEVELS_BY_TYPE[type].adset or .ad, e.g. facebook_adset
     ids: [adAccountId], isAdAccountId: true, timeGroupingOption: 'source_link',
     newestFirst: true, sourceConfiguration: 'all_sources', reportSourceVisibility: true,
     fields: REPORT_FIELDS,                  // name, parent_name, then every catalog `f` not switched off
     // windowAttributionDaysRange: window   only when window > 0 and the model is LAST_CLICK
   }, { maxPages: 8, pageSize: 250, deadline, timeoutMs: clampTimeout(TIMEOUTS.default, deadline) })
   ```

   GET `/api/v1.0/attribution` with the params flat in the query (arrays as one
   comma-separated value). `level`, `attributionModel`, `fields` and
   `sourceConfiguration` are the API's lowercase names, matched exactly; any
   other spelling of `sourceConfiguration` silently falls back to
   `ignore_organic`. The view keeps the model as `LAST_CLICK`, `FIRST_CLICK`,
   `SCIENTIFIC` in its state and cache keys and sends `MODELS[].api`.

   Rows come back snake_case (`total_revenue`, `parent_id`, `reported_result`,
   `new_m_r_r`, `ltv_30_days`; `contributionProfit` as declared) with `revenue`
   as a string (`"997.00"`). `normalizeRow` reads each catalog metric from
   `wireKey(k)`, coerces it to a number (null stays "not computed" and is
   dropped) and returns the camelCase catalog keys, so the rest of the view
   never sees the wire spelling. Every row then gets `_account = adAccountId`
   from the call (not from the source join).
4. Source join, by id, only for the ids the render needs: the ad-set row ids
   (ad-set load) or the `parentId` of the ad rows (Ad tab), minus the ids already
   in the module memo. Batches of 50 (the `adSourceIds` cap), in sequence:

   ```js
   ctx.data.pagedInfo('/sources', {
     adSourceIds: [...up to 50], includeOrganic: true, includeDisregarded: true,
   }, { maxPages: 2, pageSize: 250, deadline, timeoutMs: clampTimeout(TIMEOUTS.default, deadline) })
   ```

   Both flags default to true on the API; they are sent anyway so the join
   never depends on that default.

   The memo is a module-level `Map` keyed by `String(source.adSource.adSourceId)`
   with `{ name, tag, category: category.name, trafficSource: trafficSource.name,
   adAccountId }`; an id asked for and not returned is memoised as `null` so it is
   not asked again. It lives for the life of the page (Refresh does not clear it;
   source metadata is not part of the report numbers). A failed batch is not
   memoised.
5. `buildLevels({ adsetRows, adRows: [], sourceById, adAccountName })` builds
   Traffic, Account, Campaign and Ad set. Ad rows are enriched from their parent's
   memo entry (`tag`, category, traffic source) without loading the ad-set level:
   the Ad tab costs the ad-level calls plus the join of the parent ids, never the
   ad-set calls.

Worst case (66 ad accounts, 30 days, ad-set tabs): about 65 report calls plus
36 join batches, about 101 calls in sequence. A render has a deadline of
`start + VIEW_LOAD_MS - 15 s` (105 s): no call starts after it, and whatever was
not loaded is listed as skipped. The next render (any control change) loads only
what is missing.

### Caching (and the contract with the Scale tab)
- Per ad account: `ctx.data.cached('report:<model>:<window>:<start>:<end>:<adset|ad>:acct:<adAccountId>', loader)`.
  A load cut by the time budget throws inside the loader, so it is never cached
  and the next render retries it. A failed load is dropped the same way.
- Whole load: when every supported ad account has a complete per-account entry
  (no failure, no time-budget cut), the view stores
  `ctx.data.cached('report:<model>:<window>:<start>:<end>:adset', async () => ({ adsetRows, accounts, capped }))`
  (`:ad` and `{ adRows, accounts, capped }` for the Ad tab). `<window>` is `0` when
  `windowAttributionDaysRange` is not sent (window 0, or a model other than
  LAST_CLICK); `<start>` and `<end>` are `YYYY-MM-DD`. `adsetRows` are the
  normalised rows, each with `id`, `cost` and `_account`. `capped` lists the ad
  accounts whose list hit `maxPages` (newest 2,000 rows).
- The ad-account filter never changes a key: the whole-load key always means
  "every supported ad account". A partial selection loads (or reuses) only the
  per-account entries it needs; when those plus the earlier ones cover every
  supported ad account, the whole-load key is stored too. At the start of a
  render `ctx.data.peek(<whole-load key>)` is read first and, when present, no
  call is made at all.
- Refresh (`ctx.data.invalidate()`) clears every key; the source memo stays.

## Rows shape
```json
{
  "adsetRows": [{ "id": "238...", "name": "", "parentName": "", "parentId": null,
                  "cost": 0, "totalRevenue": 0, "revenue": 0, "sales": 0, "leads": 0,
                  "calls": 0, "clicks": 0, "impressions": 0, "reported": 0,
                  "profit": 0, "roas": null, "...": "every catalog metric HYROS populated",
                  "_account": "act id from the call" }],
  "levels": {
    "traffic":  [{ "id": "facebook", "name": "facebook", "children": 3, "tags": ["@t1"], "cost": 0 }],
    "account":  [{ "id": "<adAccountId>", "name": "<ad account name>", "children": 3, "tags": [] }],
    "campaign": [{ "id": "<category name>", "name": "<category name>", "children": 3, "tags": [] }],
    "adset":    [{ "id": "", "name": "", "tag": "@t1", "_category": "", "_traffic": "", "_account": "" }],
    "ad":       [{ "id": "", "name": "", "parentId": "<ad set id>", "tag": "<parent ad set tag>", "_parentSet": "<parent name>" }]
  }
}
```
Money as plain numbers in the account currency; derived metrics re-derived by
`derive` after every sum (`aggregate`, `rollup`); nothing pre-formatted.

## View states
- Data: controls row, KPI strip (Cost, Total Revenue as the `hy` tile, Profit
  toned, ROAS, Sales, Leads, Calls, Clicks) over the visible rows with the range
  printed once above it (`.kpi-range`), crumbs when the hierarchy is drilled,
  the table in a `.win` with a `tfoot` of totals (`aggregate` over the visible
  rows). The HYROS band (`th.hy`, `td.hy`) on Total Revenue, Revenue and ROAS.
- Loading after a control change: the body shows "Loading..." while the controls
  stay usable; a newer control change stops the older load before its next call.
- One ad account failing: `.note.err` with the account name and the message; the
  other accounts still render.
- Deadline reached: `.note` "N ad accounts skipped: time budget" with their names;
  an account cut between pages says "first N rows of <account>: time budget". The
  next render retries them.
- List cut by `maxPages`: `.note` "showing newest 2,000 ad sets of <account>".
- Source join failed or skipped by time: `.note.err` / `.note`; those rows group
  under "Uncategorised" (Campaign) and "unknown" (Traffic), and their drills are
  off (no tag to query).
- Ad accounts list truncated: `.note` saying so.
- No supported ad account: `.empty`. No row in the range: `.empty` "No spend in
  this range". Filters hide every row: `.empty` "No rows match this filter."
- Custom range invalid (end after today in the account zone, start after end, a
  missing date): `.note.err` with the reason and no call.
- `adAccounts()` failing: `.note.err`, no table. `account()` failing: the render
  throws and the shell shows its error card with Retry.

## Controls
- Level: Traffic, Account, Campaign, Ad set, Ad (`.chipset`).
- Range: Today, Yesterday, Last 7 days, Last 30 days (`buildRanges`), Custom
  (two `<input type=date>` and Apply; end <= today in the account zone, start <=
  end). Default Last 30 days.
- Model: Last click, First click, Scientific. Default Last click.
- Window (days): `0..365`, only for Last click; `0` means the account default and
  is not sent.
- Ad accounts: a panel with one checkbox per supported ad account, All / None,
  Apply. Default all. Kept for the life of the page, not stored.
- Search (name, parent name, id), "Hide zero spend" (`cost > 0`).
- Columns: the catalog grouped, searchable, `DEFAULT_KEYS` by default, the
  switched-off LTV metrics disabled, "Reset"; saved in `localStorage`
  (`hyros-custom:report:cols`) inside `try`.
- Sort by header (`src/ui/table.js`); Name sorts ascending first, metrics
  descending.
- Hierarchy: clicking a name descends (Traffic or Account to Campaign, Campaign
  to Ad set, Ad set to Ad); crumbs go back. The Ad tab under a crumb shows the
  ads whose parent ad set passes the crumb filters.
- Drill: a Leads or New Leads cell over 0 opens `openCohortDrill` with
  `metric: 'leads'`; Sales or Unique Sales with `'sales'`; Calls or Qualified
  Calls with `'calls'`. Tags come from `drillTags(row, <column key>)`: the
  row's `tag`, or for a rolled-up row the tags of its ad sets with that
  column above 0, the biggest first (every tag when none has any). The drill
  sends the first 50 (the cap of GET /leads) and, when it leaves some out, says
  "first N of M sources" and never shows a bare 0. An Ad row drills with its
  parent ad set's tag and the note `ad set cohort: <ad set name>`. Sales and
  Calls drills pass the report's range, so they list only the records made
  in it ("N sales in the range"); the Leads cohort has no date filter.

## Rules honoured
- Metrics re-derived after summing (never averaged); money and numbers via
  `ctx.fmt`.
- Every string from HYROS escaped with `ctx.esc` (names, account names, error
  messages, tags never reach the markup: drills look rows up by index).
- Data only through `ctx.data`; read paths only; calls in sequence, also across
  renders (a new render waits for the older render's call in flight, so the same
  report is never in flight twice).
- A module-level render counter: every loop checks it before each call and
  stops when a newer render started.
- View-specific classes prefixed `report-`, tokens only; `localStorage` only
  inside `try`.

## Porting notes
Another dashboard reuses `view.js`, `columns.js`, `load.js` and `style.css`
unchanged if its `ctx.data` has `account()`, `adAccounts()`, `pagedInfo`,
`cached`, `peek` and `now()` with the shapes above, and it ships
`src/data/metrics.js`, `src/data/report-levels.js`, `src/ui/table.js`,
`src/ui/drill.js`, `src/core/dates.js` and `src/core/budget.js`. HYROS-specific:
the level per ad-account type, the `source_link` grouping that ad-account ids
require, the snake_case row keys read by `normalizeRow`, and the source join by
`adSource.adSourceId`.

## Open limitations
- Campaign and Traffic are HYROS source categories and traffic sources, rolled
  up in the browser; GET /attribution has no such level over ad-account ids.
- At most 2,000 rows (8 pages of 250, newest first) per ad account and level.
- Non-aggregatable metrics (CAC, percentages HYROS computes per row, forecasts)
  print "-" on rolled-up rows and in totals.
- The drill cohort is the leads that touched the row's sources, not the
  attribution-credited count in the cell; an Ad row's cohort is its ad set's.
- No CSV export (the HYROS frame blocks downloads), no column drag to reorder,
  no lead-stage filter.
