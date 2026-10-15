/**
 * Performance Report: cost and attributed revenue per traffic source, ad
 * account, campaign, ad set and ad, with the drill behind a number.
 * Ported from hyros-ai (public/app.js report render, column picker, crumbs);
 * the loads are in load.js, the pure table helpers in columns.js.
 *
 * ctx = { root, data, fmt, esc, kpis, now }
 */
import { aggregate } from '../../data/metrics.js';
import { buildLevels } from '../../data/report-levels.js';
import { sortRows, nextSort, sortHeader } from '../../ui/table.js';
import { openCohortDrill } from '../../ui/drill.js';
import {
  LEVELS, LEVEL_LABEL, CHILD_LEVEL, HY, KPIS, DRILL_METRIC, SELECTABLE, loadKindOf,
  readCols, writeCols, activeCols, colPanelHtml, formatCell, toneClass, rowDrillTags,
  levelRows, enrichAds, filterRows,
} from './columns.js';
import {
  MODELS, MAX_WINDOW, renderDeadline, resolveRange, rangeLabel, partitionAccounts, loadReport, createSerial,
} from './load.js';

/** What the user picked; lives for the life of the page (tab switches keep it). */
const state = {
  level: 'campaign',
  rangeKey: '30d',
  custom: { start: '', end: '' },
  model: 'LAST_CLICK',
  window: 0,
  selected: null,           // Set of ad-account ids, or null for all
  search: '',
  hideZero: false,
  sort: { col: 'cost', dir: 'desc' },
  path: [],                 // crumbs: { level, id, name }
  cols: null,
};

/** D10: a newer render (control change, tab switch, Refresh) stops the older one's loop. */
let renderSeq = 0;
/** Source join memo by ad-source id, for the life of the page. */
const sourceMemo = new Map();
/** One call at a time across renders. */
const serial = createSerial();
/** The last painted load, for re-sorting and filtering without calls. */
let current = null;

const RANGE_CHIPS = [
  { key: 'today', label: 'Today' }, { key: 'yesterday', label: 'Yesterday' },
  { key: '7d', label: '7 days' }, { key: '30d', label: '30 days' }, { key: 'custom', label: 'Custom' },
];

const authError = (err) => err?.code === 'SIGN_IN' || err?.code === 'auth' || err?.code === 'NO_TOKEN';

/* ---------------- controls ---------------- */

function controlsHtml(ctx, { supported }) {
  const { esc, fmt } = ctx;
  const chips = (items, active, attr) => items.map((it) => `
    <button type="button" class="chip${it.key === active ? ' active' : ''}" data-${attr}="${esc(it.key)}">${esc(it.label)}</button>`).join('');
  const lastClick = state.model === 'LAST_CLICK';
  const selectedCount = state.selected ? supported.filter((a) => state.selected.has(String(a.id))).length : supported.length;
  const accountsLabel = state.selected ? `${fmt.int(selectedCount)} of ${fmt.int(supported.length)}` : `All (${fmt.int(supported.length)})`;

  const accountOpts = supported.map((a) => `
    <label class="col-opt">
      <input type="checkbox" data-acct="${esc(a.id)}"${!state.selected || state.selected.has(String(a.id)) ? ' checked' : ''}>
      <span>${esc(a.name || a.id)}</span><span class="pill">${esc(a.type)}</span>
    </label>`).join('');

  return `
    <div class="controls">
      <div class="chipset" role="tablist" aria-label="Level">${chips(LEVELS, state.level, 'level')}</div>
      <div class="chipset" aria-label="Range">${chips(RANGE_CHIPS, state.rangeKey, 'range')}</div>
      ${state.rangeKey === 'custom' ? `
        <span class="report-custom">
          <input type="date" data-custom="start" value="${esc(state.custom.start)}" aria-label="Start date">
          <span class="sub">to</span>
          <input type="date" data-custom="end" value="${esc(state.custom.end)}" aria-label="End date">
          <button type="button" data-custom-apply>Apply</button>
        </span>` : ''}
      <select data-model aria-label="Attribution model">
        ${MODELS.map((m) => `<option value="${esc(m.key)}"${m.key === state.model ? ' selected' : ''}>${esc(m.label)}</option>`).join('')}
      </select>
      <label class="report-window" title="${lastClick ? '0 uses the account default' : 'Only for Last click'}">
        <span class="sub">Window</span>
        <input type="number" data-window min="0" max="${MAX_WINDOW}" step="1" value="${esc(lastClick ? state.window : 0)}"${lastClick ? '' : ' disabled'} aria-label="Attribution window in days">
        <span class="sub">days</span>
      </label>
    </div>
    <div class="controls">
      <input type="search" data-search placeholder="Search name or id" value="${esc(state.search)}" aria-label="Search">
      <label class="report-toggle"><input type="checkbox" data-hide-zero${state.hideZero ? ' checked' : ''}> Hide zero spend</label>
      <span class="report-spacer"></span>
      <div class="col-wrap">
        <button type="button" data-acct-btn>Ad accounts: ${esc(accountsLabel)}</button>
        <div class="col-panel report-acct-panel" data-acct-panel hidden>
          <div class="col-groups report-acct-list">${accountOpts || '<div class="empty">No ad account with a report level.</div>'}</div>
          <div class="col-foot">
            <span><button type="button" class="linkish" data-acct-all>All</button> <button type="button" class="linkish" data-acct-none>None</button></span>
            <button type="button" data-acct-apply>Apply</button>
          </div>
        </div>
      </div>
      <div class="col-wrap">
        <button type="button" data-col-btn>Columns</button>
        <div class="col-panel" data-col-panel hidden>
          <div class="col-head">
            <input type="search" data-col-search placeholder="Find a metric" aria-label="Find a metric">
            <button type="button" class="linkish" data-col-reset>Reset</button>
          </div>
          <div class="col-groups" data-col-groups></div>
          <div class="col-foot"><span class="sub" data-col-count></span></div>
        </div>
      </div>
    </div>
    <div data-report-body></div>`;
}

