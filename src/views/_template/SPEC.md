# <Title>: view spec

**id** `<id>` · **version** 0.1.0 · **tools** `hyros_get_...`

## Purpose
One paragraph: the question this tab answers and for whom.

## Data
- Which HYROS MCP tools the view calls through `ctx.data` (getters such as
  `ctx.data.sources()` count), with the request shape (`{ request: { ... } }`)
  and the paging used (`pageSize`, `maxPages`).
- How many calls one render costs, and which ones run in sequence.
- **MCP limits reminder** (VIEWS.md "Data rules"): at most 50 ids, emails,
  tags or lead ids per call; `pageSize` 1 to 250; per-call timeout 15 s
  (`TIMEOUTS.default`), `TIMEOUTS.slow` only for a tool known to take long;
  one rate limit per HYROS account, shared by every caller of the account.
  The token is applied by the MCP client; the view never sees it.

## Rows shape
What `render` builds from the answers, before formatting:
```json
{ "rows": [{ "name": "", "value": 0 }], "truncated": false, "error": null }
```
Money as plain numbers in the account currency, dates as HYROS returns
them; nothing pre-formatted.

## View states
The view renders every state and never throws: data · partial (a list cut
short says "showing newest N rows") · one call failed (a `.note.err` inside
the view, the rest still rendered) · empty (`.empty` with the reason). The
shell shows "Loading…" while `render` runs and an error card with Retry if
it throws or runs past `VIEW_LOAD_MS`.

## Rules honoured
- Metrics re-derived after summing (never averaged); money and numbers via
  `ctx.fmt`.
- Every string from HYROS escaped with `ctx.esc`.
- Data only through `ctx.data`; read tools only.
- View-specific classes prefixed with the id, tokens only.

## Porting notes
What another dashboard must provide to reuse `view.js` and `style.css`
unchanged: the `ctx.data` getters and tools above, and the rows shape.
Anything HYROS-specific in how the answers are read.

## Open limitations
What the view cannot show yet and why: a missing MCP tool or argument, a
page cap, an undocumented reply shape it reads tolerantly.
