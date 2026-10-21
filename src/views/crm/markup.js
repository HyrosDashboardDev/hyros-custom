/**
 * The CRM's HTML: tiles, the sub-tab chips and the four tables. Pure string
 * builders over `ctx = { fmt, esc, kpis }`; every HYROS string goes through
 * `esc`, every number and amount through `fmt`. Columns ported from hyros-ai
 * `public/app.js` (CRM), without Income.
 */
import { sortHeader } from '../../ui/table.js';
import { TABS } from './filters.js';
import { inSomeGroup, groupCount } from './rows.js';

/** The USD revenue tile of the Sales sub-tab (HYROS stable price, sales with a first source). Set false to drop it. */
export const SHOW_USD_REVENUE = true;

const DASH = '<span class="sub">-</span>';

function clip(ctx, text, size = 'm', extra = '') {
  return text ? `<span class="clip clip-${size}" title="${ctx.esc(text)}">${ctx.esc(text)}</span>${extra}` : DASH;
}

const emailCell = (ctx, email) => (email
  ? `<td class="txt"><button type="button" class="drill clip clip-l" title="${ctx.esc(email)}" data-email="${ctx.esc(email)}">${ctx.esc(email)}</button></td>`
  : `<td class="txt">${DASH}</td>`);

const txt = (html) => `<td class="txt">${html}</td>`;
const pill = (ctx, text, cls = '') => (text ? `<span class="pill${cls ? ` ${cls}` : ''}">${ctx.esc(text)}</span>` : DASH);

const callStateCls = (st) => (st === 'QUALIFIED' ? 'stage' : st === 'NO_SHOW' || st === 'CANCELLED' ? 'warn' : '');

/** Columns per sub-tab: `col` is the row field the header sorts by. */
export const COLUMNS = {
  leads: [
    { col: 'joinedMs', label: 'Joined', cls: 'txt', cell: (r, c) => txt(c.esc(c.fmt.date(r.joined))) },
    { col: 'email', label: 'Lead', cls: 'txt', cell: (r, c) => emailCell(c, r.email) },
    { col: 'name', label: 'Name', cls: 'txt', cell: (r, c) => txt(clip(c, r.name)) },
    { col: 'firstSourceName', label: 'First source', cls: 'txt',
      cell: (r, c) => txt(clip(c, r.firstSourceName, 's', r.firstSource?.organic ? ' <span class="pill">org</span>' : '')) },
    { col: 'lastSourceName', label: 'Last source', cls: 'txt',
      cell: (r, c) => txt(clip(c, r.lastSourceName, 's', r.lastSource?.organic ? ' <span class="pill">org</span>' : '')) },
    { col: 'lastSourceMs', label: 'Last source date', cls: 'txt', cell: (r, c) => txt(c.esc(c.fmt.date(r.lastSourceDate))) },
    { col: 'stage', label: 'Stage', cls: 'txt', cell: (r, c) => txt(pill(c, r.stage, 'stage')) },
    { col: 'consent', label: 'Ad O.C.', cls: 'txt', title: 'Ad optimization consent', cell: (r, c) => txt(r.consent ? c.esc(r.consent) : DASH) },
    { col: 'tagList', label: 'Tags', cls: 'txt', cell: (r, c) => txt(clip(c, r.tagList, 'l')) },
  ],
  sales: [
    { col: 'dateMs', label: 'Date', cls: 'txt', cell: (r, c) => txt(c.esc(c.fmt.datetime(r.date))) },
    { col: 'email', label: 'Lead', cls: 'txt', cell: (r, c) => emailCell(c, r.email) },
    { col: 'leadName', label: 'Name', cls: 'txt', cell: (r, c) => txt(clip(c, r.leadName)) },
    { col: 'product', label: 'Product', cls: 'txt', cell: (r, c) => txt(clip(c, r.product, 's')) },
    { col: 'amount', label: 'Amount', cell: (r, c) => `<td class="good">${c.esc(c.fmt.moneyIn(r.amount, r.currency))}</td>` },
    { col: 'currency', label: 'Currency', cls: 'txt', cell: (r, c) => txt(c.esc(c.fmt.currencyCode(r.currency || c.fmt.currency))) },
    { col: 'firstSource', label: 'First source', cls: 'txt', cell: (r, c) => txt(clip(c, r.firstSource, 's')) },
    { col: 'lastSource', label: 'Last source', cls: 'txt', cell: (r, c) => txt(clip(c, r.lastSource, 's')) },
    { col: 'recurring', label: 'Recurring', cls: 'txt', cell: (r) => txt(r.recurring ? 'Yes' : DASH) },
    { col: 'refunded', label: 'Refunded', cls: 'txt', cell: (r) => txt(r.refunded ? '<span class="pill warn">refunded</span>' : DASH) },
  ],
  calls: [
    { col: 'dateMs', label: 'Date', cls: 'txt', cell: (r, c) => txt(c.esc(c.fmt.datetime(r.date))) },
    { col: 'email', label: 'Lead', cls: 'txt', cell: (r, c) => emailCell(c, r.email) },
    { col: 'leadName', label: 'Name', cls: 'txt', cell: (r, c) => txt(clip(c, r.leadName)) },
    { col: 'name', label: 'Call', cls: 'txt', cell: (r, c) => txt(clip(c, r.name, 's')) },
    { col: 'state', label: 'State', cls: 'txt', cell: (r, c) => txt(pill(c, r.state, callStateCls(r.state))) },
    { col: 'firstSource', label: 'First source', cls: 'txt', cell: (r, c) => txt(clip(c, r.firstSource, 's')) },
    { col: 'ad', label: 'Ad', cls: 'txt', cell: (r, c) => txt(clip(c, r.ad, 's')) },
    { col: 'lastSource', label: 'Last source', cls: 'txt', cell: (r, c) => txt(clip(c, r.lastSource, 's')) },
  ],
  subscriptions: [
    { col: 'dateMs', label: 'Start', cls: 'txt', cell: (r, c) => txt(c.esc(c.fmt.date(r.date))) },
    { col: 'email', label: 'Lead', cls: 'txt', cell: (r, c) => emailCell(c, r.email) },
    { col: 'name', label: 'Name', cls: 'txt', cell: (r, c) => txt(clip(c, r.name)) },
    { col: 'price', label: 'Price', cell: (r, c) => `<td>${c.esc(c.fmt.moneyIn(r.price, r.currency))}</td>` },
    { col: 'periodicity', label: 'Period', cls: 'txt', cell: (r, c) => txt(r.periodicity ? c.esc(r.periodicity) : DASH) },
    { col: 'status', label: 'Status', cls: 'txt', cell: (r, c) => txt(pill(c, r.status, r.status === 'ACTIVE' ? 'stage' : '')) },
    { col: 'provider', label: 'Provider', cls: 'txt', cell: (r, c) => txt(r.provider ? c.esc(r.provider) : DASH) },
  ],
};

