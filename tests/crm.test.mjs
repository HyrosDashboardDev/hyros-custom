import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createData } from '../src/data/data.js';
import { fmt } from '../src/ui/fmt.js';
import { esc, kpis } from '../src/ui/dom.js';
import {
  filterParams, emailParam, parseTags, droppedTags, listArgs, aggregationCalls, resolveRange, customRangeError, baseKey, defaultFilters,
} from '../src/views/crm/filters.js';
import { shapeRows, readAggregation, inSomeGroup, groupCount } from '../src/views/crm/rows.js';
import { loadTab, knownCount, headline, LIST_MAX_PAGES, PAGE_SIZE } from '../src/views/crm/load.js';
import { tableHtml, tilesHtml, countText, tabsHtml } from '../src/views/crm/markup.js';
import { view } from '../src/views/crm/view.js';

const ctx = { fmt, esc, kpis };
const NOW = new Date('2026-09-15T17:30:00Z');
const TZ = '-05:00';
const RANGE = { key: '30d', label: 'Last 30 days', start: '2026-08-17', end: '2026-09-15' };

/** A stand-in for mcp.js under the real data API (so cached/peek behave as in the page). */
function fakeMcp({ agg = () => ({ groups: [], remainingCount: 0, totalCount: 0 }), list = () => ({ rows: [], pages: 1, truncated: false }), onCall } = {}) {
  const calls = [];
  const log = [];
  let running = 0;
  let maxRunning = 0;
  const track = async (name, args, opts, answer) => {
    calls.push({ name, args, opts });
    running += 1;
    maxRunning = Math.max(maxRunning, running);
    log.push(`start ${name}`);
    await new Promise((resolve) => setImmediate(resolve));
    running -= 1;
    log.push(`end ${name}`);
    onCall?.(name, args);
    return answer(name, args, opts);
  };
  return {
    calls,
    log,
    get maxRunning() { return maxRunning; },
    callTool: (name, args, opts) => track(name, args, opts, agg),
    callToolPagedInfo: (name, args, opts) => track(name, args, opts, list),
    callToolPaged: async () => [],
  };
}

const opts = (extra = {}) => ({ range: RANGE, tz: TZ, now: NOW, search: '', deadline: Date.now() + 100000, ...extra });

/* ---------------- filters ---------------- */

test('filters become the DTO parameters; ALL and ANY are not sent', () => {
  const f = defaultFilters();
  assert.deepEqual(filterParams('leads', f.leads), {});
  assert.deepEqual(filterParams('sales', f.sales), {});
  assert.deepEqual(filterParams('calls', f.calls), {});
  assert.deepEqual(filterParams('subscriptions', f.subscriptions), {});

  assert.deepEqual(filterParams('leads', { stage: 'Customer', tags: ' @a, @b ,@a,' }), { stage: ['Customer'], tags: ['@a', '@b'] });
  assert.deepEqual(filterParams('sales', { recurring: 'RECURRING', refunded: 'NON_REFUNDED' }), { isRecurringSale: 'RECURRING', saleRefundedState: 'NON_REFUNDED' });
  assert.deepEqual(filterParams('sales', { recurring: 'bogus', refunded: 'ALL' }), {});
  assert.deepEqual(filterParams('calls', { qualified: 'YES', stage: 'Booked' }), { qualified: true, qualificationStages: ['Booked'] });
  assert.deepEqual(filterParams('calls', { qualified: 'NO' }), { qualified: false });
  assert.deepEqual(filterParams('subscriptions', { status: 'PAST_DUE' }), { subscriptionStates: ['PAST_DUE'] });
  assert.deepEqual(filterParams('subscriptions', { status: 'DELETED' }), {});
});

test('emails is sent only for a search of at least 3 characters, trimmed and lower-cased', () => {
  assert.equal(emailParam(''), null);
  assert.equal(emailParam(' jo '), null);
  assert.deepEqual(emailParam(' JoH '), ['joh']);
  assert.deepEqual(filterParams('sales', {}, 'ab'), {});
  assert.deepEqual(filterParams('sales', {}, 'abc@'), { emails: ['abc@'] });
});

test('tags are capped at 50 and the ones left out are counted', () => {
  const text = Array.from({ length: 60 }, (_, i) => `t${i}`).join(',');
  assert.equal(parseTags(text).length, 50);
  assert.equal(droppedTags(`${text},t0`), 10);
  assert.equal(droppedTags('a, b'), 0);
});

