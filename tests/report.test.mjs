import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createData } from '../src/data/data.js';
import { buildLevels, normalizeRow, wireKey, REPORT_FIELDS, LEVELS_BY_TYPE } from '../src/data/report-levels.js';
import { aggregate, CATALOG, DEFAULT_KEYS } from '../src/data/metrics.js';
import { toQuery } from '../src/core/api.js';
import { fmt } from '../src/ui/fmt.js';
import { esc } from '../src/ui/dom.js';
import {
  cacheKey, accountKey, sentWindow, validateCustom, resolveRange, partitionAccounts, reportRequest,
  loadAccounts, loadReport, joinSources, createSerial, rangeLabel, MAX_PAGES, PAGE_SIZE,
} from '../src/views/report/load.js';
import {
  levelRows, enrichAds, filterRows, rowDrillTags, drillTags, readCols, writeCols, usableCols, colPanelHtml, COLS_KEY, toneClass,
} from '../src/views/report/columns.js';
import { notesHtml, tableHtml } from '../src/views/report/view.js';

const NOW = new Date('2026-10-14T15:30:00Z');
const TZ = '-05:00';
const RANGE = { start: '2026-09-15', end: '2026-10-14' };
const ctx = { fmt, esc };

const FB = { id: '101', name: 'Meta main', type: 'FACEBOOK' };
const GG = { id: '202', name: 'Google <b>', type: 'GOOGLE' };
const G2 = { id: '303', name: 'Google v2', type: 'GOOGLE_V2' };
const RD = { id: '404', name: 'Reddit', type: 'REDDIT' };
const TW = { id: '505', name: 'Twitter', type: 'TWITTER' };
const LI = { id: '606', name: 'LinkedIn', type: 'LINKEDIN' };

/**
 * The real data API (cached/peek semantics included) over a fake API client
 * keyed on REST paths that records every call (flat params), its concurrency,
 * and honours `deadline` between pages like src/core/api.js does.
 */
function setup({ report = () => [], sources = (ids) => ids.map((id) => src(id)), clock = () => Date.now() } = {}) {
  const calls = [];
  let running = 0;
  let maxRunning = 0;
  const api = {
    get: async (path) => {
      if (path === '/user-info') return { result: { userProfile: { timezone: TZ } } };
      throw new Error(`unexpected ${path}`);
    },
    getPaged: async () => [],
    getPagedInfo: async (path, params, opts) => {
      if (opts?.deadline && clock() >= opts.deadline) return { rows: [], pages: 0, truncated: true, error: 'time budget' };
      calls.push({ path, params, opts });
      running += 1;
      maxRunning = Math.max(maxRunning, running);
      await new Promise((r) => setImmediate(r));
      running -= 1;
      if (path === '/attribution') {
        const out = report(params.ids[0], params, calls.length);
        if (out instanceof Error) throw out;
        return Array.isArray(out) ? { rows: out, pages: 1, truncated: false } : out;
      }
      if (path === '/sources') {
        const out = sources(params.adSourceIds);
        if (out instanceof Error) throw out;
        return Array.isArray(out) ? { rows: out, pages: 1, truncated: false } : out;
      }
      if (path === '/ad-accounts') return { rows: [FB, GG, G2, RD], pages: 1, truncated: false };
      throw new Error(`unexpected ${path}`);
    },
  };
  const data = createData({ api, now: () => NOW });
  return { data, calls, get maxRunning() { return maxRunning; }, reports: () => calls.filter((c) => c.path === '/attribution') };
}

const src = (id, extra = {}) => ({
  name: `src ${id}`, tag: `@t${id}`, category: { name: `cat-${id.slice(-1)}` }, trafficSource: { name: 'facebook' },
  adSource: { adSourceId: id, adAccountId: 101 }, ...extra,
});
/** A normalised row, as buildLevels and the table see it. */
const row = (id, extra = {}) => ({ id, name: `set ${id}`, cost: 10, totalRevenue: 30, revenue: 30, leads: 2, sales: 1, ...extra });
/** The same row as GET /attribution publishes it: snake_case keys, `revenue` as a string. */
const wire = (id, extra = {}) => ({ id, name: `set ${id}`, cost: 10, total_revenue: 30, revenue: '30.00', leads: 2, sales: 1, ...extra });

