/**
 * CRM: the leads, sales, calls and subscriptions of a date range, with the
 * account totals of that range on top and each lead's journey one click
 * away. Ported from hyros-ai (public/app.js CRM, api/_snapshot.js buildCrm),
 * rewritten to load live through ctx.data: one sub-tab per render (the others
 * load when their chip is clicked), every call in series. SPEC.md has the
 * calls, the rows and the states.
 *
 * ctx = { root, data, fmt, esc, kpis, now }
 */
import { VIEW_LOAD_MS } from '../../core/budget.js';
import { ymdInTz } from '../../core/dates.js';
import { sortRows, nextSort } from '../../ui/table.js';
import { openLeadJourney } from '../../ui/drill.js';
import {
  TABS, TAB_BY_KEY, RANGE_KEYS, RECURRING, REFUNDED, QUALIFIED, SUBSCRIPTION_STATES,
  defaultFilters, emailParam, filterParams, resolveRange,
} from './filters.js';
import { loadTab, headline, knownCount } from './load.js';
import { tableHtml, tabsHtml, tilesHtml, countText, DEFAULT_SORT } from './markup.js';

/** Margin kept before the shell's own limit, so a slow list never turns into the shell's error card. */
const DEADLINE_MARGIN_MS = 15000;
/** Pause after the last keystroke before the email search reloads. */
const SEARCH_DEBOUNCE_MS = 400;

const RANGE_LABELS = { today: 'Today', yesterday: 'Yesterday', '7d': '7 days', '30d': '30 days', custom: 'Custom' };
const VERBS = { leads: 'joined', sales: 'made', calls: 'booked', subscriptions: 'started' };

/* Module state: survives a tab switch and a Refresh, so the controls stay where the user left them. */
const state = {
  tab: 'leads',
  rangeKey: '30d',
  custom: { start: '', end: '' },
  search: '',
  attr: 'all',
  filters: defaultFilters(),
  sort: { ...DEFAULT_SORT },
  qualStages: [],
};

/** D10: bumped by every load; an older load stops before its next call and never paints. */
let renderSeq = 0;
let searchTimer = null;
/** What the last paint showed, so a sort or a client-side filter repaints without a call. */
let last = null;

const message = (err) => String(err?.message || err || 'HYROS did not answer.');

function host(root) {
  let el = root.querySelector(':scope > .crm');
  if (!el) {
    root.innerHTML = '';
    el = document.createElement('div');
    el.className = 'crm';
    root.append(el);
  }
  return el;
}

const option = (ctx, value, label, selected) =>
  `<option value="${ctx.esc(value)}"${selected ? ' selected' : ''}>${ctx.esc(label)}</option>`;

function rangeControls(ctx, today) {
  const chips = RANGE_KEYS.map((k) => `<button type="button" class="chip${state.rangeKey === k ? ' active' : ''}" data-crm-range="${k}">${RANGE_LABELS[k]}</button>`).join('');
  const custom = state.rangeKey === 'custom' ? `
    <span class="crm-custom">
      <input type="date" class="crm-date" data-crm-from data-crm-keep="from" value="${ctx.esc(state.custom.start)}" max="${ctx.esc(today)}" aria-label="Start date">
      <span class="sub">to</span>
      <input type="date" class="crm-date" data-crm-to data-crm-keep="to" value="${ctx.esc(state.custom.end)}" max="${ctx.esc(today)}" aria-label="End date">
    </span>` : '';
  return `<div class="chipset crm-range">${chips}</div>${custom}`;
}