test('list request: account-zone bounds, toDate never past now', () => {
  const today = { start: '2026-09-15', end: '2026-09-15' };
  assert.deepEqual(listArgs('leads', today, TZ, NOW, { stage: 'Lead' }, 'bob'), {
    request: { fromDate: '2026-09-15T00:00:00-05:00', toDate: '2026-09-15T12:30:00-05:00', emails: ['bob'], stage: ['Lead'] },
  });
  assert.equal(listArgs('sales', RANGE, TZ, NOW, {}, '').request.fromDate, '2026-08-17T00:00:00-05:00');
});

test('aggregations per sub-tab carry the same filters as the list', () => {
  const leads = aggregationCalls('leads', RANGE, TZ, NOW, { stage: 'Lead', tags: '' }, 'bob');
  assert.deepEqual(leads.map((a) => [a.tool, a.args.request.attribute]), [
    ['hyros_get_leads_aggregation', 'STAGE'], ['hyros_get_leads_aggregation', 'FIRST_SOURCE_TAG']]);
  assert.ok(leads.every((a) => a.args.request.groupsLimit === 1000 && a.args.request.stage[0] === 'Lead' && a.args.request.emails[0] === 'bob'));

  const sales = aggregationCalls('sales', RANGE, TZ, NOW, { recurring: 'RECURRING', refunded: 'ALL' }, '');
  assert.deepEqual(sales.map((a) => [a.tool, a.args.request.attribute, a.args.request.isRecurringSale]), [['hyros_get_sales_aggregation', 'FIRST_SOURCE_TAG', 'RECURRING']]);

  const calls = aggregationCalls('calls', RANGE, TZ, NOW, { qualified: 'ANY', stage: '' }, '');
  assert.deepEqual(calls.map((a) => [a.name, a.args.request.attribute, a.args.request.qualified]), [
    ['qualification', 'CALL_QUALIFICATION', undefined], ['qualified', 'CALL_QUALIFICATION', true]]);
  assert.equal(aggregationCalls('calls', RANGE, TZ, NOW, { qualified: 'NO' }, '').length, 1);
  assert.deepEqual(aggregationCalls('subscriptions', RANGE, TZ, NOW, {}, ''), []);
});

test('custom range: end <= today in the account zone, start <= end, real days', () => {
  assert.equal(customRangeError('', '2026-09-01', '2026-09-15') !== null, true);
  assert.match(customRangeError('2026-09-01', '2026-09-16', '2026-09-15'), /after today/);
  assert.match(customRangeError('2026-09-10', '2026-09-01', '2026-09-15'), /start date/);
  assert.match(customRangeError('2026-02-30', '2026-03-01', '2026-09-15'), /real calendar days/);
  assert.equal(customRangeError('2026-03-01', '2026-09-15', '2026-09-15'), null);
  // 23:30 at UTC-05:00 is already the 16th in UTC: today is the account's day.
  const late = new Date('2026-09-16T03:30:00Z');
  assert.ok(resolveRange('custom', { start: '2026-09-01', end: '2026-09-16' }, late, TZ).error);
  assert.deepEqual(resolveRange('custom', { start: '2026-09-01', end: '2026-09-15' }, late, TZ), { key: 'custom', label: 'Custom', start: '2026-09-01', end: '2026-09-15' });
  assert.equal(resolveRange('7d', null, NOW, TZ).start, '2026-09-09');
});

/* ---------------- rows ---------------- */

test('merged leads are dropped; sources flattened; attribution is client side', () => {
  const rows = shapeRows('leads', [
    { id: 'L1', email: 'a@x.test', firstName: 'Ann', creationDate: '2026-09-01T10:00:00-05:00',
      firstSource: { name: 'FB', tag: '@fb', organic: false, trafficSource: { name: 'Facebook' }, clickDate: 'Tue Sep 01 09:00:00 EDT 2026' },
      currentStage: { name: 'Customer' }, tags: ['@a', '@b'], adOptimizationConsent: 'UNSPECIFIED' },
    { id: 'L2', email: 'b@x.test', originLead: { id: 'L1' } },
    { id: 'L3', email: 'c@x.test', creationDate: '2026-09-02T10:00:00-05:00' },
  ], TZ);
  assert.deepEqual(rows.map((r) => r.id), ['L1', 'L3']);
  assert.equal(rows[0].firstSource.trafficSource, 'Facebook');
  assert.equal(rows[0].firstSource.clickDate, '2026-09-01T09:00:00-04:00');
  assert.equal(rows[0].hasAttribution, true);
  assert.equal(rows[0].consent, null);
  assert.equal(rows[0].tagList, '@a, @b');
  assert.equal(rows[1].hasAttribution, false);
  assert.equal(rows[0].joinedMs, Date.parse('2026-09-01T10:00:00-05:00'));
});