const base = { kind: 'adset', model: 'LAST_CLICK', window: 0, range: RANGE, tz: TZ, now: NOW };
const far = () => Date.now() + 100000;

test('every ad-account type maps to its levels; types without one are set apart', () => {
  const p = partitionAccounts([FB, GG, G2, TW, LI, RD]);
  assert.deepEqual(p.adset.map((a) => a.id), ['101', '202', '303', '505', '606']);
  assert.deepEqual(p.ad.map((a) => a.id), ['101', '202', '303', '505', '606']);
  assert.deepEqual(p.noAdLevel, []);
  assert.deepEqual(p.unsupported.map((a) => a.id), ['404']);
});

test('the attribution request is exact, flat, in the API spelling, and the window is sent only for LAST_CLICK above 0', () => {
  const req = reportRequest({ model: 'LAST_CLICK', window: 7, start: RANGE.start, end: RANGE.end, tz: TZ, now: NOW, level: 'facebook_adset', adAccountId: 101 });
  assert.deepEqual(req, {
    attributionModel: 'last_click',
    startDate: '2026-09-15T00:00:00-05:00',
    endDate: '2026-10-14T10:30:00-05:00',
    level: 'facebook_adset',
    ids: ['101'],
    isAdAccountId: true,
    timeGroupingOption: 'source_link',
    newestFirst: true,
    sourceConfiguration: 'all_sources',
    reportSourceVisibility: true,
    fields: REPORT_FIELDS,
    windowAttributionDaysRange: 7,
  });
  assert.equal(reportRequest({ ...base, model: 'FIRST_CLICK', start: RANGE.start, end: RANGE.end, level: 'x', adAccountId: 1 }).attributionModel, 'first_click');
  assert.equal(reportRequest({ ...base, model: 'SCIENTIFIC', start: RANGE.start, end: RANGE.end, level: 'x', adAccountId: 1 }).attributionModel, 'scientific');
  assert.equal('windowAttributionDaysRange' in reportRequest({ ...req, model: 'FIRST_CLICK', window: 7, start: RANGE.start, end: RANGE.end, tz: TZ, now: NOW }), false);
  assert.equal('windowAttributionDaysRange' in reportRequest({ model: 'LAST_CLICK', window: 0, start: RANGE.start, end: RANGE.end, tz: TZ, now: NOW, level: 'X', adAccountId: 1 }), false);
  assert.equal(sentWindow('LAST_CLICK', 400), 0);

  // The query the client sends: one comma-separated `fields`, dates without milliseconds.
  const q = new URLSearchParams(toQuery(req));
  assert.equal(q.get('fields').split(',')[0], 'name');
  assert.equal(q.get('fields').split(',').length, REPORT_FIELDS.length);
  assert.equal(q.get('ids'), '101');
  assert.equal(q.get('isAdAccountId'), 'true');
  assert.match(q.get('startDate'), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[-+]\d{2}:\d{2}$/);
});

test('levels are the lowercase API names, snapchat_adsquad included', () => {
  for (const levels of Object.values(LEVELS_BY_TYPE)) {
    for (const level of Object.values(levels)) if (level) assert.match(level, /^[a-z0-9_]+$/);
  }
  assert.equal(LEVELS_BY_TYPE.SNAPCHAT.adset, 'snapchat_adsquad');
});

// The SOURCE_LINK_AD level of each platform, copied from the backend
// (AdspendAttributionLevelType): every platform the report covers has one.
const API_AD_LEVELS = {
  FACEBOOK: 'facebook_ad', GOOGLE: 'google_ad', GOOGLE_V2: 'google_v2_ad', TIKTOK: 'tiktok_ad', SNAPCHAT: 'snapchat_ad',
  PINTEREST: 'pinterest_ad', TWITTER: 'twitter_ad', BING: 'bing_ad', LINKEDIN: 'linkedin_ad',
};

test('every type asks for the ad level the API has for its platform', () => {
  assert.deepEqual(Object.fromEntries(Object.entries(LEVELS_BY_TYPE).map(([type, levels]) => [type, levels.ad])), API_AD_LEVELS);
});

