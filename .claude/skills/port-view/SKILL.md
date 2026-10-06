---
name: port-view
description: Bring a view into the HYROS Custom Dashboard from another copy of this dashboard or from a SPEC.md alone, or hand one over to another dashboard. Use when asked to import, install, export, share or port a dashboard view or tab.
---

# Port a view

A view travels as its folder: `src/views/<id>/` with `view.js`, `SPEC.md`
and, when the view has one, `style.css`. Nothing outside the folder belongs
to it. The contract is `VIEWS.md`.

**Import a folder (another copy of this dashboard):**
copy it to `src/views/<id>/` and add the id to `VIEWS` in
`src/views/registry.js`. Read its `SPEC.md` first: if it calls a tool that
is not in `READ_TOOLS` (`src/core/mcp.js`), or a `ctx.data` getter this
dashboard lacks, say so before registering it. Check its `style.css` uses
only tokens from `styles.css` and that its classes are prefixed with its id.

**Export:** hand over the folder as it is. The receiving dashboard needs
the `ctx` described in `VIEWS.md` and the getters and row shapes the
`SPEC.md` names.

**Port from a spec only (code not reusable):** treat `SPEC.md` as the
requirement. Start from `src/views/_template/` (see the `add-view` skill),
fetch the data through `ctx.data` following `docs/RECIPES.md`, build the
rows shape the spec documents, reuse `view.js` and `style.css` if they were
provided, keep the `id` and `version` from the spec, and note in the new
`SPEC.md` what changed.

Always finish with `npm run check`, then `npm run dev` and a look at the
tab through the harness on http://localhost:4323.