function wireControls(ctx, { supported }) {
  const { root, esc } = ctx;
  const $ = (sel) => root.querySelector(sel);
  const rerender = () => { safeRender(ctx); };

  root.querySelectorAll('[data-level]').forEach((btn) => btn.addEventListener('click', () => {
    state.level = btn.dataset.level;
    root.querySelectorAll('[data-level]').forEach((b) => b.classList.toggle('active', b === btn));
    showLevel(ctx);
  }));

  root.querySelectorAll('[data-range]').forEach((btn) => btn.addEventListener('click', () => {
    state.rangeKey = btn.dataset.range;
    if (state.rangeKey === 'custom' && !state.custom.start && current?.range) state.custom = { start: current.range.start, end: current.range.end };
    rerender();
  }));

  $('[data-custom-apply]')?.addEventListener('click', () => {
    state.custom = { start: $('[data-custom="start"]').value, end: $('[data-custom="end"]').value };
    rerender();
  });

  $('[data-model]').addEventListener('change', (e) => { state.model = e.target.value; rerender(); });
  $('[data-window]').addEventListener('change', (e) => {
    const w = Math.trunc(Number(e.target.value));
    state.window = Number.isFinite(w) ? Math.min(MAX_WINDOW, Math.max(0, w)) : 0;
    rerender();
  });

  $('[data-search]').addEventListener('input', (e) => { state.search = e.target.value; paintBody(ctx); });
  $('[data-hide-zero]').addEventListener('change', (e) => { state.hideZero = e.target.checked; paintBody(ctx); });

  // Panels: open one at a time, close on a click elsewhere in the view.
  const acctPanel = $('[data-acct-panel]');
  const colPanel = $('[data-col-panel]');
  const closePanels = () => { acctPanel.hidden = true; colPanel.hidden = true; };
  root.addEventListener('click', closePanels);
  [acctPanel, colPanel].forEach((p) => p.addEventListener('click', (e) => e.stopPropagation()));

  $('[data-acct-btn]').addEventListener('click', (e) => {
    e.stopPropagation();
    const open = acctPanel.hidden;
    closePanels();
    acctPanel.hidden = !open;
  });
  const acctBoxes = () => [...acctPanel.querySelectorAll('input[data-acct]')];
  $('[data-acct-all]').addEventListener('click', () => acctBoxes().forEach((cb) => { cb.checked = true; }));
  $('[data-acct-none]').addEventListener('click', () => acctBoxes().forEach((cb) => { cb.checked = false; }));
  $('[data-acct-apply]').addEventListener('click', () => {
    const ids = acctBoxes().filter((cb) => cb.checked).map((cb) => cb.dataset.acct);
    state.selected = ids.length === supported.length ? null : new Set(ids);
    rerender();
  });

  const colGroupsEl = $('[data-col-groups]');
  const colSearch = $('[data-col-search]');
  const paintCols = () => {
    colGroupsEl.innerHTML = colPanelHtml(state.cols, colSearch.value, esc);
    $('[data-col-count]').textContent = `${state.cols.length} of ${SELECTABLE} columns`;
    colGroupsEl.querySelectorAll('input[data-key]').forEach((cb) => cb.addEventListener('change', () => {
      const key = cb.dataset.key;
      state.cols = cb.checked ? [...state.cols.filter((k) => k !== key), key] : state.cols.filter((k) => k !== key);
      writeCols(state.cols);
      $('[data-col-count]').textContent = `${state.cols.length} of ${SELECTABLE} columns`;
      paintBody(ctx);
    }));
  };
  $('[data-col-btn]').addEventListener('click', (e) => {
    e.stopPropagation();
    const open = colPanel.hidden;
    closePanels();
    colPanel.hidden = !open;
    if (open) paintCols();
  });
  colSearch.addEventListener('input', paintCols);
  $('[data-col-reset]').addEventListener('click', () => {
    writeCols(null);
    state.cols = readCols();
    paintCols();
    paintBody(ctx);
  });
}