function tabControls(ctx, stages) {
  const f = state.filters[state.tab];
  if (state.tab === 'leads') {
    const names = [...new Set((stages || []).map((s) => s?.name).filter(Boolean).map(String))];
    if (f.stage && !names.includes(f.stage)) names.push(f.stage);
    return `
      <select data-crm-filter="stage" aria-label="Stage">${option(ctx, '', 'All stages', !f.stage)}${names.map((n) => option(ctx, n, n, f.stage === n)).join('')}</select>
      <input type="search" class="crm-tags" data-crm-filter="tags" data-crm-keep="tags" placeholder="Tags, comma separated" value="${ctx.esc(f.tags)}" aria-label="Tags">
      <select data-crm-attr aria-label="Source">
        ${option(ctx, 'all', 'With or without a source', state.attr === 'all')}
        ${option(ctx, 'with', 'With a source', state.attr === 'with')}
        ${option(ctx, 'without', 'Without a source', state.attr === 'without')}
      </select>`;
  }
  if (state.tab === 'sales') {
    const rec = { ALL: 'Recurring or not', RECURRING: 'Recurring', NON_RECURRING: 'Not recurring' };
    const ref = { ALL: 'Refunded or not', REFUNDED: 'Refunded', NON_REFUNDED: 'Not refunded' };
    return `
      <select data-crm-filter="recurring" aria-label="Recurring">${RECURRING.map((v) => option(ctx, v, rec[v], f.recurring === v)).join('')}</select>
      <select data-crm-filter="refunded" aria-label="Refund">${REFUNDED.map((v) => option(ctx, v, ref[v], f.refunded === v)).join('')}</select>`;
  }
  if (state.tab === 'calls') {
    const ql = { ANY: 'Qualified or not', YES: 'Qualified', NO: 'Not qualified' };
    const names = [...state.qualStages];
    if (f.stage && !names.includes(f.stage)) names.push(f.stage);
    return `
      <select data-crm-filter="qualified" aria-label="Qualified">${QUALIFIED.map((v) => option(ctx, v, ql[v], f.qualified === v)).join('')}</select>
      <select data-crm-filter="stage" aria-label="Qualification stage">${option(ctx, '', 'All qualification stages', !f.stage)}${names.map((n) => option(ctx, n, n, f.stage === n)).join('')}</select>`;
  }
  return `<select data-crm-filter="status" aria-label="Status">${option(ctx, '', 'All statuses', !f.status)}${SUBSCRIPTION_STATES.map((v) => option(ctx, v, v, f.status === v)).join('')}</select>`;
}

function chipCounts(ctx, range, model) {
  const counts = {};
  for (const t of TABS) {
    if (range.error) counts[t.key] = null;
    else if (t.key === state.tab) counts[t.key] = headline(model);
    else counts[t.key] = knownCount(ctx.data, t.key, range, state.filters[t.key], state.search);
  }
  return counts;
}

function visibleRows(model) {
  let rows = model?.list?.rows || [];
  if (state.tab === 'leads' && state.attr !== 'all') {
    rows = rows.filter((r) => (state.attr === 'with' ? r.hasAttribution : !r.hasAttribution));
  }
  return sortRows(rows, state.sort[state.tab]);
}

function bodyHtml(ctx, range, model, loading) {
  const tab = state.tab;
  const label = TAB_BY_KEY[tab].label;
  if (range.error) return '';
  if (model?.listError) {
    return `<div class="note err"><b>${ctx.esc(label)} could not load.</b> ${ctx.esc(model.listError)}
      <button type="button" class="crm-retry" data-crm-retry>Retry</button></div>`;
  }
  if (!model?.list) {
    return loading ? `<div class="empty">Loading ${ctx.esc(tab)}…</div>` : '';
  }
  const rows = visibleRows(model);
  const all = model.list.rows.length;
  const notes = [];
  if (tab === 'leads' && state.attr !== 'all') {
    notes.push(`<div class="note">Source filter applied on the ${ctx.esc(ctx.fmt.int(all))} rows shown${model.list.truncated ? ', the newest of the range only' : ''}; the tiles count the whole range.</div>`);
  }
  const title = `<h2 class="section">${ctx.esc(label)} <span class="rowcount">${ctx.esc(countText(ctx, tab, model, rows.length))}</span></h2>`;
  if (!rows.length) {
    const filtered = Object.keys(filterParams(tab, state.filters[tab], state.search)).length || (tab === 'leads' && state.attr !== 'all');
    const why = all && !filtered ? 'No row matches.' : `No ${tab} ${VERBS[tab]} between ${ctx.fmt.date(`${range.start}T12:00:00`)} and ${ctx.fmt.date(`${range.end}T12:00:00`)}${filtered ? ' with these filters' : ''}.`;
    return `${notes.join('')}${title}<div class="empty">${ctx.esc(why)}</div>`;
  }
  return `${notes.join('')}${title}${tableHtml(ctx, tab, rows, state.sort[tab])}`;
}

