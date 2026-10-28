# Views: the tab contract

A **view** is one tab of the dashboard, shipped as one folder under
`src/views/<id>/`. The shell (`src/app.js`) knows nothing about individual
views: it reads `src/views/registry.js`, imports each folder's `view.js`,
mounts a tab, and hands the view a `ctx` object to render with. A view
reaches HYROS only through `ctx.data`: it loads what it shows when it
renders, straight from the HYROS API, with the token the shell holds.

```
src/views/<id>/
  view.js      export const view = { id, title, render(ctx), ... }   the tab (required)
  style.css    view-scoped styles, linked when `style: true`          optional
  SPEC.md      the portable spec                                      required
```

Registry: two files, so the template's tabs and the account's own never
share a line and a template update merges without conflicts.

```js
// src/views/custom.js: the account's, the template never changes it
export const CUSTOM_VIEWS = ['custom-funnel'];   // tab order, after the template's
export const HIDDEN_VIEWS = ['scale'];           // template tabs not shown

// src/views/registry.js: the template's, changes with template updates
export const TEMPLATE_VIEWS = ['report', 'crm', 'scale', 'account'];
export const VIEWS = [...TEMPLATE_VIEWS minus HIDDEN_VIEWS, ...CUSTOM_VIEWS];
```

The array order is the tab order. An account's own view has an id that
starts with `custom-`, so a tab the template adds later never takes its
folder. To unplug a template view without deleting its folder, add its id
to `HIDDEN_VIEWS`; to unplug an own view, remove it from `CUSTOM_VIEWS`.
Folders whose name starts with `_` are skeletons (`src/views/_template/`)
and are never registered.

## 1. The `view` object

`view.js` exports one object named `view`:

| field | type | meaning |
|---|---|---|
| `id` | string | the folder name; `^[a-z][a-z0-9-]{1,30}$`. **Required** |
| `title` | string | the tab text. **Required** |
| `render` | `async (ctx) => void` | builds the tab. **Required** |
| `version` | semver string | bump when the view's data needs or its layout change |
| `description` | string | one sentence: the question the tab answers |
| `style` | boolean | `true` when the folder has a `style.css`; the shell links it once, before the first render |
| `tools` | string[] | the API paths the view reads through `ctx.data` (getters included, e.g. `'/leads'`), so a reader knows what one render costs |
| `author` | string | who to ask |

`id`, `title` and `render` are checked by `npm run check`
(`tests/boundaries.test.mjs`); `id` must equal the folder name.

## 2. `render(ctx)`

Called every time the tab is shown and on Refresh (after
`ctx.data.invalidate()`, so cached getters are fetched again). It must be
idempotent: build the HTML, assign `ctx.root.innerHTML`, then wire events
with `ctx.root.querySelectorAll(...)`. Every render gets a fresh `root`, so
a render that finishes after the user switched tabs writes into a detached
node and is harmless.

What the shell does around it:

- While `render` runs, the view shows Sven and "Loading…" and Refresh is
  disabled.
- If `render` throws, or takes longer than `VIEW_LOAD_MS`
  (`src/core/budget.js`, 2 minutes), the view shows an error card with a
  Retry button.

Partial states are the view's job:

- One failing call becomes a warning inside the view (`.note.err`, through
  a `try/catch` around that call), never a blank page and never a thrown
  render when the rest of the data is fine.