test('Google V2, Twitter and LinkedIn ads load at their ad level and join to their ad set through parent_id', async () => {
  const env = setup({ report: (id) => [wire(`${id}-ad`, { parent_id: Number(`${id}0`), parent_name: null })] });
  const memo = new Map();
  const out = await loadReport(env.data, { ...base, kind: 'ad', selected: [G2, TW, LI], supported: [G2, TW, LI], memo, deadline: far() });
  assert.deepEqual(env.reports().map((c) => c.params.level), ['google_v2_ad', 'twitter_ad', 'linkedin_ad']);
  assert.deepEqual(env.calls.filter((c) => c.path === '/sources').map((c) => c.params.adSourceIds), [['3030', '5050', '6060']]);
  const ads = enrichAds(out.rows, memo);
  assert.deepEqual(ads.map((a) => [a.id, a._account, a._adset, a._parentSet, a.tag]), [
    ['303-ad', '303', '3030', 'src 3030', '@t3030'],
    ['505-ad', '505', '5050', 'src 5050', '@t5050'],
    ['606-ad', '606', '6060', 'src 6060', '@t6060'],
  ]);
  assert.deepEqual(levelRows({ level: 'ad', ads, path: [{ level: 'adset', id: '6060' }] }).map((a) => a.id), ['606-ad']);
});

// `fields` values GET /attribution accepts (AttributionField api names) and the
// keys its marshaller publishes rows under, copied from the backend.
const API_FIELDS = new Set(['sales', 'calls', 'qualified_calls', 'unqualified_calls', 'cost_per_call', 'cost_per_qualified_call', 'cost_per_sale', 'leads',
  'leads_optins', 'cost_per_lead', 'total_revenue', 'revenue', 'recurring_revenue', 'profit', 'contribution_profit', 'new_leads', 'cost_per_new_lead', 'roi', 'roas',
  'refund', 'refund_count', 'refund_sales_percentage', 'refunded_sales_percentage', 'refund_revenue_percentage', 'refunded_revenue_percentage', 'unique_sales',
  'cost_per_unique_sale', 'cost_per_unique_sales', 'cost', 'cost_per_unique_customer', 'time_of_sale_attribution', 'time_of_call_attribution', 'unique_customers',
  'new_customers_percentage', 'recurring_customers_percentage', 'unique_customers_revenue', 'returning_customers', 'returning_customers_rate',
  'returning_customers_revenue', 'returning_customers_revenue_rate', 'new_customers_roas', 'new_customers_aov', 'new_customers_orders', 'net_profit',
  'contribution_margin', 'hard_costs', 'new_subscriptions', 'canceled_subscriptions', 'direct_subscriptions', 'arr', 'mrr', 'new_mrr', 'new_trials',
  'converted_trials', 'canceled_trials', 'cost_per_new_subscriptions', 'cost_per_new_trials', 'clicks', 'new_visits', 'cost_per_new_visit', 'cost_per_click',
  'reported', 'reported_result', 'shop_reported_result', 'reported_vs_revenue', 'recurring_customers', 'total_customers', 'customers', 'ctr', 'cpm', 'cvr',
  'impressions', 'gross_margins', 'partial_video_views', 'unique_calls', 'canceled_calls', 'no_show_calls', 'cost_per_unique_call', 'net_profit_percentage',
  'taxes', 'cost_of_goods', 'shipping_value', '30_days_ltv', '60_days_ltv', '90_days_ltv', '6_months_ltv', '1_year_ltv', '30_days_ltv_forecast',
  '60_days_ltv_forecast', '90_days_ltv_forecast', '6_months_ltv_forecast', '1_year_ltv_forecast', 'churn_rate', 'one_time_sales',
  'subscription_30_days_forecast', 'subscription_60_days_forecast', 'subscription_90_days_forecast', 'subscription_6_months_forecast',
  'subscription_1_year_forecast', 'cac', 'carts', 'atc_events', 'purchased_carts', 'atc_cvr', 'atc_rate', 'cost_per_atc', 'aov', 'name', 'parent_name']);
