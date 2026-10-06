# Views: the tab contract

A **view** is one tab of the dashboard, shipped as one folder under
`src/views/<id>/`. The shell (`src/app.js`) knows nothing about individual
views: it reads `src/views/registry.js`, imports each folder's `view.js`,
mounts a tab, and hands the view a `ctx` object to render with. A view
reaches HYROS only through `ctx.data`: it loads what it shows when it
renders, straight from the MCP, with the token the shell holds.

```
src/views/<id>/
  view.js      export const view = { id, title, render(ctx), ... }   the tab (required)
  style.css    view-scoped styles, linked when `style: true`          optional
  SPEC.md      the portable spec                                      required
```

Registry: `src/views/registry.js`

```js
export const VIEWS = ['account'];   // tab order
```

The array order is the tab order. Remove an id to unplug a view without
deleting its folder. Folders whose name starts with `_` are skeletons
(`src/views/_template/`) and are never registered.

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
| `tools` | string[] | the MCP tools the view calls through `ctx.data` (getters included), so a reader knows what one render costs |
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
| `data` | the data API (`src/data/data.js`): `account()`, `adAccounts()`, `sources()`, `stages()`, `call`, `paged`, `pagedInfo`, `invalidate`, `now`. Which tools to call and how to shape the rows: `docs/RECIPES.md` |
| `fmt` | `src/ui/fmt.js`: `money(v)`, `moneyIn(v, code)`, `money0(v)`, `int(v)`, `pct(v)`, `ratio(v)`, `date(iso)`, `datetime(iso)`, `currencyCode(code)`. Money is in the account currency; a missing value prints `-` |
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
- Controls row: `.controls` (search inputs, selects, chipsets).
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

View-specific classes go in the view's `style.css`, **prefixed with the view
id** (`.health-check`, never `.check`), using only the tokens in
`styles.css` `:root`. No color literal in `view.js` or `style.css`: `npm run
check` fails on a hex color anywhere under `src/`.

## 4. Data rules

How to fetch each view's data is in `docs/RECIPES.md`. The rules every view
follows:

- **Derived metrics are re-derived after summing, never averaged.** A
  rolled-up row sums the additive parts (cost, revenue, clicks, ...) and
  computes ROAS, ROI, CPL, CTR and the rest from the sums
  (`docs/RECIPES.md` "Derived metrics").
- **Money and numbers go through `ctx.fmt`.** It knows the account currency
  and prints `-` for a missing value.
- **Dates stay as HYROS returns them** until render; format them only when
  building the HTML (`ctx.fmt.date`, `ctx.fmt.datetime`). Parse HYROS dates
  with `src/core/dates.js` (`parseHyrosDate`, `offsetSuffix`).
- **Escape every string from data** with `ctx.esc` before it reaches
  `innerHTML`.
- **Read tools only.** `READ_TOOLS` in `src/core/mcp.js` is the list;
  anything else fails with `not_allowed` before a request is made.

> **MCP limits (what a view must respect)**
> - At most 50 ids, emails, tags or lead ids per call (`ids`, `emails`,
>   `tags`, `leadIds`, `stages` arrays); `hyros_get_lead_journey` takes at
>   most 50 leads.
> - `pageSize` is 1 to 250; use `ctx.data.paged` or `ctx.data.pagedInfo`
>   with `maxPages` for more.
> - Per-call timeout 15 s (`TIMEOUTS.default` in `src/core/budget.js`); the
>   only exception is `TIMEOUTS.slow` (45 s) for the tools known to take
>   long, one such call at a time, run last so it cannot starve the cheap
>   ones.
> - One rate limit **per HYROS account**, shared by every caller of the
>   account. Run calls in sequence or a few at a time; parallel fan-out
>   trades rows for 429s.
> - Every tool wants its arguments under `{ request: { ... } }`; enum values
>   are UPPERCASE. Copy the exact argument shape from `docs/RECIPES.md`.
> - The token is applied by the MCP client; a view never sees, passes or
>   stores it.

## 5. SPEC.md: the portable idea

Every view carries a spec, so the idea can be rebuilt on another dashboard
even when the code cannot be dropped in. Sections (see
`src/views/_template/SPEC.md`):

Purpose · Data (the tools called through `ctx.data`, with the request shape
and the limits honoured) · Rows shape (JSON) · View states · Rules honoured ·
Porting notes · Open limitations.

`src/views/account/SPEC.md` is a filled-in example.

## 6. Porting

A view travels as its folder: `view.js`, `style.css` and `SPEC.md`. Copy it
into `src/views/<id>/` of another copy of this dashboard and add the id to
`registry.js`. A different dashboard can reuse `view.js` and `style.css`
unchanged if it provides the same `ctx`: the `ctx.data` getters the view
calls and the row shapes its `SPEC.md` names. When the code cannot travel,
`SPEC.md` is the requirement.

## 7. Conformance: `npm run check`

`tests/boundaries.test.mjs` checks the source:

- views never import `src/core/mcp.js`, `src/core/auth.js` or
  `src/core/config.js`, and never call `fetch`;
- every registered view exports `view` with `id` (equal to its folder),
  `title` and `render`;
- every registered view folder has a `SPEC.md`;
- no hex color literal in `src/**/*.js` or `src/views/**/style.css`;
- no file uses `alert`, `confirm` or `prompt` (the HYROS iframe sandbox
  blocks them);
- `localStorage` is only touched inside a `try` (partitioned frames and
  Safari can throw).

The other tests in `tests/` cover the auth handshake, the MCP client and
the data API.

## 8. Adding a view, step by step

1. Pick an id (`^[a-z][a-z0-9-]{1,30}$`) and copy the skeleton:
   `cp -r src/views/_template src/views/<id>`.
2. In `view.js`, set `id` (equal to the folder name), `title`, `version`,
   `description`, `style`, `tools` and `author`. Delete `style.css` and set
   `style: false` if the kit is enough.
3. Write `SPEC.md` first: which tools, which arguments, the rows shape,
   the states. Check `docs/RECIPES.md` for the tool shapes and limits.
4. Write `render(ctx)`: data through `ctx.data`, numbers through `ctx.fmt`,
   every string through `ctx.esc`, the shared kit before new CSS.
5. Add the id to `VIEWS` in `src/views/registry.js`.
6. `npm run check`.
7. `npm run dev`, open http://localhost:4323 (the harness), paste a token,
   and look at the tab: data, a refresh, and the empty and warning states.
8. Bump `version` whenever the view's data needs or layout change.
