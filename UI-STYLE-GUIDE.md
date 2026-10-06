# HYROS Custom Dashboard: UI Style and Design Guide

The visual system for this dashboard. It is the HYROS **CL1** design
language applied to the dashboard HYROS embeds in an iframe, one per
account. It was rebuilt in Sep 2026 with Alex to match the dashboard and
console graphics on hyros.com (the "app.hyros.com · dashboard" window over
the `hyros-mcp` console). **This document is self-contained: never reference
the Framer site or the hyros.com pages when working on this dashboard.**
Everything needed (tokens, fonts, assets, component patterns, rules) is
cited here and lives in this repo.

The single source of truth for every value below is
[`styles.css`](./styles.css) at the repo root: its `:root` block defines all
tokens, and **no color may ever be hardcoded outside it**. `src/` contains
zero color literals, views included; `npm run check` fails on a hex color in
any `src/**/*.js` or `src/views/**/style.css`. Keep it that way.

---

## 1. Principles

1. **Cream ground, white windows.** The page is warm cream (`--bg`). Product
   lives in white windows with a hairline, radius 12 and the three-dot bar
   with a centered mono address (`.win` + `.winbar`). Never a dark surface
   in the working UI; INK is reserved for the console and the primary button.
2. **Purple marks what HYROS did.** Brand purple paints what HYROS attributed,
   changed or selected: the attributed Revenue/ROAS columns (the lavender
   band), the highlight KPI tile, the active tab, sorted headers, drill
   links, the attribution-model label, focus rings. It never means "good".
3. **INK is the action.** The one primary action per screen
   (`button.primary`) is an INK button, radius 7. In the working dashboard
   that is Refresh in the topbar; on the connection gate, when it is the
   only thing on screen, it is "Try again". Everything else is a white
   hairline button, including the Retry on a view's error card. Never two
   INK buttons visible in the same context.
4. **Labels mono, figures serif, the rest Inter.** Every label, header, pill,
   badge and caption is Geist Mono 10.5px uppercase. Every big figure is
   P22 Mackinac. Body and cells are Inter 12.5 to 14px.
5. **Status colors live in data only.** Green `#1F8A5B` and terracotta
   `#B5533A` appear inside cells, pills and money tones, never on chrome,
   icons or buttons.
6. **Sven sparingly.** The lavender pixel Sven appears in exactly two
   moments: the connection gate and loading states. Never decorate the
   working UI with him.
7. **Dense is a feature.** This is a reporting tool; keep table density.
   Calm comes from hierarchy and restraint, not padding.
8. **Say a thing once.** Shared context (the KPI date range) prints one
   time above a group, never repeated per card.
9. **Functionality is sacred.** Styling changes must never alter behavior;
   `src/` edits made for styling are limited to cosmetic markup strings
   (class names, asset paths).

---

## 2. Color tokens (`styles.css` `:root`)

| Token | Value | Use |
|---|---|---|
| `--bg` | `#FAF9F5` | the cream page ground |
| `--surface` | `#FFFFFF` | windows, cards, the chrome |
| `--surface-2` | `#FCFBF8` | KPI tiles, table header rows, quiet cards, drawer head |
| `--surface-3` | `#F6F5F0` | panel ground, hovers, bar tracks |
| `--surface-4` | `#EDEBE3` | cream2: segmented-control tracks, window-bar dots |
| `--lavbg` | `#EEEEFB` | the HYROS band: attributed columns, active tab, highlight tile, purple pills |
| `--lav` | `#A5A4FA` | lavender data: share bars, Sven |
| `--border` | `rgba(31,30,29,.11)` | every hairline |
| `--border-2` | `rgba(31,30,29,.18)` | input/select borders |
| `--rule` | `rgba(31,30,29,.06)` | row dividers inside a window |
| `--ink` | `#1F1E1D` | text, the primary button, the console |
| `--ink-2` | `#55534E` | secondary text |
| `--ink-3` | `#8B8984` | mono labels, quiet text |
| `--brand` | `#5150F6` | THE accent: what HYROS attributed, changed or selected |
| `--brand-2` | `#403FD4` | purple hover |
| `--good` | `#1F8A5B` | positive money and status, data only |
| `--bad` | `#B5533A` | negative money, status and errors, data only |
| `--bad-fill` | `rgba(217,119,87,.16)` | the terracotta tint behind bad pills and error notes |
| `--warn` | `#B0781E` | warnings: partial data, no-show or refunded, "needs attention"; never an error |
| `--warn-fill` | `rgba(176,120,30,.14)` | the amber tint behind warning pills |