test('legacy dates on sales and subscriptions are parsed; unknown zones take the account offset', () => {
  const [sale] = shapeRows('sales', [{ id: 'S1', lead: { email: 'a@x.test', firstName: 'A' }, creationDate: '2026-09-01T10:00:00-05:00',
    refundDate: 'Wed Sep 02 10:00:00 XYZ 2026', price: { price: 12.5, currency: 'EUR' }, product: { name: 'P' }, recurring: true }], TZ);
  assert.equal(sale.refundDate, '2026-09-02T10:00:00-05:00');
  assert.equal(sale.refunded, true);
  assert.equal(sale.amount, 12.5);
  assert.equal(sale.currency, 'EUR');
  const [sub] = shapeRows('subscriptions', [{ subscriptionId: 'X', lead: { email: 'a@x.test' }, startDate: 'Thu Jul 02 01:10:33 UTC 2026',
    price: { price: 9 }, status: 'ACTIVE', provider: { integration: { name: 'Stripe' } } }], TZ);
  assert.equal(sub.date, '2026-07-02T01:10:33+00:00');
  assert.equal(sub.provider, 'Stripe');
  assert.equal(sub.id, 'X');
  const [call] = shapeRows('calls', [{ lead: { email: 'c@x.test' }, qualified: false, lastSource: { name: 'G', sourceLinkAd: { name: 'Ad 1' } } }], TZ);
  assert.equal(call.state, 'UNQUALIFIED');
  assert.equal(call.ad, 'Ad 1');
});

test('aggregation answers: totalCount is the total, groups plus remaining the rows with a value', () => {
  const agg = readAggregation({ groups: [{ key: 'Customer', count: 5 }, { key: 'Lead', count: '7' }], remainingCount: 3, totalCount: 20 });
  assert.equal(agg.total, 20);
  assert.equal(inSomeGroup(agg), 15);
  assert.equal(groupCount(agg, 'customer'), 5);
  assert.equal(groupCount(agg, 'Nope'), 0);
  const sales = readAggregation({ groups: [{ key: '@a', count: 1, details: { revenue: { amount: 10.5, currency: 'USD' } } }, { key: '@b', count: 1, details: { revenue: { amount: 4 } } }], totalCount: 9 });
  assert.equal(sales.revenueUsd, 14.5);
  assert.equal(readAggregation({ groups: [] }).revenueUsd, null);
  assert.equal(readAggregation(null).total, null);
});

/* ---------------- load ---------------- */

const leadAgg = (name, args) => (args.request.attribute === 'STAGE'
  ? { groups: [{ key: 'Customer', count: 4 }], remainingCount: 0, totalCount: 40 }
  : { groups: [{ key: '@fb', count: 20 }], remainingCount: 2, totalCount: 40 });

test('a load runs the aggregations then the list, one call at a time, with the list caps', async () => {
  const mcp = fakeMcp({ agg: leadAgg, list: () => ({ rows: [{ id: 'L1', email: 'a@x.test' }], pages: 1, truncated: false }) });
  const data = createData({ mcp, now: () => NOW });
  const model = await loadTab(data, { tab: 'leads', filters: defaultFilters().leads, ...opts() });
  assert.deepEqual(mcp.calls.map((c) => c.name), ['hyros_get_leads_aggregation', 'hyros_get_leads_aggregation', 'hyros_get_leads']);
  assert.equal(mcp.maxRunning, 1);
  const list = mcp.calls[2];
  assert.equal(list.opts.maxPages, LIST_MAX_PAGES);
  assert.equal(list.opts.pageSize, PAGE_SIZE);
  assert.ok(list.opts.timeoutMs <= 15000 && list.opts.deadline);
  assert.deepEqual(Object.keys(list.args.request), ['fromDate', 'toDate']);
  assert.equal(model.aggs.stage.total, 40);
  assert.equal(inSomeGroup(model.aggs.firstSource), 22);
  assert.deepEqual(headline(model), { count: 40, plus: false });
});

