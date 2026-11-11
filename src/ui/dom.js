/**
 * Small DOM helpers. Views build HTML strings, so every value that came from
 * HYROS goes through esc() before it reaches innerHTML.
 */

export const $ = (selector, root = document) => root.querySelector(selector);

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** HTML-escape any value; null and undefined become ''. */
export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

/**
 * A note card. `title` is escaped; `body` is HTML the caller already escaped.
 * kind: '' (quiet) or 'err'.
 */
export function card({ title = '', body = '', kind = '' } = {}) {
  return `<div class="note${kind ? ` ${kind}` : ''}">${title ? `<b>${esc(title)}</b> ` : ''}${body}</div>`;
}

/**
 * A row of KPI tiles. Each item is { label, value, sub?, meter?, minor?, cls? };
 * label, value and sub are escaped, so pass values already formatted with fmt.
 * `sub` is the line under the figure: context the view already holds (a share,
 * a rate, a unit cost). `meter` is a share from 0 to 1 drawn beside the sub
 * line: the whole bar is the figure, the pale part the share. `minor: true`
 * moves the item out of the tiles into one slim strip under them, for the
 * counts that support the headline figures. `cls` is one of: `hy`, the one
 * highlight tile of the screen (lavender ground, purple figure), applied to the
 * tile; `good` or `bad`, the money tone, applied to the figure. Anything else
 * is ignored.
 */
export function kpis(items) {
  const subLine = ({ sub, meter }) => {
    const share = Number.isFinite(meter) ? Math.max(0, Math.min(1, meter)) : null;
    if (!sub && share === null) return '';
    const bar = share === null ? '' : `<span class="kpi-meter"><i style="width:${(share * 100).toFixed(1)}%"></i></span>`;
    return `<div class="kpi-sub">${bar}<span>${esc(sub || '')}</span></div>`;
  };
  const tiles = items.filter((item) => !item.minor).map((item) => {
    const { label, value, cls } = item;
    const tile = cls === 'hy' ? ' hy' : '';
    const tone = cls === 'good' || cls === 'bad' ? ` ${cls}` : '';
    return `
    <div class="kpi${tile}">
      <div class="kpi-label">${esc(label)}</div>
      <div class="kpi-value${tone}">${esc(value)}</div>
      ${subLine(item)}
    </div>`;
  }).join('');
  const minor = items.filter((item) => item.minor).map((item) => `
      <div class="stat"><span class="kpi-label">${esc(item.label)}</span><b>${esc(item.value)}</b>${subLine(item)}</div>`).join('');
  return `<div class="kpis">${tiles}${minor ? `
    <div class="stats">${minor}
    </div>` : ''}</div>`;
}