Tints are built from these with rgba (purple `rgba(81,80,246,.3)` borders,
`.16` focus rings; green `rgba(31,138,91,.07)` fills), never new hex values.
Pink and rainbow hairlines are not part of this system.

## 3. Shape and elevation

- `--r-btn: 7px` buttons, inputs, selects. `--r-tile: 10px` KPI tiles and
  notes. `--r-win: 12px` windows, cards, panels. `6px` for tabs, chips,
  badges and pills; `999px` only for journey-step and multiplier pills.
- `--shadow-win: 0 26px 60px -34px rgba(31,30,29,.35)` for windows (`.win`).
  `--shadow-card: 0 12px 34px -26px rgba(31,30,29,.35)` for cards and bare
  table wraps. `--shadow-pop: 0 24px 50px -30px rgba(31,30,29,.4)` for
  floating panels; the drawer carries its own left-cast shadow.
- Borders are always 1px hairlines (`--border`; `--border-2` on inputs);
  row dividers inside a window use `--rule`.

## 4. Typography

Fonts are **self-hosted in this repo** under `assets/fonts/`:

| File | Family | Weight | License note |
|---|---|---|---|
| `inter-regular.woff2`, `inter-medium.woff2`, `inter-semibold.woff2`, `inter-bold.woff2` | Inter | 400 / 500 / 600 / 700 | OFL (open) |
| `mackinac-book.woff2` | P22 Mackinac | 400 (Book) | Licensed, Book weight ONLY: do not fake bold or italic, do not subset |
| `geist-mono.woff2` | Geist Mono | 400 to 500 (variable) | OFL (from Google Fonts) |

- `--sans` (Inter): body 14px (`letter-spacing: -0.005em`), table cells
  13px (`table.dense` 12.5px), tabs and chips 12.5px, buttons 13.5px.
  Weight 400; 500 for names, totals, the active tab or chip. Never 600+ in
  the working UI.
- `--mono` (Geist Mono): **every label**: KPI labels, table headers, pills,
  badges, the window address, the kicker, section titles (`.section`),
  drawer section titles, dates, counts, the attribution model, percentages
  in bars. 10.5px uppercase with `.1em` tracking (`.pill` 10px / `.06em`;
  the window address 11px, not uppercase). Mono is also the console voice
  (`--term` + `--term-text`).