test('memo per sub-tab: the same load is free, another sub-tab calls only its own tools', async () => {
  const mcp = fakeMcp({ agg: leadAgg });
  const data = createData({ mcp, now: () => NOW });
  const f = defaultFilters();
  await loadTab(data, { tab: 'leads', filters: f.leads, ...opts() });
  const n = mcp.calls.length;
  await loadTab(data, { tab: 'leads', filters: f.leads, ...opts() });
  assert.equal(mcp.calls.length, n);
  await loadTab(data, { tab: 'subscriptions', filters: f.subscriptions, ...opts() });
  assert.deepEqual(mcp.calls.slice(n).map((c) => c.name), ['hyros_get_subscriptions']);
  // A different filter is a different key.
  await loadTab(data, { tab: 'leads', filters: { stage: 'Lead', tags: '' }, ...opts() });
  assert.equal(mcp.calls.length, n + 1 + 3);
  // The chip of a loaded sub-tab reads the memo, without a call.
  assert.deepEqual(knownCount(data, 'subscriptions', RANGE, f.subscriptions, ''), { count: 0, plus: false });
  assert.equal(knownCount(data, 'sales', RANGE, f.sales, ''), null);
  data.invalidate();
  assert.equal(knownCount(data, 'subscriptions', RANGE, f.subscriptions, ''), null);
});

test('a failed aggregation does not take the table down, and is tried again next time', async () => {
  let fail = true;
  const mcp = fakeMcp({
    agg: (name, args) => { if (fail && args.request.attribute === 'FIRST_SOURCE_TAG') throw new Error('boom'); return leadAgg(name, args); },
    list: () => ({ rows: [{ id: 'L1', email: 'a@x.test' }], pages: 1, truncated: false }),
  });
  const data = createData({ mcp, now: () => NOW });
  const model = await loadTab(data, { tab: 'leads', filters: defaultFilters().leads, ...opts() });
  assert.equal(model.list.rows.length, 1);
  assert.deepEqual(model.aggErrors, [{ name: 'firstSource', message: 'boom' }]);
  assert.equal(model.aggs.stage.total, 40);
  const html = tilesHtml(ctx, 'leads', model, { range: RANGE });
  assert.match(html, /With a first source<\/div>\s*<div class="kpi-value">-</);
  fail = false;
  const n = mcp.calls.length;
  const again = await loadTab(data, { tab: 'leads', filters: defaultFilters().leads, ...opts() });
  assert.deepEqual(mcp.calls.slice(n).map((c) => c.args.request.attribute), ['FIRST_SOURCE_TAG']);
  assert.equal(again.aggErrors.length, 0);
});

test('a failed list is listError and the tiles stay', async () => {
  const mcp = fakeMcp({ agg: () => ({ groups: [], totalCount: 3 }), list: () => { throw new Error('list down'); } });
  const data = createData({ mcp, now: () => NOW });
  const model = await loadTab(data, { tab: 'sales', filters: defaultFilters().sales, ...opts() });
  assert.equal(model.listError, 'list down');
  assert.equal(model.aggs.firstSource.total, 3);
});

test('a list cut by the time budget is shown once, then loaded again', async () => {
  let cut = true;
  const mcp = fakeMcp({ list: () => ({ rows: [{ id: 'S' }], pages: 1, truncated: true, error: cut ? 'time budget' : undefined }) });
  const data = createData({ mcp, now: () => NOW });
  const first = await loadTab(data, { tab: 'subscriptions', filters: {}, ...opts() });
  assert.equal(first.list.error, 'time budget');
  cut = false;
  await loadTab(data, { tab: 'subscriptions', filters: {}, ...opts() });
  const n = mcp.calls.length;
  await loadTab(data, { tab: 'subscriptions', filters: {}, ...opts() });
  assert.equal(n, 2);
  assert.equal(mcp.calls.length, 2, 'a page-cap truncation (no error) stays cached');
});

