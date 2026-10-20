/**
 * The CRM's controls turned into tool parameters, and its date range. Pure:
 * no DOM, no calls. Parameter names and enum values are the ones of the MCP
 * request DTOs (GetLeadsRequest, GetSalesRequest, GetCallsRequest,
 * GetSubscriptionsRequest and their *AggregationRequest siblings); a filter a
 * DTO does not have is never sent.
 */
import { buildRanges } from '../../data/report-levels.js';
import { ymdInTz, dayStart, dayEnd } from '../../core/dates.js';

export const TABS = [
  { key: 'leads', label: 'Leads', tool: 'hyros_get_leads' },
  { key: 'sales', label: 'Sales', tool: 'hyros_get_sales' },
  { key: 'calls', label: 'Calls', tool: 'hyros_get_calls' },
  { key: 'subscriptions', label: 'Subscriptions', tool: 'hyros_get_subscriptions' },
];
export const TAB_BY_KEY = Object.fromEntries(TABS.map((t) => [t.key, t]));

export const RANGE_KEYS = ['today', 'yesterday', '7d', '30d', 'custom'];

/** Shortest email prefix sent as a filter: one or two letters match half the account. */
export const MIN_SEARCH = 3;
/** The array filters take at most 50 values. */
export const MAX_VALUES = 50;

export const RECURRING = ['ALL', 'RECURRING', 'NON_RECURRING'];
export const REFUNDED = ['ALL', 'REFUNDED', 'NON_REFUNDED'];
export const SUBSCRIPTION_STATES = ['ACTIVE', 'TRIALING', 'CANCELED', 'PAST_DUE', 'INCOMPLETE',
  'INCOMPLETE_EXPIRED', 'UNPAID', 'COMPLETED', 'PAUSED', 'UNKNOWN'];
export const QUALIFIED = ['ANY', 'YES', 'NO'];

/** Every filter at rest: nothing is sent. */
export function defaultFilters() {
  return {
    leads: { stage: '', tags: '' },
    sales: { recurring: 'ALL', refunded: 'ALL' },
    calls: { qualified: 'ANY', stage: '' },
    subscriptions: { status: '' },
  };
}

/** `emails: [prefix]` for a search of at least MIN_SEARCH characters, else null. */
export function emailParam(text) {
  const t = String(text ?? '').trim().toLowerCase();
  return t.length >= MIN_SEARCH ? [t] : null;
}

const tagList = (text) => [...new Set(String(text ?? '').split(/[,\n]/).map((s) => s.trim()).filter(Boolean))];

/** Comma or newline separated tag names: trimmed, deduplicated, at most 50. */
export function parseTags(text) {
  return tagList(text).slice(0, MAX_VALUES);
}

/** How many typed tags parseTags leaves out past the 50 cap, so the controls can say so. */
export const droppedTags = (text) => Math.max(0, tagList(text).length - MAX_VALUES);

/**
 * The filter parameters of `tab` (no dates, no paging). The same object goes
 * on the list and on the tab's aggregations: every one of these parameters
 * exists on both DTOs.
 */
export function filterParams(tab, filters = {}, search = '') {
  const f = filters || {};
  const out = {};
  const emails = emailParam(search);
  if (emails) out.emails = emails;
  if (tab === 'leads') {
    if (f.stage) out.stage = [String(f.stage)];
    const tags = parseTags(f.tags);
    if (tags.length) out.tags = tags;
  } else if (tab === 'sales') {
    if (RECURRING.includes(f.recurring) && f.recurring !== 'ALL') out.isRecurringSale = f.recurring;
    if (REFUNDED.includes(f.refunded) && f.refunded !== 'ALL') out.saleRefundedState = f.refunded;
  } else if (tab === 'calls') {
    if (f.qualified === 'YES') out.qualified = true;
    if (f.qualified === 'NO') out.qualified = false;
    if (f.stage) out.qualificationStages = [String(f.stage)];
  } else if (tab === 'subscriptions') {
    if (SUBSCRIPTION_STATES.includes(f.status)) out.subscriptionStates = [f.status];
  }
  return out;
}