- A list that was cut short (`ctx.data.pagedInfo(...)` answered
  `truncated: true`, or a getter's `truncated`) says so, for example
  "showing newest 250 rows", instead of presenting the table as complete.
- No data is a state too: render `.empty` with a sentence that says why.

`ctx`:

| key | what |
|---|---|
| `root` | the element the view renders into (a fresh `<div class="view">` per render) |
| `data` | the data API (`src/data/data.js`): `account()`, `adAccounts()`, `sources()`, `stages()`, `call`, `paged`, `pagedInfo`, `cached`, `invalidate`, `now`. Which paths to call and how to shape the rows: `docs/RECIPES.md` |
| `fmt` | `src/ui/fmt.js`: `money(v)`, `moneyIn(v, code)`, `money0(v)`, `int(v)`, `pct(v)`, `ratio(v)`, `date(iso)`, `datetime(iso)`, `currencyCode(code)`. Money is in the account currency, dates in the account timezone; a missing value prints `-` |
| `esc(s)` | HTML-escape; use it on every string that came from HYROS |
| `kpis(list)` | KPI tiles HTML, already wrapped in `<div class="kpis">`: `[{ label, value, sub?, cls? }]`. `label`, `value` and `sub` are rendered as **escaped text** (no HTML inside them; pass values already formatted with `fmt`). `cls: 'hy'` goes on the tile and makes it the one highlight tile of the screen; `cls: 'good'` or `'bad'` goes on the figure (`.kpi-value`), the money tone; any other `cls` is ignored |
| `now` | the clock views should use (a function returning a `Date`) |

## 3. Shared markup kit (already styled in `styles.css`)

Use these before writing any CSS. `UI-STYLE-GUIDE.md` explains each one.

- Notes: `.note`, `.note.err`.
- KPI tiles: `.kpis` / `.kpi` (`.kpi.hy`), `.kpi-label`, `.kpi-value`,
  `.kpi-sub`, and `.kpi-range` for the date range printed once above them.
- Section titles: `h2.section`, with `.rowcount` beside the title.
- Windows: `.win` + `.winbar` (three `<i></i>` dots and a `<span>` address).
- Tables: `.table-wrap` around a `<table>`; `th.txt`/`td.txt` for text
  columns; `th.hy`/`td.hy` for the HYROS-attributed columns; `tfoot` for the
  totals row; `.sorted` and `.arrow` on sorted headers; `table.dense` for the
  denser CRM table; `.name-cell` for a name plus pill; `.col-wrap` /
  `.col-panel` for a column picker.
- Pills: `.pill` (`.ok`, `.bad`, `.stage`, `.warn`, `.fb`, `.hy`).
- Badges: `.badge` (`.live`).
- Segmented control: `.chipset` / `.chip` (`.active`) / `.chip-count`.
- Controls row: `.controls` (search, number and date inputs, selects, chipsets).
- Panels: `.fpanel` + `h3` + `.fhint`, `.fcols` (2-up grid that stacks on
  narrow frames), `.fshare` / `.fshare-head` / `.fshare-bar` share bars.
- Text: `.clip.clip-s`, `.clip.clip-m`, `.clip.clip-l` (clipped cells),
  `.empty`, `.sub` (quiet secondary text), `.good` / `.bad` (money tones).
- Drill: `button.drill` (a number that opens detail), `button.name-drill`,
  `.crumbs` / `.crumb` / `.crumb-sep` (breadcrumbs).
- The drawer (detail panel inside the view): `.drawer-scrim`, `.drawer`,
  `.drawer-head`, `.drawer-titles`, `.drawer-title`, `.drawer-subtitle`,
  `.drawer-body`, `.drawer-section`; a lead cohort `.cohort` /
  `.cohort-row`; a journey `.timeline` / `.tl-item` / `.tl-icon`; clicks
  `.clicks` / `.click-row` / `.click-page`.

Two shared modules build on the kit; import them from `view.js`:

- `src/ui/table.js`: `sortRows(rows, { col, dir })` (a sorted copy, missing
  values last), `nextSort(sort, col, firstDir)` for a header click, and
  `sortHeader({ col, label, cls }, sort)` for the `<th>`.
- `src/ui/drill.js`: the drawer and the drill behind a number.
  `openCohortDrill(ctx, { title, tags, metric, label, note })` opens the
  leads that touched the row's source tags (`metric: 'leads'`) or their
  `'sales'` / `'calls'` / `'qualifiedCalls'` (`DRILL_METRICS`); `openLeadJourney(ctx, email)` opens one lead's
  journey and click history. Both mount the drawer inside `ctx.root`, run
  their calls in sequence and say when a list is cut short. The pieces
  (`openDrawer`, `loadCohort`, `loadRecords`, `loadJourney`, the
  `render*` functions) are exported for a view that needs another flow.

View-specific classes go in the view's `style.css`, **prefixed with the view
id** (`.crm-filter`, never `.filter`), using only the tokens in
`styles.css` `:root`. No color literal in `view.js` or `style.css`: `npm run
check` fails on a hex color anywhere under `src/`.

## 4. Data rules

How to fetch each view's data is in `docs/RECIPES.md`. The rules every view
follows:

- **Derived metrics are re-derived after summing, never averaged.** A
  rolled-up row sums the additive parts (cost, revenue, clicks, ...) and
  computes ROAS, ROI, CPL, CTR and the rest from the sums. Use
  `src/data/metrics.js` (`derive`, `aggregate`, `rollup`, `CATALOG`) instead
  of writing the formulas again; `tests/metrics.test.mjs` pins them to a real
  report screen.
- **What a render loaded can be kept for the life of the page** with
  `ctx.data.cached(key, loader)`: the loader runs once per key, a rejected
  one is dropped so the next render tries again, and Refresh
  (`ctx.data.invalidate()`) clears every key. Put everything the result
  depends on in the key (`report:<model>:<start>:<end>`), so another tab can
  reuse it by asking for the same key.
- **Money and numbers go through `ctx.fmt`.** It knows the account currency
  and prints `-` for a missing value.
- **Dates stay as HYROS returns them** until render; format them only when
  building the HTML (`ctx.fmt.date`, `ctx.fmt.datetime`), which print them in
  the account timezone, never the browser's. A YYYY-MM-DD range bound goes in
  as it is. Parse HYROS dates with `src/core/dates.js` (`parseHyrosDate`,
  `offsetSuffix`).
- **Escape every string from data** with `ctx.esc` before it reaches
  `innerHTML`.
- **Read paths only.** `READ_PATHS` in `src/core/api.js` is the list;
  anything else fails with `not_allowed` before a request is made.

> **API limits (what a view must respect)**
> - At most 50 ids, emails, tags or lead ids per call (`ids`, `emails`,
>   `tags`, `leadIds`, `stage` arrays); `/leads/journey` takes at most 50
>   leads.
> - `pageSize` is 1 to 250; use `ctx.data.paged` or `ctx.data.pagedInfo`
>   with `maxPages` for more.
> - Per-call timeout 15 s (`TIMEOUTS.default` in `src/core/budget.js`); the
>   only exception is `TIMEOUTS.slow` (45 s) for the reads known to take
>   long, one such call at a time, run last so it cannot starve the cheap
>   ones.
> - One rate limit **per HYROS account**, shared by every caller of the
>   account. Run calls in sequence or a few at a time; parallel fan-out
>   trades rows for 429s.
> - Arguments are flat query parameters: `ctx.data.call('/leads', { fromDate, emails })`.
>   An array travels as one comma-separated value, so no value may hold a
>   comma. Enum casing differs per path (`/attribution` takes lowercase
>   names, `/sales` uppercase ones) and some paths answer 400 to a parameter
>   they do not know. Copy the exact parameters from `docs/RECIPES.md`.
> - The token is applied by the API client; a view never sees, passes or
>   stores it.

## 5. SPEC.md: the portable idea

Every view carries a spec, so the idea can be rebuilt on another dashboard
even when the code cannot be dropped in. Sections (see
`src/views/_template/SPEC.md`):

Purpose · Data (the paths called through `ctx.data`, with the parameters
and the limits honoured) · Rows shape (JSON) · View states · Rules honoured ·
Porting notes · Open limitations.

`src/views/account/SPEC.md` is a filled-in example.

## 6. Porting

A view travels as its folder: `view.js`, `style.css` and `SPEC.md`. Copy it
into `src/views/<id>/` of another copy of this dashboard and add the id to
`CUSTOM_VIEWS` in `src/views/custom.js` (renaming it to `custom-<id>` if it
is not prefixed yet). Into the template itself, it goes to `TEMPLATE_VIEWS`
in `src/views/registry.js` without the `custom-` prefix (drop it from the
folder, the `id` and the class prefix). A different dashboard can reuse `view.js` and `style.css`
unchanged if it provides the same `ctx`: the `ctx.data` getters the view
calls and the row shapes its `SPEC.md` names. When the code cannot travel,
`SPEC.md` is the requirement.

## 7. Conformance: `npm run check`

`tests/boundaries.test.mjs` checks the source:

- views never import `src/core/api.js`, `src/core/auth.js` or
  `src/core/config.js`, and never call `fetch`;
- every registered view exports `view` with `id` (equal to its folder),
  `title` and `render`;
- every registered view folder has a `SPEC.md`;
- the ids in `CUSTOM_VIEWS` start with `custom-`, the template's never do,
  and `HIDDEN_VIEWS` only names template tabs;
- no hex color literal in `src/**/*.js` or `src/views/**/style.css`;
- no file uses `alert`, `confirm` or `prompt` (the HYROS iframe sandbox
  blocks them);
- `localStorage` is only touched inside a `try` (partitioned frames and
  Safari can throw).

The other tests in `tests/` cover the auth handshake, the API client and
the data API.

## 8. Adding a view, step by step

These are the steps in a dashboard. In the template repository itself
(`origin` is `HyrosEngineeringAI/hyros-custom`), the id has no `custom-`
prefix and step 5 adds it to `TEMPLATE_VIEWS` in `src/views/registry.js`;
`src/views/custom.js` is never changed there.

1. Pick an id (`^[a-z][a-z0-9-]{1,30}$`, starting with `custom-`) and copy
   the skeleton:
   `cp -r src/views/_template src/views/<id>`.
2. In `view.js`, set `id` (equal to the folder name), `title`, `version`,
   `description`, `style`, `tools` and `author`. Delete `style.css` and set
   `style: false` if the kit is enough.
3. Write `SPEC.md` first: which paths, which parameters, the rows shape,
   the states. Check `docs/RECIPES.md` for the response shapes and limits.
4. Write `render(ctx)`: data through `ctx.data`, numbers through `ctx.fmt`,
   every string through `ctx.esc`, the shared kit before new CSS.
5. Add the id to `CUSTOM_VIEWS` in `src/views/custom.js`.
6. `npm run check`.
7. Once the user confirms and it is in production (see "GitHub access and
   deploys" in `AGENTS.md`), ask them to look at the tab on their
   dashboard: data, a refresh, and the empty and warning states.
8. Bump `version` whenever the view's data needs or layout change.
