/**
 * The skeleton of a view. Copy this folder to src/views/<id>/, set the fields
 * below, write SPEC.md first, then add the id to CUSTOM_VIEWS in src/views/custom.js
 * (id starting with custom-). In the template repository itself, add it to
 * TEMPLATE_VIEWS in src/views/registry.js instead, without the prefix.
 * Folders starting with "_" are never registered. The contract is in VIEWS.md.
 *
 * ctx = { root, data, fmt, esc, kpis, now }
 *   data   the only way to reach HYROS (docs/RECIPES.md): account(), adAccounts(),
 *          sources(), stages(), call, paged, pagedInfo, invalidate
 *   fmt    money, moneyIn, money0, int, pct, ratio, date, datetime, currencyCode
 *   esc    HTML-escape: every string that came from HYROS goes through it
 *   kpis   [{ label, value, sub?, meter?, minor?, cls? }] -> tiles HTML, values rendered as
 *          escaped text; sub is the context line under the figure (give every tile one),
 *          meter a 0..1 share drawn beside it, minor moves a count into the strip under
 *          the tiles; cls 'hy' marks the one highlight tile, 'good' or 'bad' tones the figure
 *
 * Layout (UI-STYLE-GUIDE.md): the view is ONE window (.win) made of bands (.band):
 * notes and tiles, then the content. A table goes last, flush, in a .table-wrap.
 *
 * Rules: no fetch and no imports from src/core/api.js, auth.js or config.js;
 * render is idempotent and builds everything into ctx.root.innerHTML; one
 * failing call is a warning inside the view, never a thrown render.
 */

/** How many traffic sources the panel lists before it stops. */
const TOP = 8;

/**
 * Loads the rows the view shows. A failure becomes `error` instead of a throw,
 * so the rest of the view still renders.
 */
async function load(data) {
  try {
    const sources = await data.sources();
    return { rows: sources.rows, truncated: sources.truncated, error: null };
  } catch (err) {
    return { rows: [], truncated: false, error: err?.message || 'HYROS did not answer.' };
  }
}

/** Sources per traffic source, largest first. */
function byTrafficSource(rows) {
  const counts = new Map();
  for (const row of rows) {
    const key = row?.trafficSource?.name || 'No traffic source';
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
}

/** The status line: says what the numbers are, or why there are none. */
function statusLine({ rows, truncated, error }, fmt, esc) {
  if (error) return `<div class="note err"><b>Sources could not load.</b> ${esc(error)}</div>`;
  if (truncated) return `<div class="note"><b>Partial list.</b> Showing the first ${esc(fmt.int(rows.length))} sources; more exist.</div>`;
  return '';
}

export const view = {
  id: 'my-view',
  title: 'My view',
  version: '0.1.0',
  description: 'One sentence: the question this tab answers.',
  style: true,
  tools: ['/sources'],
  author: 'Your name',

  async render(ctx) {
    const { root, data, fmt, esc, kpis } = ctx;
    const result = await load(data);
    const groups = byTrafficSource(result.rows);
    const top = groups[0]?.count || 0;

    // Every tile says one more thing than its figure, from what the view already holds.
    const tiles = kpis([
      { label: 'Sources', value: result.error ? '-' : fmt.int(result.rows.length), sub: result.truncated ? 'list cut short' : 'every source link on the account' },
      { label: 'Traffic sources', value: result.error ? '-' : fmt.int(groups.length), sub: groups.length ? `largest: ${groups[0].name}` : '' },
    ]);

    const bars = groups.slice(0, TOP).map((g) => `
      <div class="fshare">
        <div class="fshare-head"><span class="clip clip-l" title="${esc(g.name)}">${esc(g.name)}</span><b>${esc(fmt.int(g.count))}</b></div>
        <div class="fshare-bar"><div style="width:${top ? Math.round((g.count / top) * 100) : 0}%"></div></div>
      </div>`).join('');

    const body = groups.length
      ? bars
      : `<div class="empty">${result.error ? 'Nothing to show until sources load.' : 'No sources on this account.'}</div>`;

    root.innerHTML = `
      <div class="win">
        <div class="band">
          ${statusLine(result, fmt, esc)}
          ${tiles}
        </div>
        <div class="band my-view-panel">
          <h2 class="section">Sources by traffic source <span class="rowcount">top ${TOP}, counted from GET /sources</span></h2>
          ${body}
        </div>
      </div>`;
  },
};