/** A level change: repaint when the loaded data serves it, load otherwise. */
function showLevel(ctx) {
  if (current && current.root === ctx.root && current.kind === loadKindOf(state.level)) paintBody(ctx);
  else safeRender(ctx);
}

/* ---------------- notes ---------------- */

const names = (list, esc, max = 12) => {
  const shown = list.slice(0, max).map((a) => esc(a.name || a.id)).join(', ');
  return list.length > max ? `${shown} and ${list.length - max} more` : shown;
};

export function notesHtml(ctx, m) {
  const { esc, fmt } = ctx;
  const out = [];
  const unit = m.kind === 'ad' ? 'ads' : 'ad sets';
  if (m.adAccountsTruncated) out.push('<div class="note"><b>Ad accounts list cut short.</b> The report covers the ad accounts that loaded.</div>');
  if (m.unsupported.length) {
    out.push(`<div class="note"><b>No report level for ${fmt.int(m.unsupported.length)} ad account${m.unsupported.length > 1 ? 's' : ''}.</b> ${m.unsupported.slice(0, 12).map((a) => `${esc(a.name || a.id)} (${esc(a.type)})`).join(', ')}</div>`);
  }
  if (m.kind === 'ad' && m.noAdLevel.length) {
    out.push(`<div class="note"><b>No ad level for ${fmt.int(m.noAdLevel.length)} ad account${m.noAdLevel.length > 1 ? 's' : ''}</b> (they report at ad-set level only): ${names(m.noAdLevel, esc)}</div>`);
  }
  if (m.failed.length) {
    out.push(`<div class="note err"><b>${fmt.int(m.failed.length)} ad account${m.failed.length > 1 ? 's' : ''} could not load.</b> ${m.failed.slice(0, 8).map((f) => `${esc(f.account.name || f.account.id)}: ${esc(f.message)}`).join('; ')}${m.failed.length > 8 ? ` and ${m.failed.length - 8} more` : ''}. The rest of the report is shown.</div>`);
  }
  if (m.skipped.length) {
    out.push(`<div class="note"><b>${fmt.int(m.skipped.length)} ad account${m.skipped.length > 1 ? 's' : ''} skipped: time budget.</b> ${names(m.skipped, esc)}. <button type="button" class="linkish" data-load-rest>Load the rest</button></div>`);
  }
  for (const c of m.cut) {
    out.push(`<div class="note"><b>First ${fmt.int(c.count)} ${unit} of ${esc(c.account.name || c.account.id)}</b>: ${esc(c.reason)}.${m.skipped.length ? '' : ' <button type="button" class="linkish" data-load-rest>Load the rest</button>'}</div>`);
  }
  for (const c of m.capped) {
    out.push(`<div class="note">Showing newest ${fmt.int(c.count)} ${unit} of <b>${esc(c.account.name || c.account.id)}</b>.</div>`);
  }
  if (m.join.failed.length) {
    out.push(`<div class="note err"><b>Source details did not load for ${fmt.int(m.join.unjoined)} ${unit}.</b> ${esc(m.join.failed[0].message)}. They group under Uncategorised and unknown, and their drills are off.</div>`);
  } else if (m.join.unjoined) {
    out.push(`<div class="note"><b>Source details skipped for ${fmt.int(m.join.unjoined)} ${unit}: time budget.</b> They group under Uncategorised and unknown, and their drills are off. <button type="button" class="linkish" data-load-rest>Load the rest</button></div>`);
  }
  return out.join('');
}