const API_ROW_KEYS = new Set(['id', 'ad_source_id', 'sales', 'calls', 'unique_sales', 'refund', 'leads', 'new_leads', 'leads_optins', 'revenue',
  'recurring_revenue', 'total_revenue', 'profit', 'contributionProfit', 'cost', 'roi', 'roas', 'qualified_calls', 'unqualified_calls',
  'cost_per_qualified_call', 'time_of_call_attribution_avg', 'time_of_conversion_attribution_avg', 'average_order_value', 'refund_count',
  'refunded_revenue_percentage', 'refunded_sales_percentage', 'cost_per_call', 'cost_per_lead', 'cost_per_sale', 'cost_per_new_lead', 'cost_per_unique_sales',
  'unique_customers', 'cost_per_unique_customer', 'unique_customers_revenue', 'returning_customers', 'returning_customers_rate', 'returning_customers_revenue',
  'returning_customers_revenue_rate', 'new_customers_roas', 'new_customers_aov', 'new_customers_orders', 'net_profit', 'contribution_margin', 'hard_costs',
  'start_date', 'end_date', 'new_subscriptions', 'canceled_subscriptions', 'direct_subscriptions', 'arr', 'mrr', 'new_m_r_r', 'new_trials', 'converted_trials',
  'canceled_trials', 'cost_per_new_subscriptions', 'cost_per_new_trials', 'clicks', 'new_visits', 'cost_per_new_visit', 'cost_per_click', 'reported',
  'reported_result', 'shop_reported_result', 'reported_vs_revenue', 'customers', 'ctr', 'cpm', 'cvr', 'impressions', 'recurring_customers', 'total_customers',
  'new_customers_percentage', 'recurring_customers_percentage', 'gross_margins', 'partial_video_views', 'unique_calls', 'canceled_calls',
  'cost_per_unique_call', 'net_profit_percentage', 'cac', 'taxes', 'cost_of_goods', 'shipping_value', 'ltv_30_days', 'ltv_60_days', 'ltv_90_days',
  'ltv_6_months', 'ltv_1_year', 'ltv_forecast_30_days', 'ltv_forecast_60_days', 'ltv_forecast_90_days', 'ltv_forecast_6_months', 'ltv_forecast_1_year',
  'churn_rate', 'subscription_30_days_forecast', 'subscription_60_days_forecast', 'subscription_90_days_forecast', 'subscription_6_months_forecast',
  'subscription_1_year_forecast', 'one_time_sales', 'carts', 'atc_events', 'purchased_carts', 'no_show_calls', 'atc_cvr', 'atc_rate', 'cost_per_atc',
  'campaign_id', 'ad_group_id', 'name', 'parent_id', 'parent_name']);

test('every requested field is an API field name and every catalog metric has a published row key', () => {
  for (const f of REPORT_FIELDS) assert.ok(API_FIELDS.has(f), `fields value ${f}`);
  assert.equal(REPORT_FIELDS.some((f) => /ltv/.test(f)), false, 'LTV fields are never requested');
  for (const c of CATALOG) assert.ok(API_ROW_KEYS.has(wireKey(c.k)), `${c.k} reads ${wireKey(c.k)}`);
  assert.equal(wireKey('reported'), 'reported_result');
  assert.equal(wireKey('contributionProfit'), 'contributionProfit');
  assert.equal(wireKey('newMRR'), 'new_m_r_r');
  assert.equal(wireKey('ltv30Days'), 'ltv_30_days');
  assert.equal(wireKey('subscription6MonthsForecast'), 'subscription_6_months_forecast');
});