- `--serif` (P22 Mackinac Book): **figures and titles only**: `.kpi-value`
  (25px), `.fpanel h3` (19px), the gate headline (30px), and a view's own
  stat figures (17 to 19px, in the view's `style.css`). Regular weight,
  `-0.012em` tracking. Never the serif in running text, buttons or table
  cells.
- All numeric surfaces set `font-variant-numeric: tabular-nums`.

## 5. Brand assets (`assets/brand/`)

| File | What | Usage rules |
|---|---|---|
| `hyros-logo-blue.svg` | The full Hyros logo (pixel mark + serif wordmark, brand blue) | Topbar (`.brand-logo`, 20px tall, the hyros.com nav size). Never retype "Hyros" in a live font. |
| `hyros-mark-blue.svg` | The pixel mark alone | Favicon. |
| `sven-lavender.svg` | Sven, the 13x15 pixel grid in lavender, `shape-rendering: crispEdges` | Gate (`.gate-sven`, 78px) and loading states (`.sven-load`, 52px, gentle 1.8s bob, off under reduced motion). Nowhere else. |
| `sven-blue.png` | Legacy 28x32 blue Sven | Not referenced; kept only so the brand set is complete. |

Pixel art rule: Sven is a fixed grid. Render the SVG, never smooth-scale a
raster, never add badges, shadows or recolouring outside the brand
colourways (lavender here).

## 6. Component patterns (the dashboard kit, applied)

- **Window** `.win` + `.winbar`: white, hairline, radius 12, `--shadow-win`.
  The bar: three 9px cream2 dots left, the address centered in mono 11px
  (`app.hyros.com · custom dashboard` on the gate; a view that wraps its
  main table in a window uses `app.hyros.com · <view title>`, for example
  `· performance report` or `· crm`). The gate card is a window; a
  `.table-wrap` inside a window drops its own border, radius and shadow.
- **Topbar** `.topbar`: 56px white bar, hairline bottom: the logo
  (`.brand-logo`, 20px), the `.brand-sub` word "Custom Dashboard" (Inter
  400, `--ink-2`, 13px), a `.spacer`, the account email (`.acct`, `--ink-2`,
  12.5px) and the INK Refresh. The stylesheet also carries the topbar meta
  line for a shell that shows more context: account meta in 12.5px with
  quiet dot separators (`.meta`) and the attribution model as a purple mono
  label with a 6px purple dot (`.meta-pill`, "Model · ..."); the topbar does
  not render them today.
- **Tabs (views)** `.tabs .tab`: the app nav: 12.5px items, radius 6; the
  active one is a lavender pill in purple 500. Selectors keep
  `.tabs button.tab` specificity so the generic button hover can never
  repaint a tab; keep it if you touch them. The shell builds the tabs from
  `src/views/registry.js` (`VIEWS.md`).
- **Section title** `h2.section`: a mono label above a block of the view,
  with an optional `.rowcount` beside it (mono, not uppercase).
- **Segmented control** `.chipset` / `.chip`: a cream2 track (radius 8,
  padding 3) with 12.5px chips; the active chip (`.chip.active`) is a white
  card with INK text and a 1px shadow. Chip counts (`.chip-count`) are mono
  and turn lavender/purple on the active chip.
- **Buttons**: white, hairline, radius 7, 13.5px 400; hover `--surface-2`.
  `button.primary` is INK with white text (principle 3). `button.linkish` is
  a text-only button.
- **Inputs and selects**: white, `--border-2`, radius 7; focus = purple
  border + `rgba(81,80,246,.16)` ring. The search inside `.controls` flexes
  `1 1 150px` between 130 and 250px so the row never wraps at desktop
  width.
- **KPI tiles** `.kpi`: `--surface-2`, hairline, radius 10, mono label
  (`.kpi-label`), 25px serif figure (`.kpi-value`), mono sub (`.kpi-sub`).
  `.kpi.hy` is the highlight tile (lavender, purple figure): the
  HYROS-attributed Revenue KPI, **one per screen**; a view asks for it with
  `cls: 'hy'` on that item of `ctx.kpis`. Money tones wear `.good`/`.bad` on
  the figure (`cls: 'good'` or `'bad'` puts them on `.kpi-value`).
  The date range prints ONCE above the grid as `.kpi-range`.
- **Tables**: white; sticky header row on `--surface-2` in mono uppercase;
  `--rule` dividers; 13px cells; sticky first column; sticky `--surface-2`
  totals row (`tfoot`) at weight 500. Text columns are `th.txt`/`td.txt`
  (left aligned; numbers stay right aligned). Sorted headers wear `.sorted`
  with an `.arrow`. Row hover `--surface-2` (first column `--surface-3`).
  **The HYROS band**: the attributed columns of the Report view
  (`totalRevenue`, `revenue`, `roas`; `docs/RECIPES.md` "Report") render
  `td.hy` purple on `#F4F4FD` (lavender on hover and in totals) under a
  purple `th.hy`. That is the HYROS-column signature. No zebra striping.
  The CRM view runs one step denser: `table.dense` (12.5px cells, `8px 9px`
  padding, 9.5px pills).
- **Pills** `.pill`: mono 10px, hairline, radius 6, `--surface-2`. Status
  tints: `.pill.stage`/`.pill.ok` green, `.pill.warn` amber, `.pill.bad`
  terracotta, `.pill.fb` and `.pill.hy` lavender/purple. The CRM table and
  the drawer use the SAME tints.
- **Badges** `.badge`: mono with a status dot in the text color;
  `.badge.live` is lavender/purple with a solid dot.
- **Notes** `.note`: the quiet card (`--surface-2`, hairline, radius 10,
  13px). `.note.err` is the terracotta tint. A failing call inside a view
  becomes a `.note.err`, never a blank view.
- **Empty and loading**: `.empty` is the centered mono line for "nothing
  here"; the shell's loading state is `.empty` with `.sven-load` above
  "Loading…".
- **Share bars** `.fshare` (`.fshare-head`, `.fshare-bar`): lavender
  (`--lav`) fills on `--surface-3` tracks; figures inside bars in mono INK;
  share percentages mono purple (`.fshare-head b`). Journey steps, when a
  view draws them, are white hairline stadiums with the last one
  lavender/purple; rank and multiplier pills are lavender/purple mono pills.
  Those live in the view's own `style.css`, prefixed with its id.
- **Charts**: the Scale view's chart (`docs/RECIPES.md` "Scale") is an INK
  average line, a dashed purple marginal line, a terracotta dotted ceiling
  and a green saturation line, with mono axis text. Paint SVG strokes from
  the view's `style.css` with tokens; never write a color into SVG markup.
- **Drawer** (`.drawer-scrim`, `.drawer`, `.drawer-head`, `.drawer-body`,
  `.drawer-section`): a right sheet `min(460px, 94vw)`, `--surface-2` head
  with a mono subtitle (`.drawer-subtitle`), 32px square icon buttons
  (`.drawer-head button`), scrim `rgba(31,30,29,.32)`; timeline icons
  (`.tl-icon`) in `--surface-2` circles (sales, `.tl-sale`: lavender/purple);
  click paths (`.click-page`) in mono.
- **Gate** `.gate` / `.gate-card`: a centered 420px window
  (`app.hyros.com · custom dashboard`): Sven (`.gate-sven`), a purple mono
  kicker (`.gate-kick`), a 30px serif headline (a `<b>` inside it turns
  purple), the explanation text, and the INK "Try again" when the
  connection failed. Opened outside HYROS the same gate says "Open this
  dashboard from HYROS".

## 7. The feel layer (micro-interactions)

- Focus: global `:focus-visible` 2px purple outline; inputs get the ring
  instead. Checkboxes: `accent-color: var(--brand)`.
- Press: `button:active` nudges `translateY(0.5px)` (text-link buttons
  `.drill`/`.name-drill`/`.cohort-row` excluded).
- Transitions: 130ms color/background on buttons, chips and tabs.
- Entrances via `@starting-style` (Chromium; graceful no-op elsewhere):
  drawer slides 26px and fades (240ms `cubic-bezier(.2,.7,.3,1)`), scrim
  fades (200ms), column panel (`.col-panel`) pops -6px (160ms).
- Sven's loading bob: 1.8s ease-in-out, 4px.
- **Every animation dies under `prefers-reduced-motion: reduce`.** Any new
  motion must join that media block.
- `[hidden] { display: none !important }` guards the show/hide system:
  never give an element a bare `display: flex/grid` that could resurrect it
  while `hidden`.

## 8. Do / never

**Do**: add new colors as `:root` tokens in `styles.css`; build tints with
rgba on the tokens; keep one INK action per screen; keep every label mono;
keep tables dense; prefix a view's own classes with the view id and keep
them in the view's `style.css`; test at 1440x900 (primary): the dashboard is
a desktop tool that also has to survive a narrow iframe (the 640px rules).

**Never**: dark surfaces in the working UI; pink or a rainbow hairline;
purple to mean "good"; green or terracotta on chrome; the serif below 17px
or in running text; Inter above 500 weight;
new hex literals in `src/` or inline styles; zebra striping; Sven beyond
the gate and loading; smooth-scaled pixel art; motion without a
reduced-motion opt-out.

## 9. Verifying a visual change

```bash
npm run dev    # dashboard on http://localhost:4321, harness on http://localhost:4323
```

Open http://localhost:4323 (the harness, which plays HYROS), paste an MCP
access token, and screenshot the framed dashboard at 1440x900: the gate
while it connects, every tab, the loading state, and a view's error card.
Opened directly, http://localhost:4321 shows the "Open this dashboard from
HYROS" gate; that gate is part of the visual check too. The dev server
serves woff2, svg and png with their real types, so fonts and brand assets
render exactly as in production.
