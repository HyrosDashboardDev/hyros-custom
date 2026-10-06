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
 * A row of KPI tiles. Each item is { label, value, sub?, cls? }; label, value and
 * sub are escaped, so pass values already formatted with fmt. `cls` is one of:
 * `hy`, the one highlight tile of the screen (lavender ground, purple figure),
 * applied to the tile; `good` or `bad`, the money tone, applied to the figure.
 * Anything else is ignored.
 */
export function kpis(items) {
  const tiles = items.map(({ label, value, sub, cls }) => {
    const tile = cls === 'hy' ? ' hy' : '';
    const tone = cls === 'good' || cls === 'bad' ? ` ${cls}` : '';
    return `
    <div class="kpi${tile}">
      <div class="kpi-label">${esc(label)}</div>
      <div class="kpi-value${tone}">${esc(value)}</div>
      ${sub ? `<div class="kpi-sub">${esc(sub)}</div>` : ''}
    </div>`;
  }).join('');
  return `<div class="kpis">${tiles}</div>`;
}