test('normalizeRow reads the published row: snake_case keys, string revenue, null as not computed', () => {
  const r = normalizeRow({
    id: 77, name: 'Ad', parent_name: 'Set', parent_id: 55, cost: 100, revenue: '997.50', total_revenue: 1200, reported_result: 400,
    cost_per_lead: 12.5, new_m_r_r: 30, contributionProfit: 80, average_order_value: 99.75, atc_cvr: '2.5', ltv_30_days: null, cac: null, leads: 8,
  });
  assert.equal(r.id, '77');
  assert.equal(r.parentName, 'Set');
  assert.equal(r.parentId, '55');
  assert.equal(r.revenue, 997.5);
  assert.equal(r.totalRevenue, 1200);
  assert.equal(r.reported, 400);
  assert.equal(r.costPerLead, 12.5);
  assert.equal(r.newMRR, 30);
  assert.equal(r.contributionProfit, 80);
  assert.equal(r.averageOrderValue, 99.75);
  assert.equal(r.atcCvr, 2.5);
  assert.equal('ltv30Days' in r, false, 'null stays not computed');
  assert.equal('cac' in r, false);
  assert.equal(r.reportedVsRevenue, 597.5);
  assert.equal(r.profit, 1100);
  assert.equal(r.roas, 12);
  assert.equal(r.sales, 0, 'the core base exists even when absent');
  assert.equal(normalizeRow({ id: 1 }).parentId, null);
});

test('cache keys: window 0 when not sent, kind last; the account key sits under it', () => {
  assert.equal(cacheKey({ model: 'LAST_CLICK', window: 0, ...RANGE, kind: 'adset' }), 'report:LAST_CLICK:0:2026-09-15:2026-10-14:adset');
  assert.equal(cacheKey({ model: 'FIRST_CLICK', window: 14, ...RANGE, kind: 'ad' }), 'report:FIRST_CLICK:0:2026-09-15:2026-10-14:ad');
  assert.equal(cacheKey({ model: 'LAST_CLICK', window: 14, ...RANGE, kind: 'adset' }), 'report:LAST_CLICK:14:2026-09-15:2026-10-14:adset');
  assert.equal(accountKey('report:x', '101'), 'report:x:acct:101');
});

test('custom range: end after today, start after end and missing dates are refused', () => {
  assert.match(validateCustom('2026-10-01', '2026-10-15', '2026-10-14'), /after today/);
  assert.match(validateCustom('2026-10-10', '2026-10-01', '2026-10-14'), /on or before/);
  assert.match(validateCustom('', '2026-10-01', '2026-10-14'), /Pick/);
  assert.match(validateCustom('2026-02-30', '2026-03-01', '2026-10-14'), /Pick/);
  assert.equal(validateCustom('2026-03-01', '2026-10-14', '2026-10-14'), null);
  // "today" is the account's: at 02:00 UTC it is still the 13th at -05:00.
  const early = new Date('2026-10-14T02:00:00Z');
  assert.match(resolveRange('custom', { start: '2026-10-01', end: '2026-10-14' }, early, TZ).error, /2026-10-13/);
  assert.deepEqual(resolveRange('30d', null, NOW, TZ), { key: '30d', label: 'Last 30 days', ...RANGE });
  assert.equal(rangeLabel({ start: '2026-09-01', end: '2026-09-30' }), 'Sep 1, 2026 to Sep 30, 2026');
});

test('accounts load in series, _account comes from the call, and a failing account does not sink the rest', async () => {
  const env = setup({
    report: (id) => (id === '202' ? new Error('integration disconnected') : [wire(`${id}-1`, { _account: 'bogus' }), wire(`${id}-2`)]),
  });
  const out = await loadAccounts(env.data, { ...base, accounts: [FB, GG, G2], deadline: far() });
  assert.equal(env.maxRunning, 1);
  assert.deepEqual(env.reports().map((c) => c.params.level), ['facebook_adset', 'google_campaign', 'google_v2_adgroup']);
  assert.ok(env.reports().every((c) => c.params.attributionModel === 'last_click' && c.params.sourceConfiguration === 'all_sources' && !('request' in c.params)));
  assert.ok(env.reports().every((c) => c.opts.maxPages === MAX_PAGES && c.opts.pageSize === PAGE_SIZE && c.opts.timeoutMs <= 15000));
  assert.deepEqual(out.rows.map((r) => r._account), ['101', '101', '303', '303']);
  assert.deepEqual(out.failed.map((f) => [f.account.id, f.message]), [['202', 'integration disconnected']]);
  assert.equal(out.loaded.length, 2);
});