/** Keep the caret in the field the user was typing in across a repaint. */
function focusedKeep(el) {
  const a = el.ownerDocument?.activeElement;
  if (!a || !el.contains(a) || !a.dataset?.crmKeep) return null;
  let start = null;
  let end = null;
  try { start = a.selectionStart; end = a.selectionEnd; } catch { /* date inputs have no selection */ }
  return { keep: a.dataset.crmKeep, start, end };
}

function paint(ctx, { range, model = null, stages = [], loading = false, today = '' }) {
  const el = host(ctx.root);
  last = { ctx, range, model, stages, today };
  const focus = focusedKeep(el);
  const tab = state.tab;

  const notes = [];
  if (range.error) notes.push(`<div class="note err"><b>Pick another range.</b> ${ctx.esc(range.error)}</div>`);
  if (model?.aggErrors?.length) {
    notes.push(`<div class="note err"><b>Some totals could not load.</b> ${model.aggErrors.map((e) => ctx.esc(`${e.name}: ${e.message}`)).join('; ')}</div>`);
  }
  const shortSearch = state.search.trim() && !emailParam(state.search);

  el.innerHTML = `
    <div class="controls crm-controls">${tabsHtml(ctx, tab, chipCounts(ctx, range, model))}</div>
    <div class="controls crm-controls">
      ${rangeControls(ctx, today)}
      <input type="search" data-crm-search data-crm-keep="search" placeholder="Email starts with…" value="${ctx.esc(state.search)}" aria-label="Email search">
      ${tabControls(ctx, stages)}
      ${shortSearch ? '<span class="sub crm-hint">type at least 3 characters</span>' : ''}
    </div>
    ${notes.join('')}
    ${range.error ? '' : tilesHtml(ctx, tab, model, { range, filters: state.filters })}
    ${bodyHtml(ctx, range, model, loading)}`;

  wire(ctx, el);
  if (focus) {
    const target = el.querySelector(`[data-crm-keep="${focus.keep}"]`);
    if (target) {
      target.focus();
      try { if (focus.start !== null) target.setSelectionRange(focus.start, focus.end); } catch { /* not a text field */ }
    }
  }
}

function repaint() {
  if (last) paint(last.ctx, last);
}