test('a newer render stops an older load before its next call', async () => {
  let current = true;
  const mcp = fakeMcp({ agg: leadAgg, onCall: () => { current = false; } });
  const data = createData({ mcp, now: () => NOW });
  const model = await loadTab(data, { tab: 'leads', filters: { stage: 'X', tags: '' }, ...opts(), isLive: () => current });
  assert.equal(mcp.calls.length, 1);
  assert.equal(model.stopped, 'stale');
  assert.equal(model.list, null);
});

test('past the deadline no call starts', async () => {
  const mcp = fakeMcp();
  const data = createData({ mcp, now: () => NOW });
  const model = await loadTab(data, { tab: 'calls', filters: defaultFilters().calls, ...opts({ deadline: Date.now() - 1 }) });
  assert.equal(mcp.calls.length, 0);
  assert.equal(model.stopped, 'time budget');
  assert.equal(model.listError, 'skipped: time budget');
  assert.equal(model.aggErrors.length, 2);
});

test('the calls tile reads qualified from the second aggregation, or from the filter', async () => {
  const mcp = fakeMcp({ agg: (name, args) => ({ groups: [{ key: 'Booked', count: 6 }], remainingCount: 0, totalCount: args.request.qualified ? 4 : 10 }) });
  const data = createData({ mcp, now: () => NOW });
  const model = await loadTab(data, { tab: 'calls', filters: defaultFilters().calls, ...opts() });
  const html = tilesHtml(ctx, 'calls', model, { range: RANGE, filters: defaultFilters() });
  assert.match(html, /Qualified<\/div>\s*<div class="kpi-value">4</);
  assert.match(html, /40% of the range/);
  const filters = { ...defaultFilters(), calls: { qualified: 'NO', stage: '' } };
  assert.match(tilesHtml(ctx, 'calls', model, { range: RANGE, filters }), /Qualified<\/div>\s*<div class="kpi-value">0</);
});

/* ---------------- markup ---------------- */

test('every HYROS string is escaped in the table, the tiles and the chips', () => {
  const evil = '<img src=x onerror=alert(1)>';
  const rows = shapeRows('leads', [{ id: 'L1', email: `${evil}@x.test`, firstName: evil, currentStage: { name: evil }, tags: [evil],
    firstSource: { name: evil, organic: true } }], TZ);
  const html = tableHtml(ctx, 'leads', rows, { col: 'joinedMs', dir: 'desc' });
  assert.ok(!html.includes('<img'));
  assert.match(html, /data-email="&lt;img/);
  assert.match(html, /class="pill">org</);
  const sales = shapeRows('sales', [{ lead: { email: 'a@x.test' }, product: { name: evil }, price: { price: 5, currency: evil } }], TZ);
  const salesHtml = tableHtml(ctx, 'sales', sales, { col: 'dateMs', dir: 'desc' });
  assert.ok(!salesHtml.includes('<img'));
  const model = { aggs: { firstSource: readAggregation({ groups: [], totalCount: 1 }) }, aggErrors: [], list: { rows: sales, truncated: false } };
  assert.ok(!tilesHtml(ctx, 'sales', model, { range: RANGE }).includes('<img'));
  assert.ok(tabsHtml(ctx, 'leads', { leads: { count: 3, plus: true } }).includes('3+'));
});

test('a cut list says how many exist and how many are shown', () => {
  const model = { aggs: { stage: { total: 5000 } }, list: { rows: Array.from({ length: 2000 }, () => ({})), truncated: true } };
  assert.equal(countText(ctx, 'leads', model, 2000), '5,000 leads, showing newest 2,000');
  assert.equal(countText(ctx, 'leads', model, 30), '30 of 5,000 leads, showing newest 2,000');
  const subs = { aggs: {}, list: { rows: [{}, {}], truncated: true, error: 'time budget' } };
  assert.equal(countText(ctx, 'subscriptions', subs, 2), '2+ subscriptions, showing newest 2 (time budget)');
});

test('cache keys hold the range and the filters', () => {
  assert.equal(baseKey('sales', RANGE, { recurring: 'ALL', refunded: 'REFUNDED' }, ''), 'crm:sales:2026-08-17:2026-09-15:[["saleRefundedState","REFUNDED"]]');
});

test('the view object honors the contract', () => {
  assert.equal(view.id, 'crm');
  assert.equal(typeof view.render, 'function');
  assert.equal(view.style, true);
});
