---
name: add-view
description: Add a new tab (view) to the HYROS Custom Dashboard the plug-and-play way: view folder from the template, SPEC.md, render through ctx.data, registry, npm run check. Use when asked to add a report, tab, analysis, chart or "view" to the dashboard.
---

# Add a view

Read `VIEWS.md` and `CLAUDE.md` first, then `UI-STYLE-GUIDE.md` before any
markup or CSS. `src/views/account/` (with its `SPEC.md`) is the worked
example; `src/views/_template/` is the skeleton.

1. Pick an id (`^[a-z][a-z0-9-]{1,30}$`). Copy the skeleton:
   `cp -r src/views/_template src/views/<id>` and set `id` (equal to the
   folder name), `title`, `version`, `description`, `style`, `tools` and
   `author` on the `view` object in `view.js`.
2. Write `SPEC.md` first: purpose, data (which MCP tools through
   `ctx.data`, request shapes, paging, limits), rows shape as JSON, view
   states, rules, porting notes, open limitations. Check `docs/RECIPES.md`
   for the tools, their argument shapes and the limits, and confirm the
   question is answerable with read tools (`READ_TOOLS` in
   `src/core/mcp.js`) before promising it. When `docs/RECIPES.md` and
   https://api-docs.hyros.com disagree, the official docs win.
3. `render(ctx)`: load through `ctx.data` (getters first, `call`, `paged`
   or `pagedInfo` for other tools), keep calls within the MCP limits in
   `VIEWS.md`, re-derive ratios after summing (`docs/RECIPES.md` "Derived
   metrics"), format with `ctx.fmt`, escape every data string with
   `ctx.esc`, build HTML into `ctx.root.innerHTML` with the shared kit
   (`.note`, `ctx.kpis`, `.section`, `.table-wrap`, `.fpanel`, `.fcols`,
   `.fshare`, `.pill`). One failing call becomes a `.note.err` inside the
   view; a cut-short list says so; no data renders `.empty`.
4. `style.css` only for view-specific classes, prefixed with the id, using
   the tokens in `styles.css` `:root`. No hex colors anywhere under `src/`.
   No `style.css` needed: delete it and set `style: false`.
5. Register the id in `VIEWS` in `src/views/registry.js` (array order is
   tab order).
6. Verify: `npm run check` must pass (the view contract, `SPEC.md`
   present, no fetch, no core imports, no native dialogs, no hex colors).
   Then `npm run dev`, open http://localhost:4323 (the harness), paste an
   MCP token and look at the tab: data, Refresh, and the warning and empty
   states.

Never edit `src/core/` to add a tab. If `ctx.data` is missing a getter a
view needs, use `ctx.data.call`, `paged` or `pagedInfo`; propose a new
getter in `src/data/data.js` only when several views need the same data,
document it in `VIEWS.md`, and keep it generic.
