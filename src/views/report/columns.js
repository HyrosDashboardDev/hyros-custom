/**
 * The Performance Report's columns, levels and hierarchy: pure helpers, no
 * DOM and no calls, so tests/report.test.mjs can run them in node.
 * Ported from hyros-ai (public/app.js, column selector and report render).
 */
import { CATALOG, CATALOG_BY_KEY, DEFAULT_KEYS, rollup } from '../../data/metrics.js';

/** Level model, HYROS naming for Meta: SOURCE_CATEGORY is "Campaign", SOURCE_LINK is "Ad set". */
export const LEVELS = [
  { key: 'traffic', label: 'Traffic' },
  { key: 'account', label: 'Account' },
  { key: 'campaign', label: 'Campaign' },
  { key: 'adset', label: 'Ad set' },
  { key: 'ad', label: 'Ad' },
];
export const LEVEL_LABEL = Object.fromEntries(LEVELS.map((l) => [l.key, l.label]));

/** Clicking a row name descends the hierarchy. */
export const CHILD_LEVEL = { traffic: 'campaign', account: 'campaign', campaign: 'adset', adset: 'ad' };

/** Which load a level reads: the ad-set level serves four tabs, the ad level only the Ad tab. */
export const loadKindOf = (level) => (level === 'ad' ? 'ad' : 'adset');

/** HYROS-attributed columns wear the lavender band. */
export const HY = new Set(['totalRevenue', 'revenue', 'roas']);

export const KPIS = [
  { key: 'cost', label: 'Cost', t: 'money' },
  { key: 'totalRevenue', label: 'Total Revenue', t: 'money', hy: true },
  { key: 'profit', label: 'Profit', t: 'money', tone: true },
  { key: 'roas', label: 'ROAS', t: 'ratio' },
  { key: 'sales', label: 'Sales', t: 'int' },
  { key: 'leads', label: 'Leads', t: 'int' },
  { key: 'calls', label: 'Calls', t: 'int' },
  { key: 'clicks', label: 'Clicks', t: 'int' },
];

/** Which drill a cell opens. */
export const DRILL_METRIC = {
  leads: 'leads', newLeads: 'leads',
  sales: 'sales', uniqueSales: 'sales',
  calls: 'calls', qualifiedCalls: 'calls',
};

/* ---------------- columns ---------------- */

export const COLS_KEY = 'hyros-custom:report:cols';
export const SELECTABLE = CATALOG.filter((c) => !c.off).length;

const usableCol = (k) => CATALOG_BY_KEY.has(k) && !CATALOG_BY_KEY.get(k).off;

/** The usable columns of a saved set (unknown and switched-off ones dropped, no repeats), or null when none survive. */
export function usableCols(saved) {
  const cols = Array.isArray(saved) ? [...new Set(saved.filter(usableCol))] : [];
  return cols.length ? cols : null;
}

/** The saved column set, or DEFAULT_KEYS. `store` stands in for localStorage in tests. */
export function readCols(store) {
  try {
    const s = store || localStorage;
    return usableCols(JSON.parse(s.getItem(COLS_KEY))) || [...DEFAULT_KEYS];
  } catch {
    return [...DEFAULT_KEYS];
  }
}

/** Save the column set; a blocked storage keeps it for this page only. */
export function writeCols(cols, store) {
  try {
    const s = store || localStorage;
    if (cols) s.setItem(COLS_KEY, JSON.stringify(cols));
    else s.removeItem(COLS_KEY);
  } catch { /* partitioned frame or Safari: the choice lives until the page closes */ }
}

/** Catalog entries for the keys, in order. */
export const activeCols = (keys) => keys.map((k) => CATALOG_BY_KEY.get(k)).filter(Boolean);

/** The column picker's groups for a search text. */
export function colGroups(query = '') {
  const q = String(query).trim().toLowerCase();
  const groups = new Map();
  for (const c of CATALOG) {
    if (q && !`${c.l} ${c.k}`.toLowerCase().includes(q)) continue;
    if (!groups.has(c.g)) groups.set(c.g, []);
    groups.get(c.g).push(c);
  }
  return [...groups.entries()].map(([group, entries]) => ({ group, entries }));
}