/* ---------------- body ---------------- */

function crumbsHtml(esc) {
  if (!state.path.length) return '';
  return `<div class="crumbs">
    <button type="button" class="crumb" data-crumb="-1">All</button>
    ${state.path.map((c, i) => `
      <span class="crumb-sep">›</span>
      <button type="button" class="crumb${i === state.path.length - 1 ? ' current' : ''}" data-crumb="${i}" title="${esc(LEVEL_LABEL[c.level])}">${esc(c.name)}</button>`).join('')}
    <button type="button" class="crumb clear" data-crumb="clear" title="Clear drill-down" aria-label="Clear drill-down">✕</button>
  </div>`;
}

/** The rows the table shows, sorted. */
function visibleRows(m) {
  const accounts = state.selected ? state.selected : null;
  const rows = levelRows({ level: state.level, adsets: m.adsets, ads: m.ads, accounts, path: state.path, adAccountName: m.adAccountName });
  return sortRows(filterRows(rows, { search: state.search, hideZero: state.hideZero }), state.sort);
}

export function tableHtml(ctx, rows, cols) {
  const { esc, fmt } = ctx;
  const totals = aggregate(rows);
  const child = CHILD_LEVEL[state.level];
  const head = [sortHeader({ col: 'name', label: 'Name', cls: 'txt' }, state.sort),
    ...cols.map((c) => sortHeader({ col: c.k, label: c.l, cls: HY.has(c.k) ? 'hy' : '' }, state.sort))].join('');

  const body = rows.map((r, i) => {
    const sub = r.parentName ? `<span class="sub clip clip-m" title="${esc(r.parentName)}">${esc(r.parentName)}</span>`
      : r.children ? `<span class="pill">${fmt.int(r.children)}</span>` : '';
    const label = esc(r.name || r.id);
    const name = child
      ? `<button type="button" class="name-drill" data-i="${i}" title="Open its ${esc(LEVEL_LABEL[child].toLowerCase())}s">${label}</button>`
      : `<span>${label}</span>`;
    const cells = cols.map((c) => {
      const v = r[c.k];
      const metric = DRILL_METRIC[c.k];
      const drillable = metric && Number.isFinite(v) && v > 0 && rowDrillTags(r);
      const text = esc(formatCell(fmt, v, c.t));
      const cls = [toneClass(c, v), HY.has(c.k) ? 'hy' : ''].filter(Boolean).join(' ');
      return `<td${cls ? ` class="${cls}"` : ''}>${drillable ? `<button type="button" class="drill" data-i="${i}" data-metric="${esc(metric)}" data-key="${esc(c.k)}">${text}</button>` : text}</td>`;
    }).join('');
    return `<tr><td class="txt"><div class="name-cell">${name}${sub}</div></td>${cells}</tr>`;
  }).join('');

  const foot = `<tr><td class="txt">Total · ${esc(fmt.int(rows.length))} rows</td>${cols.map((c) => {
    const v = totals[c.k];
    const cls = [toneClass(c, v), HY.has(c.k) ? 'hy' : ''].filter(Boolean).join(' ');
    return `<td${cls ? ` class="${cls}"` : ''}>${esc(formatCell(fmt, v, c.t))}</td>`;
  }).join('')}</tr>`;

  return `<div class="win report-win">
      <div class="winbar"><i></i><i></i><i></i><span>app.hyros.com · performance report</span></div>
      <div class="table-wrap"><table>
        <thead><tr>${head}</tr></thead><tbody>${body}</tbody><tfoot>${foot}</tfoot>
      </table></div>
    </div>`;
}