function wire(ctx, el) {
  el.querySelectorAll('[data-crm-tab]').forEach((b) => b.addEventListener('click', () => {
    if (state.tab === b.dataset.crmTab) return;
    state.tab = b.dataset.crmTab;
    run(ctx);
  }));
  el.querySelectorAll('[data-crm-range]').forEach((b) => b.addEventListener('click', () => {
    const key = b.dataset.crmRange;
    if (state.rangeKey === key) return;
    if (key === 'custom' && !state.custom.start && last?.range && !last.range.error) {
      state.custom = { start: last.range.start, end: last.range.end };
    }
    state.rangeKey = key;
    run(ctx);
  }));
  const from = el.querySelector('[data-crm-from]');
  const to = el.querySelector('[data-crm-to]');
  const onDate = () => {
    state.custom = { start: from?.value || '', end: to?.value || '' };
    run(ctx);
  };
  from?.addEventListener('change', onDate);
  to?.addEventListener('change', onDate);

  const search = el.querySelector('[data-crm-search]');
  search?.addEventListener('input', () => {
    const before = JSON.stringify(emailParam(state.search));
    state.search = search.value;
    clearTimeout(searchTimer);
    if (JSON.stringify(emailParam(state.search)) === before) return;
    searchTimer = setTimeout(() => run(ctx), SEARCH_DEBOUNCE_MS);
  });

  el.querySelectorAll('[data-crm-filter]').forEach((input) => input.addEventListener('change', () => {
    const f = state.filters[state.tab];
    const name = input.dataset.crmFilter;
    if (f[name] === input.value) return;
    f[name] = input.value;
    run(ctx);
  }));
  el.querySelector('[data-crm-attr]')?.addEventListener('change', (e) => {
    state.attr = e.target.value;
    repaint();
  });
  el.querySelectorAll('th[data-col]').forEach((th) => th.addEventListener('click', () => {
    state.sort[state.tab] = nextSort(state.sort[state.tab], th.dataset.col, 'desc');
    repaint();
  }));
  el.querySelectorAll('button.drill[data-email]').forEach((b) => b.addEventListener('click', () => {
    openLeadJourney(ctx, b.dataset.email);
  }));
  el.querySelector('[data-crm-retry]')?.addEventListener('click', () => run(ctx));
}

/** One load of the active sub-tab, painted as it arrives. Resolves after the last paint. */
async function run(ctx) {
  const mine = ++renderSeq;
  // A tab switch takes the root out of the page: stop calling for a view nobody sees.
  const live = () => mine === renderSeq && ctx.root.isConnected !== false;
  clearTimeout(searchTimer);
  const deadline = Date.now() + VIEW_LOAD_MS - DEADLINE_MARGIN_MS;

  let tz = null;
  try {
    tz = (await ctx.data.account())?.timezone || null;
  } catch (err) {
    if (live()) host(ctx.root).innerHTML = `<div class="note err"><b>The account could not load.</b> ${ctx.esc(message(err))}</div>`;
    return;
  }
  const now = ctx.data.now();
  const today = ymdInTz(now, tz);
  const range = resolveRange(state.rangeKey, state.custom, now, tz);
  if (!live()) return;
  if (range.error) { paint(ctx, { range, today }); return; }

  let stages = [];
  if (state.tab === 'leads') {
    try { stages = await ctx.data.stages(); } catch { stages = []; }
    if (!Array.isArray(stages)) stages = Array.isArray(stages?.result) ? stages.result : [];
    if (!live()) return;
  }
  paint(ctx, { range, stages, loading: true, today });

  const tab = state.tab;
  const model = await loadTab(ctx.data, {
    tab, range, tz, now, filters: state.filters[tab], search: state.search, deadline,
    isLive: live,
    onStep: (m) => paint(ctx, { range, model: m, stages, loading: true, today }),
  });
  if (!live()) return;
  if (tab === 'calls' && model.aggs.qualification) {
    state.qualStages = [...new Set([...state.qualStages, ...model.aggs.qualification.groups.map((g) => g.key).filter(Boolean)])];
  }
  paint(ctx, { range, model, stages, loading: false, today });
}

export const view = {
  id: 'crm',
  title: 'CRM',
  version: '0.1.0',
  description: 'Who joined, bought, booked or subscribed in a date range, where they came from, and each lead\'s journey.',
  style: true,
  tools: [
    'hyros_get_user_info', 'hyros_get_stages',
    'hyros_get_leads', 'hyros_get_leads_aggregation',
    'hyros_get_sales', 'hyros_get_sales_aggregation',
    'hyros_get_calls', 'hyros_get_calls_aggregation',
    'hyros_get_subscriptions',
    'hyros_get_lead_journey', 'hyros_get_lead_clicks',
  ],
  author: 'HYROS',

  render(ctx) {
    return run(ctx);
  },
};