test('the deadline stops the loop; skipped accounts are not cached and load on the next render', async () => {
  let t = 0;
  const clock = () => t;
  const env = setup({ clock, report: (id) => { t = 50; return [wire(`${id}-1`)]; } });
  const opts = { ...base, deadline: 40, clock };
  const first = await loadAccounts(env.data, { ...opts, accounts: [FB, GG, G2] });
  assert.equal(env.reports().length, 1);
  assert.deepEqual(first.skipped.map((a) => a.id), ['202', '303']);

  t = 0;
  const second = await loadAccounts(env.data, { ...opts, deadline: 1000, accounts: [FB, GG, G2] });
  assert.equal(env.reports().length, 3, 'the cached account is not asked again');
  assert.equal(second.skipped.length, 0);
});

test('a load cut between pages shows its rows but is never cached', async () => {
  let n = 0;
  const env = setup({ report: (id) => (n++ === 0 ? { rows: [wire(`${id}-1`)], pages: 1, truncated: true, error: 'time budget' } : [wire(`${id}-1`), wire(`${id}-2`)]) });
  const a = await loadAccounts(env.data, { ...base, accounts: [FB], deadline: far() });
  assert.deepEqual(a.cut.map((c) => [c.account.id, c.count, c.reason]), [['101', 1, 'time budget']]);
  assert.equal(a.rows.length, 1);
  const b = await loadAccounts(env.data, { ...base, accounts: [FB], deadline: far() });
  assert.equal(b.rows.length, 2);
  assert.equal(env.reports().length, 2);
});

test('the whole ad-set load is stored for Scale only when complete, and then a render makes no call', async () => {
  const env = setup({ report: (id) => [wire(`${id}1`)] });
  const supported = [FB, GG];
  const key = 'report:LAST_CLICK:0:2026-09-15:2026-10-14:adset';
  const memo = new Map();

  await loadReport(env.data, { ...base, selected: [FB], supported, memo, deadline: far() });
  assert.equal(env.data.peek(key), undefined, 'a partial selection is not the whole load');

  await loadReport(env.data, { ...base, selected: [GG], supported, memo, deadline: far() });
  const whole = await env.data.peek(key);
  assert.deepEqual(whole.adsetRows.map((r) => [r.id, r.cost, r.revenue, r.totalRevenue, r._account]), [['1011', 10, 30, 30, '101'], ['2021', 10, 30, 30, '202']]);

  const before = env.calls.length;
  const again = await loadReport(env.data, { ...base, selected: supported, supported, memo, deadline: far() });
  assert.equal(env.calls.length, before);
  assert.equal(again.fromCache, true);
  assert.equal(again.rows.length, 2);
});

test('ad sets HYROS returns no source for are counted and named in a note', async () => {
  const env = setup({ report: (id) => [row(`${id}1`), row(`${id}2`)], sources: (ids) => ids.slice(0, 1).map((id) => src(id)) });
  const out = await loadReport(env.data, { ...base, selected: [FB], supported: [FB], memo: new Map(), deadline: far() });
  assert.equal(out.join.sourceless, 1);
  assert.equal(out.join.unjoined, 0);
  const notes = notesHtml(ctx, { ...out, unsupported: [], noAdLevel: [] });
  assert.match(notes, /HYROS has no source for 1 ad sets\.<\/b> They group under Uncategorised/);
});

test('a failed account keeps the whole load out of the cache', async () => {
  const env = setup({ report: (id) => (id === '202' ? new Error('nope') : [wire(`${id}1`)]) });
  await loadReport(env.data, { ...base, selected: [FB, GG], supported: [FB, GG], memo: new Map(), deadline: far() });
  assert.equal(env.data.peek('report:LAST_CLICK:0:2026-09-15:2026-10-14:adset'), undefined);
});

test('a newer render stops the older loop before its next call', async () => {
  let current = true;
  const env = setup({ report: (id) => { current = false; return [wire(`${id}1`)]; } });
  const out = await loadReport(env.data, { ...base, selected: [FB, GG, G2], supported: [FB, GG, G2], memo: new Map(), deadline: far(), isCurrent: () => current });
  assert.equal(out.stale, true);
  assert.equal(env.reports().length, 1);
  assert.equal(env.calls.some((c) => c.path === '/sources'), false);
});