function kpiHtml(ctx, rows, m) {
  const { fmt, esc, kpis } = ctx;
  const totals = aggregate(rows);
  const tiles = kpis(KPIS.map((k) => {
    const v = totals[k.key];
    const tone = k.tone ? toneClass({ tone: true }, v) : '';
    return { label: k.label, value: formatCell(fmt, v, k.t), cls: k.hy ? 'hy' : tone };
  }));
  const model = MODELS.find((x) => x.key === m.model)?.label || m.model;
  const range = `<div class="kpi-range">${esc(rangeLabel(m.range))} · ${esc(model)}${m.window ? ` · ${esc(fmt.int(m.window))}-day window` : ''}</div>`;
  return tiles.replace('<div class="kpis">', `<div class="kpis">${range}`);
}

/** Paint the body from `current` (no calls). */
function paintBody(ctx) {
  const { root, esc, fmt } = ctx;
  const el = root.querySelector('[data-report-body]');
  if (!el || !current || current.root !== root) return;
  if (current.kind !== loadKindOf(state.level)) { safeRender(ctx); return; }
  const m = current;
  const notes = notesHtml(ctx, m);
  const inAccounts = (r) => !state.selected || state.selected.has(r._account);
  const loaded = (m.kind === 'ad' ? m.ads : m.adsets).filter(inAccounts);

  let main;
  if (state.selected && !state.selected.size) {
    main = '<div class="empty">No ad account selected.</div>';
  } else if (!loaded.length) {
    main = `<div class="empty">No spend in this range (${esc(rangeLabel(m.range))}).</div>`;
  } else {
    const rows = visibleRows(m);
    const cols = activeCols(state.cols);
    main = `${kpiHtml(ctx, rows, m)}
      ${crumbsHtml(esc)}
      <h2 class="section">${esc(LEVEL_LABEL[state.level])} <span class="rowcount">${esc(fmt.int(rows.length))} rows</span></h2>
      ${rows.length ? tableHtml(ctx, rows, cols) : '<div class="empty">No rows match this filter.</div>'}`;
    el.innerHTML = notes + main;
    wireBody(ctx, rows, cols);
    return;
  }
  el.innerHTML = notes + main;
  wireBody(ctx, [], []);
}

function wireBody(ctx, rows, cols) {
  const { root } = ctx;
  const el = root.querySelector('[data-report-body]');
  el.querySelectorAll('[data-load-rest]').forEach((b) => b.addEventListener('click', () => safeRender(ctx)));

  el.querySelectorAll('thead th[data-col]').forEach((th) => th.addEventListener('click', () => {
    state.sort = nextSort(state.sort, th.dataset.col, th.dataset.col === 'name' ? 'asc' : 'desc');
    paintBody(ctx);
  }));

  el.querySelectorAll('[data-crumb]').forEach((btn) => btn.addEventListener('click', () => {
    const i = btn.dataset.crumb;
    if (i === 'clear' || i === '-1') {
      state.path = [];
    } else {
      const idx = Number(i);
      state.path = state.path.slice(0, idx + 1);
      state.level = CHILD_LEVEL[state.path[idx].level] || state.level;
    }
    syncLevelChips(root);
    showLevel(ctx);
  }));

  el.querySelectorAll('button.name-drill').forEach((btn) => btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const row = rows[Number(btn.dataset.i)];
    const child = CHILD_LEVEL[state.level];
    if (!row || !child) return;
    state.path = [...state.path, { level: state.level, id: row.id, name: row.name || row.id }];
    state.level = child;
    syncLevelChips(root);
    showLevel(ctx);
  }));

  el.querySelectorAll('button.drill').forEach((btn) => btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const row = rows[Number(btn.dataset.i)];
    const col = cols.find((c) => c.k === btn.dataset.key);
    const tags = rowDrillTags(row);
    if (!row || !tags) return;
    openCohortDrill(ctx, {
      title: row.name || row.id,
      tags,
      metric: btn.dataset.metric,
      label: col?.l || '',
      note: state.level === 'ad' && row._parentSet ? `ad set cohort: ${row._parentSet}` : '',
    });
  }));
}

function syncLevelChips(root) {
  root.querySelectorAll('[data-level]').forEach((b) => b.classList.toggle('active', b.dataset.level === state.level));
}

const LOADING = '<div class="empty"><img class="sven-load" src="./assets/brand/sven-lavender.svg" alt="">Loading…</div>';

/* ---------------- render ---------------- */