/** Newest first: the date column of every sub-tab. */
export const DEFAULT_SORT = {
  leads: { col: 'joinedMs', dir: 'desc' },
  sales: { col: 'dateMs', dir: 'desc' },
  calls: { col: 'dateMs', dir: 'desc' },
  subscriptions: { col: 'dateMs', dir: 'desc' },
};

/** `<table class="dense">` for already sorted rows. */
export function tableHtml(ctx, tab, rows, sort) {
  const cols = COLUMNS[tab];
  const head = cols.map((c) => sortHeader({ col: c.col, label: c.label, cls: c.cls || '', title: c.title || '' }, sort)).join('');
  const body = rows.map((r) => `<tr>${cols.map((c) => c.cell(r, ctx)).join('')}</tr>`).join('');
  return `<div class="table-wrap"><table class="dense crm-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

/** The sub-tab chips; `counts[tab] = { count, plus } | null` ("?" when not loaded). */
export function tabsHtml(ctx, active, counts) {
  return `<div class="chipset crm-tabs" role="tablist">${TABS.map((t) => {
    const c = counts[t.key];
    const text = c ? `${ctx.fmt.int(c.count)}${c.plus ? '+' : ''}` : '?';
    return `<button type="button" class="chip${t.key === active ? ' active' : ''}" data-crm-tab="${t.key}" role="tab" aria-selected="${t.key === active}">${t.label} <span class="chip-count">${ctx.esc(text)}</span></button>`;
  }).join('')}</div>`;
}

const pct = (part, whole) => (Number.isFinite(part) && whole ? `${Math.round((part / whole) * 100)}% of the range` : '');
const inAccount = (fmt) => (r) => !r.currency || fmt.currencyCode(r.currency) === fmt.currency;

/**
 * The tiles of `tab`. Aggregation figures read `totalCount`, never a sum of
 * groups, except "with a first source" (one first source per row, so the
 * groups plus `remainingCount` count each row once). A failed aggregation
 * prints "-".
 */
export function tilesHtml(ctx, tab, model, { range, filters } = {}) {
  const { fmt } = ctx;
  const a = model?.aggs || {};
  const int = (v) => (v === null || v === undefined ? '-' : fmt.int(v));
  const rows = model?.list?.rows || [];
  const plus = model?.list?.truncated ? '+' : '';
  let items;

  if (tab === 'leads') {
    const total = a.stage?.total ?? null;
    const sourced = inSomeGroup(a.firstSource);
    items = [
      { label: 'Leads', value: int(total), sub: 'joined in the range', cls: 'hy' },
      { label: 'With a first source', value: int(sourced), sub: pct(sourced, a.firstSource?.total) },
      { label: 'Customers', value: int(groupCount(a.stage, 'Customer')), sub: 'current stage Customer' },
    ];
  } else if (tab === 'sales') {
    const sourced = inSomeGroup(a.firstSource);
    const own = rows.filter(inAccount(fmt));
    const foreign = rows.length - own.length;
    const shown = own.reduce((s, r) => s + (r.amount || 0), 0);
    items = [
      { label: 'Sales', value: int(a.firstSource?.total ?? null), sub: 'made in the range', cls: 'hy' },
      { label: 'With a first source', value: int(sourced), sub: pct(sourced, a.firstSource?.total) },
    ];
    if (SHOW_USD_REVENUE) {
      const usd = a.firstSource?.revenueUsd;
      items.push({
        label: 'Revenue (USD, HYROS stable price)',
        value: usd === null || usd === undefined ? '-' : `${fmt.moneyIn(usd, 'USD')}${a.firstSource.remaining ? '+' : ''}`,
        sub: 'sales with a first source only',
      });
    }
    items.push({
      label: 'Revenue in rows',
      value: model?.list ? `${fmt.money(shown)}${plus}` : '-',
      sub: model?.list ? `${fmt.int(rows.length)} rows${plus ? ', newest only' : ''}${foreign ? `, ${fmt.int(foreign)} in other currencies not summed` : ''}` : '',
      cls: shown ? 'good' : '',
    });
  } else if (tab === 'calls') {
    const total = a.qualification?.total ?? null;
    const q = filters?.calls?.qualified;
    const qualified = q === 'YES' ? total : q === 'NO' ? (total === null ? null : 0) : (a.qualified?.total ?? null);
    items = [
      { label: 'Calls', value: int(total), sub: 'booked in the range', cls: 'hy' },
      { label: 'Qualified', value: int(qualified), sub: pct(qualified, total) },
      { label: 'With a qualification stage', value: int(inSomeGroup(a.qualification)) },
    ];
  } else {
    const active = rows.filter((r) => r.status === 'ACTIVE' || r.status === 'TRIALING');
    const value = active.filter(inAccount(fmt)).reduce((s, r) => s + (r.price || 0), 0);
    const loaded = Boolean(model?.list);
    items = [
      { label: 'Subscriptions', value: loaded ? `${fmt.int(rows.length)}${plus}` : '-', sub: 'started in the range', cls: 'hy' },
      { label: 'Active or trialing', value: loaded ? `${fmt.int(active.length)}${plus}` : '-' },
      { label: 'Canceled', value: loaded ? `${fmt.int(rows.filter((r) => r.status === 'CANCELED').length)}${plus}` : '-' },
      { label: 'Active value', value: loaded ? `${fmt.money(value)}${plus}` : '-', sub: 'sum of active plan prices, account currency' },
    ];
  }

  const html = ctx.kpis(items);
  const line = range ? `<div class="kpi-range">${ctx.esc(range.label)}: ${ctx.esc(fmt.date(range.start))} to ${ctx.esc(fmt.date(range.end))}</div>` : '';
  return html.replace('<div class="kpis">', `<div class="kpis">${line}`);
}

/** "1,200 leads, showing newest 2,000" style text for the section title. */
export function countText(ctx, tab, model, shown) {
  const { fmt } = ctx;
  const list = model?.list;
  if (!list) return '';
  const n = list.rows.length;
  const total = tab === 'leads' ? model.aggs.stage?.total : tab === 'sales' ? model.aggs.firstSource?.total
    : tab === 'calls' ? model.aggs.qualification?.total : null;
  let text;
  if (list.truncated) {
    text = `${total != null ? fmt.int(total) : `${fmt.int(n)}+`} ${tab}, showing newest ${fmt.int(n)}`;
    if (list.error) text += ` (${list.error})`;
  } else {
    text = `${fmt.int(n)} ${tab}`;
  }
  if (shown !== n) text = `${fmt.int(shown)} of ${text}`;
  return text;
}
