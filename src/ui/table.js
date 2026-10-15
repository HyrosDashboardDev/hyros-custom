/**
 * Sorting shared by the tables of every view: the order of the rows and the
 * header that toggles it. `sort` is `{ col, dir: 'asc' | 'desc' }`.
 */
import { esc } from './dom.js';

const missing = (v) => v === null || v === undefined || v === '' || (typeof v === 'number' && !Number.isFinite(v));

/**
 * A sorted copy of `rows`. Numbers compare as numbers, anything else as text;
 * a missing value (null, '', NaN, Infinity) goes last in either direction, so
 * a "-" cell never tops a table.
 */
export function sortRows(rows, { col, dir = 'desc' } = {}) {
  const sign = dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const av = a?.[col];
    const bv = b?.[col];
    if (missing(av) || missing(bv)) return Number(missing(av)) - Number(missing(bv));
    if (typeof av === 'number' && typeof bv === 'number') return sign * (av - bv);
    return sign * String(av).localeCompare(String(bv));
  });
}

/** The sort after a click on `col`: the same column flips, a new one starts at `firstDir`. */
export function nextSort(sort, col, firstDir = 'desc') {
  return sort?.col === col
    ? { col, dir: sort.dir === 'asc' ? 'desc' : 'asc' }
    : { col, dir: firstDir };
}

/**
 * A sortable `<th>`: `data-col` for the click handler, `.sorted` and the
 * arrow on the active column. `label` is escaped; `cls` adds `txt` or `hy`.
 */
export function sortHeader({ col, label, cls = '', title = '' }, sort) {
  const sorted = sort?.col === col;
  const arrow = sorted ? (sort.dir === 'asc' ? '▲' : '▼') : '';
  const classes = [sorted ? 'sorted' : '', cls].filter(Boolean).join(' ');
  return `<th${classes ? ` class="${esc(classes)}"` : ''} data-col="${esc(col)}"${title ? ` title="${esc(title)}"` : ''}>${esc(label)}<span class="arrow">${arrow}</span></th>`;
}