test('the serial queue makes a second render wait for the first one\'s call in flight', async () => {
  const serial = createSerial();
  const log = [];
  const slow = serial.run(async () => { log.push('a start'); await new Promise((r) => setTimeout(r, 5)); log.push('a end'); });
  const fast = serial.run(async () => { log.push('b start'); });
  await Promise.all([slow, fast]);
  assert.deepEqual(log, ['a start', 'a end', 'b start']);
});

test('the source join asks 50 ids per call in series, memoises, and remembers ids HYROS did not return', async () => {
  const ids = Array.from({ length: 120 }, (_, i) => `9${i}`);
  const env = setup({ sources: (batch) => batch.filter((id) => id !== '90').map((id) => src(id)) });
  const memo = new Map();
  const out = await joinSources(env.data, [...ids, ids[0], null], memo, { deadline: far() });
  assert.ok(env.calls.every((c) => c.path === '/sources'));
  const batches = env.calls.map((c) => c.params);
  assert.deepEqual(batches.map((r) => r.adSourceIds.length), [50, 50, 20]);
  assert.ok(batches.every((r) => r.includeOrganic === true && r.includeDisregarded === true));
  assert.equal(env.maxRunning, 1);
  assert.equal(out.failed.length, 0);
  assert.equal(memo.get('90'), null);
  assert.deepEqual(memo.get('91'), { name: 'src 91', tag: '@t91', category: 'cat-1', trafficSource: 'facebook', adAccountId: '101' });

  await joinSources(env.data, ids, memo, { deadline: far() });
  assert.equal(env.calls.length, 3, 'memoised ids are not asked again');
});

test('a failed join batch memoises nothing, so its rows stay uncategorised with drills off', async () => {
  const env = setup({ sources: () => new Error('sources down') });
  const memo = new Map();
  const out = await joinSources(env.data, ['1', '2'], memo, { deadline: far() });
  assert.deepEqual(out.failed, [{ count: 2, message: 'sources down' }]);
  assert.equal(memo.size, 0);
  const levels = buildLevels({ adsetRows: [row('1', { _account: '101' })], adRows: [], sourceById: memo, adAccountName: new Map() });
  assert.equal(levels.campaign[0].name, 'Uncategorised');
  assert.equal(rowDrillTags(levels.adset[0]), null);
  assert.equal(rowDrillTags(levels.campaign[0]), null);
});

test('rolled-up rows and totals are re-derived from sums, never averaged', () => {
  const memo = new Map([['1', { tag: '@a', category: 'C', trafficSource: 'fb' }], ['2', { tag: '@b', category: 'C', trafficSource: 'fb' }]]);
  const adsetRows = [row('1', { cost: 100, totalRevenue: 300, revenue: 300, _account: '101' }), row('2', { cost: 300, totalRevenue: 300, revenue: 300, _account: '202' })];
  const { adset } = buildLevels({ adsetRows, adRows: [], sourceById: memo, adAccountName: new Map() });
  const [campaign] = levelRows({ level: 'campaign', adsets: adset });
  assert.equal(campaign.roas, 1.5);           // 600 / 400, not the mean of 3 and 1
  assert.deepEqual(campaign.tags, ['@a', '@b']);
  assert.equal(aggregate([campaign]).roas, 1.5);
  const only = levelRows({ level: 'campaign', adsets: adset, accounts: new Set(['202']) });
  assert.equal(only[0].roas, 1);
  assert.deepEqual(only[0].tags, ['@b']);
});

test('a rolled-up drill sends the tags of the ad sets behind the clicked column, biggest first', () => {
  // 49 ad sets in one account; only the last 5 have sales.
  const ids = Array.from({ length: 49 }, (_, i) => String(i + 1));
  const memo = new Map(ids.map((id) => [id, { tag: `@t${id}`, category: 'C', trafficSource: 'fb', adAccountId: '101' }]));
  const sales = { 45: 1, 46: 3, 47: 2, 48: 1, 49: 3 };
  const adsetRows = ids.map((id) => row(id, { sales: sales[id] || 0, leads: 1, calls: 0 }));
  const { adset } = buildLevels({ adsetRows, adRows: [], sourceById: memo, adAccountName: new Map() });
  const [account] = levelRows({ level: 'account', adsets: adset });

  assert.equal(account.sales, 10);
  assert.equal(account.tags.length, 49);
  assert.deepEqual(drillTags(account, 'sales'), ['@t46', '@t49', '@t47', '@t45', '@t48']);
  assert.equal(drillTags(account, 'leads').length, 49);
  // No tagged ad set has calls: every tag, as before.
  assert.equal(drillTags(account, 'calls').length, 49);
  assert.deepEqual(drillTags(adset[0], 'sales'), ['@t1']);
  assert.equal(drillTags({ id: 'x' }, 'sales'), null);
});