/** `{ fromDate, toDate }` for a resolved range; `toDate` never passes `now`. */
export function dateParams({ start, end }, tz, now) {
  return { fromDate: dayStart(start, tz), toDate: dayEnd(end, tz, now) };
}

/** The list request of `tab`: `{ request: { fromDate, toDate, ...filters } }` (pagedInfo adds pageSize). */
export function listArgs(tab, range, tz, now, filters, search) {
  return { request: { ...dateParams(range, tz, now), ...filterParams(tab, filters, search) } };
}

/** How many groups an aggregation returns: the cap, so the sums miss as little as possible. */
export const GROUPS_LIMIT = 1000;

/**
 * The aggregation calls of `tab`, in the order they run:
 * `[{ name, tool, args }]`. Subscriptions have no aggregation tool.
 * Calls: CALL_QUALIFICATION groups are stage names that do not say which
 * stage is "qualified", so a second call with `qualified: true` reads that
 * total; it is skipped when the qualified filter already decides it.
 */
export function aggregationCalls(tab, range, tz, now, filters, search) {
  const base = { ...dateParams(range, tz, now), ...filterParams(tab, filters, search), groupsLimit: GROUPS_LIMIT };
  const make = (name, tool, extra) => ({ name, tool, args: { request: { ...base, ...extra } } });
  if (tab === 'leads') {
    return [
      make('stage', 'hyros_get_leads_aggregation', { attribute: 'STAGE' }),
      make('firstSource', 'hyros_get_leads_aggregation', { attribute: 'FIRST_SOURCE_TAG' }),
    ];
  }
  if (tab === 'sales') return [make('firstSource', 'hyros_get_sales_aggregation', { attribute: 'FIRST_SOURCE_TAG' })];
  if (tab === 'calls') {
    const out = [make('qualification', 'hyros_get_calls_aggregation', { attribute: 'CALL_QUALIFICATION' })];
    if (base.qualified === undefined) out.push(make('qualified', 'hyros_get_calls_aggregation', { attribute: 'CALL_QUALIFICATION', qualified: true }));
    return out;
  }
  return [];
}

/** A stable text for the filters of `tab`, part of its cache key. */
export function filtersKey(tab, filters, search) {
  const p = filterParams(tab, filters, search);
  return JSON.stringify(Object.keys(p).sort().map((k) => [k, p[k]]));
}

/** `crm:<tab>:<start>:<end>:<filters>`: the prefix of every cache key of one load. */
export function baseKey(tab, range, filters, search) {
  return `crm:${tab}:${range.start}:${range.end}:${filtersKey(tab, filters, search)}`;
}

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;
const validYmd = (s) => YMD_RE.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`))
  && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;

/** null when the custom range is usable, else the sentence that says why not. */
export function customRangeError(start, end, today) {
  if (!start || !end) return 'Pick a start and an end date.';
  if (!validYmd(start) || !validYmd(end)) return 'Dates must be real calendar days (YYYY-MM-DD).';
  if (end > today) return `The end date cannot be after today (${today} in the account timezone).`;
  if (start > end) return 'The start date must be on or before the end date.';
  return null;
}

/**
 * The range a render loads: `{ key, label, start, end }` or `{ key, error }`.
 * `custom = { start, end }` as typed in the date inputs.
 */
export function resolveRange(key, custom, now, tz) {
  const ranges = buildRanges(now, tz);
  if (key !== 'custom') {
    const r = ranges[key] || ranges['30d'];
    return { key: ranges[key] ? key : '30d', label: r.label, start: r.start, end: r.end };
  }
  const today = ymdInTz(now, tz);
  const error = customRangeError(custom?.start, custom?.end, today);
  if (error) return { key, error };
  return { key, label: 'Custom', start: custom.start, end: custom.end };
}