/** The picker's body HTML. Labels come from the catalog; escaped anyway. */
export function colPanelHtml(keys, query, esc) {
  const selected = new Set(keys);
  const groups = colGroups(query);
  if (!groups.length) return '<div class="empty">No metrics match.</div>';
  return groups.map(({ group, entries }) => `
    <div class="col-group">
      <div class="col-group-title">${esc(group)}</div>
      ${entries.map((c) => `
        <label class="col-opt${c.a === null ? ' nonagg' : ''}" title="${esc(c.off || (c.a === null ? 'Native metric: shows on Ad set and Ad rows; rolled-up rows show -' : ''))}">
          <input type="checkbox" data-key="${esc(c.k)}"${selected.has(c.k) ? ' checked' : ''}${c.off ? ' disabled' : ''}>
          <span>${esc(c.l)}</span>
          ${c.off ? '<span class="pill warn">unavailable</span>' : c.a === null ? '<span class="pill">native</span>' : ''}
        </label>`).join('')}
    </div>`).join('');
}

/* ---------------- cells ---------------- */

/** A metric value printed by its type; missing prints "-". */
export function formatCell(fmt, value, type) {
  if (type === 'money') return fmt.money(value);
  if (type === 'pct') return fmt.pct(value);
  if (type === 'ratio') return fmt.ratio(value);
  return fmt.int(value);
}

/** The money tone of a toned column. */
export function toneClass(col, value) {
  if (!col?.tone || !Number.isFinite(value) || value === 0) return '';
  return value > 0 ? 'good' : 'bad';
}

/** The source tags a row drills with: its own tag, or the union carried by a rolled-up row. */
export function rowDrillTags(row) {
  if (row?.tag) return [row.tag];
  if (Array.isArray(row?.tags) && row.tags.length) return row.tags;
  return null;
}

/* ---------------- hierarchy ---------------- */

/** How a crumb filters an ad-set or ad row (ads carry their parent's fields). */
export const CRUMB_FILTER = {
  traffic: (a, id) => a._traffic === id,
  account: (a, id) => a._account === id,
  campaign: (a, id) => a._category === id,
  adset: (a, id) => (a._adset ?? a.id) === id,
};

export function applyPath(rows, path) {
  let out = rows;
  for (const crumb of path || []) {
    const filter = CRUMB_FILTER[crumb.level];
    if (filter) out = out.filter((a) => filter(a, crumb.id));
  }
  return out;
}

/** Union of the members' tags (at most 40, the get_leads `tags` filter is OR). */
function withTags(rows, members, keyOf) {
  return rows.map((row) => ({
    ...row,
    tags: [...new Set(members.filter((a) => keyOf(a) === row.id && a.tag).map((a) => a.tag))].slice(0, 40),
  }));
}

/**
 * The rows of one level after the account filter and the crumbs.
 * `adsets` are buildLevels' enriched ad-set rows; `ads` the enriched ad rows.
 * `accounts` is a Set of ad-account ids, or null for all.
 */
export function levelRows({ level, adsets = [], ads = [], accounts = null, path = [], adAccountName = new Map() }) {
  const inAccounts = (r) => !accounts || accounts.has(r._account);
  if (level === 'ad') return applyPath(ads.filter(inAccounts), path);
  const sets = applyPath(adsets.filter(inAccounts), path);
  if (level === 'adset') return sets;
  if (level === 'traffic') return withTags(rollup(sets, (r) => r._traffic, (id) => id), sets, (a) => a._traffic);
  if (level === 'account') {
    return withTags(rollup(sets, (r) => r._account, (id) => adAccountName.get(id) || id || 'Unknown'), sets, (a) => a._account);
  }
  return withTags(rollup(sets, (r) => r._category, (id) => id), sets, (a) => a._category);
}

/**
 * Ad rows enriched from their parent ad set's source entry: the tag the
 * drill uses, and the fields the crumbs filter on.
 */
export function enrichAds(adRows, sourceById) {
  return adRows.map((r) => {
    const src = r.parentId ? sourceById.get(r.parentId) : null;
    return {
      ...r,
      name: r.name || r.id,
      tag: r.tag || src?.tag || null,
      _adset: r.parentId,
      _parentSet: src?.name || r.parentName || r.parentId || null,
      _category: src?.category || 'Uncategorised',
      _traffic: src?.trafficSource || 'unknown',
      _account: r._account || src?.adAccountId || null,
    };
  });
}

/** Search (name, parent name, id) and "hide zero spend". */
export function filterRows(rows, { search = '', hideZero = false } = {}) {
  const q = String(search).trim().toLowerCase();
  let out = rows;
  if (q) out = out.filter((r) => `${r.name ?? ''} ${r.parentName ?? ''} ${r.id ?? ''}`.toLowerCase().includes(q));
  if (hideZero) out = out.filter((r) => (r.cost || 0) > 0);
  return out;
}
