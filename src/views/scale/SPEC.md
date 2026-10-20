# Scale: view spec

**id** `scale` · **version** 0.1.0 · **tools** `/user-info`, `/ad-accounts`, `/attribution/marginal-cac-curve`

## Purpose
For the ad accounts the user picks (and, when the Report already ranked
them, the six biggest ad sets by 30-day cost), show how the cost of the
NEXT customer changes as daily spend rises, and where it crosses the CAC
ceiling (the saturation point). It answers "how far can this budget scale
before the next dollar stops paying for itself?".

## Data
Getters (cached for the life of the page): `ctx.data.account()` (timezone)
and `ctx.data.adAccounts()` (the chips).

One GET `/api/v1.0/attribution/marginal-cac-curve` call per target, **in
series**, account targets first, ad sets after them:

```js
ctx.data.call('/attribution/marginal-cac-curve', {
  id,                                   // ad account id (account) or ad set id (source_link)
  level: 'account' | 'source_link',     // the target's ACCOUNT | SOURCE_LINK, lowercased
  startDate: addDays(end, -89),         // YYYY-MM-DD, no offset: the account zone is assumed
  endDate: end,                         // YYYY-MM-DD, default today in the account zone
  attributionModel: 'last_click',
}, { timeoutMs: clampTimeout(TIMEOUTS.slow, deadline) })
```

The reply is `{ request_id, result: <curve> }`; `normalizeCurve` unwraps it.

- The endpoint is strict: any parameter other than `id`, `level`,
  `startDate`, `endDate`, `ltvWindow`, `cacCeiling`, `attributionModel`, or a
  repeated one, is a 400. `level` and `attributionModel` are read
  case-insensitively; the view sends the documented lowercase names.
- No `cacCeiling` and no `ltvWindow` (the API rejects `ltvWindow` at
  account level). Ad sets get HYROS's LTV break-even ceiling; account
  curves have no ceiling, so their only saturation is spend that buys no
  extra customers (`NO_INCREMENTAL_CUSTOMERS`).
- ACCOUNT level accepts at most 90 days: `end - 89 days` to `end`.
- Each curve is memoised with `ctx.data.cached('scale:<id>:<level>:<end>')`;
  Refresh clears it, a failed call is retried on the next render.
- The curve is computed live from 90 days of spend: `TIMEOUTS.slow` (45 s),
  clamped to the render deadline (`start + VIEW_LOAD_MS - 15 s`). No call
  starts after the deadline; the targets left are "skipped: time budget".
- A module-level render counter stops the loop of an older render
  (control change, tab switch, Refresh) before its next call.
- **Ad sets** come only from the Report's own load, read with
  `ctx.data.peek('report:LAST_CLICK:0:<start>:<end>:adset')` where
  `start`/`end` are `buildRanges(now, tz)['30d']`. `peek` never loads or
  caches anything. When that promise has resolved, its `adsetRows` (normalized
  rows with `id`, `name`, `cost`, `_account`) are sorted by `cost` and the top
  6 with spend become SOURCE_LINK targets. When it is absent, still loading or
  failed, the ad sets panel says "Open Report, last 30 days, Last click, to
  rank ad sets".
- Default selection: the first 2 ad accounts by 30-day cost when the
  Report's rows are there, else the first 2 listed. The selection is kept in
  `localStorage` (`hyros-custom.scale.accounts`), always inside `try`.
- One render with the default selection costs 2 curve calls (up to 45 s
  each), plus 6 when the Report ranked ad sets. `render` resolves after the
  first curve lands; the others fill in as they arrive.
- **API limits**: one rate limit per HYROS account, so calls run in series;
  the token is applied by the API client (`src/core/api.js`) and never seen
  by the view.

## Rows shape
One normalized curve per target (`normalizeCurve`, copied from hyros-ai):
```json
{ "id": "", "name": "", "level": "ACCOUNT|SOURCE_LINK", "account": "ad account name or null",
  "attributionModel": "LAST_CLICK", "daysSampled": 84,
  "ceiling": 52, "ceilingBasis": "CALLER_PROVIDED|LTV_BREAKEVEN|null", "ltvWindow": "NINETY_DAYS|null",
  "saturationSpend": 2274.75, "efficientSpend": 1490.1, "saturationReason": "MARGINAL_CAC_ABOVE_CEILING|NO_INCREMENTAL_CUSTOMERS|null",
  "points": [{ "spend": 812.4, "days": 28, "customers": 594, "avgCac": 38.29, "marginalCac": null }],
  "notes": ["NO_SPEND_DATA|NO_CUSTOMERS|INSUFFICIENT_DATA|LTV_CEILING_UNAVAILABLE"],
  "pending": "optional true", "error": "optional message", "skipped": "optional reason" }
```
Money as plain numbers in the account currency.

## View states
- Controls: one chip per ad account (toggle), an end date input (max today
  in the account zone). A future or malformed date is refused with a
  `.note.err` and the previous date stays.
- Data: four KPI tiles (Entities analyzed, With spend history, Saturation
  found, Room to scale) and one card per target with the SVG chart (average
  CAC in INK, marginal CAC dashed purple, ceiling dotted terracotta,
  saturation green) and three stats (ceiling, saturation spend, marginal CAC
  at the top of the range).
- Loading: a card per target still waiting says "Loading curve".
- One curve failed: that card shows the message (`.note.err`), the rest
  render. Every curve failed: one "HYROS did not answer the marginal CAC
  curve" card.
- `notes` are shown in plain words; fewer than 2 points: "Not enough data
  yet" (or the note's words).
- Thin curve (3 spend levels or fewer, a level with no customers, or
  `INSUFFICIENT_DATA`): a `warn` pill "thin curve" even when `notes` is empty.
- Deadline: the targets not requested say "skipped: time budget".
- No ad accounts: `.empty` "No ad accounts connected". None selected: `.empty`
  "Pick at least one ad account".
- Ad sets panel without Report data: a `.note` with the instruction above.

## Rules honoured
- Data only through `ctx.data`; read paths only; calls in series.
- Every HYROS string escaped with `ctx.esc`; money via `ctx.fmt`.
- No color in SVG markup: strokes come from `style.css` with tokens
  (`--ink`, `--brand`, `--bad`, `--good`, `--rule`, `--border-2`).
- Classes prefixed `scale-`; `localStorage` only inside `try`.

## Porting notes
Another dashboard reuses `view.js`, `curve.js` and `style.css` if its
`ctx.data` has `account()`, `adAccounts()`, `call`, `cached`, `peek` and
`now`. The ad set ranking depends on the Report view caching its 30-day ad
set load under the key above with `{ adsetRows }`; without it the view still
works at account level. HYROS-specific: the 90-day cap at account level, the
strict parameter list and the lowercase `level` and `attributionModel` values.

## Open limitations
- Ad sets are ranked only when the Report loaded "last 30 days, Last click,
  default window" in this page; Scale never loads the report itself (it
  would cost ~100 calls).
- Account curves have no ceiling (no caller ceiling is sent), so their
  saturation reads only "no incremental customers".
- The curve uses last-click credit (closing cost), so its figures differ
  from a first-click acquisition curve.