async function render(ctx) {
  const { root, data, esc } = ctx;
  const seq = ++renderSeq;
  const isCurrent = () => seq === renderSeq;
  const deadline = renderDeadline(Date.now());
  if (!state.cols) state.cols = readCols();

  const account = await data.account();
  const tz = account?.timezone || 'UTC';
  const now = data.now();

  let adAccounts;
  try {
    adAccounts = await data.adAccounts();
  } catch (err) {
    if (authError(err)) throw err;
    if (isCurrent()) root.innerHTML = `<div class="note err"><b>Ad accounts could not load.</b> ${esc(err?.message || 'HYROS did not answer.')}</div>`;
    return;
  }
  if (!isCurrent()) return;

  const parts = partitionAccounts(adAccounts.rows);
  const supported = parts.adset;
  if (state.selected) {
    const ids = new Set(supported.map((a) => String(a.id)));
    state.selected = new Set([...state.selected].filter((id) => ids.has(id)));
    if (state.selected.size === supported.length) state.selected = null;
  }

  root.innerHTML = controlsHtml(ctx, { supported });
  wireControls(ctx, { supported });
  const body = root.querySelector('[data-report-body]');
  if (current?.root === root) current = null;

  if (!supported.length) {
    body.innerHTML = `${parts.unsupported.length ? notesHtml(ctx, { ...emptyModel(), unsupported: parts.unsupported }) : ''}
      <div class="empty">No ad account with a report level is connected.</div>`;
    return;
  }

  const range = resolveRange(state.rangeKey, state.custom, now, tz);
  if (range.error) {
    body.innerHTML = `<div class="note err"><b>Custom range.</b> ${esc(range.error)}</div>`;
    return;
  }
  if (state.rangeKey === 'custom') state.custom = { start: range.start, end: range.end };

  const kind = loadKindOf(state.level);
  const kindSupported = kind === 'ad' ? parts.ad : parts.adset;
  const selected = state.selected ? kindSupported.filter((a) => state.selected.has(String(a.id))) : kindSupported;
  body.innerHTML = LOADING;

  const out = await loadReport(data, {
    kind, model: state.model, window: state.window, range, tz, now,
    selected, supported: kindSupported, memo: sourceMemo, deadline, isCurrent, serial,
  });
  if (out.stale || !isCurrent()) return;

  const adAccountName = new Map(adAccounts.rows.map((a) => [String(a.id), a.name]));
  const levels = kind === 'adset'
    ? buildLevels({ adsetRows: out.rows, adRows: [], sourceById: sourceMemo, adAccountName })
    : null;
  current = {
    root, kind, model: state.model, window: state.model === 'LAST_CLICK' ? state.window : 0, range,
    adsets: levels ? levels.adset : [],
    ads: kind === 'ad' ? enrichAds(out.rows, sourceMemo) : [],
    adAccountName,
    adAccountsTruncated: adAccounts.truncated,
    unsupported: parts.unsupported,
    noAdLevel: parts.noAdLevel,
    failed: out.failed, skipped: out.skipped, cut: out.cut, capped: out.capped, join: out.join,
  };
  paintBody(ctx);
}

/**
 * A render started from inside the view (a control change): the shell is not
 * watching it, so a throw becomes a note with Retry instead of an unhandled
 * rejection under a "Loading..." that never ends.
 */
function safeRender(ctx) {
  const seq = renderSeq + 1;
  return render(ctx).catch((err) => {
    if (seq !== renderSeq) return;
    const body = ctx.root.querySelector('[data-report-body]') || ctx.root;
    body.innerHTML = `<div class="note err"><b>The report could not load.</b> ${ctx.esc(err?.message || 'HYROS did not answer.')}</div>
      <button type="button" data-report-retry>Retry</button>`;
    body.querySelector('[data-report-retry]')?.addEventListener('click', () => safeRender(ctx));
  });
}

function emptyModel() {
  return { kind: 'adset', unsupported: [], noAdLevel: [], failed: [], skipped: [], cut: [], capped: [], join: { failed: [], unjoined: 0 } };
}

export const view = {
  id: 'report',
  title: 'Performance Report',
  version: '0.1.0',
  description: 'What each traffic source, ad account, campaign, ad set and ad cost and earned, under the attribution model you pick.',
  style: true,
  tools: ['hyros_get_user_info', 'hyros_get_ad_accounts', 'hyros_get_attribution_report', 'hyros_get_sources'],
  author: 'HYROS',
  render,
};