test('ads drill with their parent ad set tag and follow the crumbs through their parent', () => {
  const memo = new Map([['S1', { name: 'Set one', tag: '@s1', category: 'C1', trafficSource: 'fb' }]]);
  const ads = enrichAds([
    { id: 'A1', name: 'Ad 1', parentId: 'S1', cost: 5, _account: '101' },
    { id: 'A2', name: null, parentId: 'S9', cost: 0, _account: '101' },
  ], memo);
  assert.deepEqual(rowDrillTags(ads[0]), ['@s1']);
  assert.equal(ads[0]._parentSet, 'Set one');
  assert.equal(ads[1].name, 'A2');
  assert.equal(rowDrillTags(ads[1]), null);
  assert.deepEqual(levelRows({ level: 'ad', ads, path: [{ level: 'campaign', id: 'C1' }] }).map((a) => a.id), ['A1']);
  assert.deepEqual(levelRows({ level: 'ad', ads, path: [{ level: 'adset', id: 'S9' }] }).map((a) => a.id), ['A2']);
  assert.deepEqual(filterRows(ads, { hideZero: true }).map((a) => a.id), ['A1']);
  assert.deepEqual(filterRows(ads, { search: 'ad 1' }).map((a) => a.id), ['A1']);
});

test('columns: saved sets drop unknown and switched-off keys, storage failures fall back', () => {
  const store = new Map();
  const fake = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) };
  assert.deepEqual(readCols(fake), DEFAULT_KEYS);
  writeCols(['cost', 'ltv30Days', 'nope', 'cost', 'roas'], fake);
  assert.deepEqual(readCols(fake), ['cost', 'roas']);
  assert.equal(usableCols(['ltv30Days']), null);
  writeCols(null, fake);
  assert.equal(store.has(COLS_KEY), false);
  const broken = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  assert.deepEqual(readCols(broken), DEFAULT_KEYS);
  assert.doesNotThrow(() => writeCols(['cost'], broken));
  assert.match(colPanelHtml(['cost'], 'ltv', esc), /disabled/);
  assert.equal(toneClass({ tone: true }, -1), 'bad');
});

test('HYROS strings are escaped in the table and the notes', () => {
  const evil = '<img src=x onerror=1>';
  const cols = [{ k: 'cost', l: 'Cost', t: 'money' }, { k: 'leads', l: 'Leads', t: 'int' }, { k: 'roas', l: 'ROAS', t: 'ratio' }];
  const html = tableHtml(ctx, [{ id: '1', name: evil, parentName: evil, cost: 1, leads: 3, roas: 2, tag: '@x' }], cols);
  assert.equal(html.includes('<img'), false);
  assert.match(html, /&lt;img src=x onerror=1&gt;/);
  assert.match(html, /class="drill"/);
  assert.match(html, /<td class="hy">2\.00<\/td>/);

  const notes = notesHtml(ctx, {
    kind: 'adset', unsupported: [{ id: '4', name: evil, type: 'REDDIT' }], noAdLevel: [],
    failed: [{ account: { id: '2', name: evil }, message: evil }], skipped: [{ id: '3', name: evil }],
    cut: [], capped: [{ account: { id: '1', name: evil }, count: 2000 }], join: { failed: [{ message: evil }], unjoined: 4 },
  });
  assert.equal(notes.includes('<img'), false);
  assert.match(notes, /class="note err"/);
  assert.match(notes, /skipped: time budget/);
  assert.match(notes, /Showing newest 2,000 ad sets of/);
});
