import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createData } from '../src/data/data.js';
import { buildLevels, REPORT_FIELDS } from '../src/data/report-levels.js';
import { aggregate, DEFAULT_KEYS } from '../src/data/metrics.js';
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

/**
 * The real data API (cached/peek semantics included) over a fake MCP client
 * that records every call, its concurrency, and honours `deadline` between
 * pages like src/core/mcp.js does.
 */
function setup({ report = () => [], sources = (ids) => ids.map((id) => src(id)), clock = () => Date.now() } = {}) {
  const calls = [];
  let running = 0;
  let maxRunning = 0;
  const mcp = {
    callTool: async (name) => {
      if (name === 'hyros_get_user_info') return { userProfile: { timezone: TZ } };
      throw new Error(`unexpected ${name}`);
    },
    callToolPaged: async () => [],
    callToolPagedInfo: async (name, args, opts) => {
      if (opts?.deadline && clock() >= opts.deadline) return { rows: [], pages: 0, truncated: true, error: 'time budget' };
      calls.push({ name, args, opts });
      running += 1;
      maxRunning = Math.max(maxRunning, running);
      await new Promise((r) => setImmediate(r));
      running -= 1;
      if (name === 'hyros_get_attribution_report') {
        const out = report(args.request.ids[0], args.request, calls.length);
        if (out instanceof Error) throw out;
        return Array.isArray(out) ? { rows: out, pages: 1, truncated: false } : out;
      }
      if (name === 'hyros_get_sources') {
        const out = sources(args.request.adSourceIds);
        if (out instanceof Error) throw out;
        return Array.isArray(out) ? { rows: out, pages: 1, truncated: false } : out;
      }
      if (name === 'hyros_get_ad_accounts') return { rows: [FB, GG, G2, RD], pages: 1, truncated: false };
      throw new Error(`unexpected ${name}`);
    },
  };
  const data = createData({ mcp, now: () => NOW });
  return { data, calls, get maxRunning() { return maxRunning; }, reports: () => calls.filter((c) => c.name === 'hyros_get_attribution_report') };
}

const src = (id, extra = {}) => ({
  name: `src ${id}`, tag: `@t${id}`, category: { name: `cat-${id.slice(-1)}` }, trafficSource: { name: 'facebook' },
  adSource: { adSourceId: id, adAccountId: 101 }, ...extra,
});
const row = (id, extra = {}) => ({ id, name: `set ${id}`, cost: 10, totalRevenue: 30, revenue: 30, leads: 2, sales: 1, ...extra });

const base = { kind: 'adset', model: 'LAST_CLICK', window: 0, range: RANGE, tz: TZ, now: NOW };
const far = () => Date.now() + 100000;

test('every ad-account type maps to its level; types without one are set apart', () => {
  const p = partitionAccounts([FB, GG, G2, RD]);
  assert.deepEqual(p.adset.map((a) => a.id), ['101', '202', '303']);
  assert.deepEqual(p.ad.map((a) => a.id), ['101', '202']);
  assert.deepEqual(p.noAdLevel.map((a) => a.id), ['303']);
  assert.deepEqual(p.unsupported.map((a) => a.id), ['404']);
});

test('the attribution request is exact, and the window is sent only for LAST_CLICK above 0', () => {
  const req = reportRequest({ model: 'LAST_CLICK', window: 7, start: RANGE.start, end: RANGE.end, tz: TZ, now: NOW, level: 'FACEBOOK_ADSET', adAccountId: 101 });
  assert.deepEqual(req, {
    attributionModel: 'LAST_CLICK',
    startDate: '2026-09-15T00:00:00-05:00',
    endDate: '2026-10-14T10:30:00-05:00',
    level: 'FACEBOOK_ADSET',
    ids: ['101'],
    isAdAccountId: true,
    timeGroupingOption: 'SOURCE_LINK',
    newestFirst: true,
    sourceConfiguration: 'ALL_SOURCES',
    reportSourceVisibility: true,
    fields: REPORT_FIELDS,
    windowAttributionDaysRange: 7,
  });
  assert.equal('windowAttributionDaysRange' in reportRequest({ ...req, model: 'FIRST_CLICK', window: 7, start: RANGE.start, end: RANGE.end, tz: TZ, now: NOW }), false);
  assert.equal('windowAttributionDaysRange' in reportRequest({ model: 'LAST_CLICK', window: 0, start: RANGE.start, end: RANGE.end, tz: TZ, now: NOW, level: 'X', adAccountId: 1 }), false);
  assert.equal(sentWindow('LAST_CLICK', 400), 0);
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
    report: (id) => (id === '202' ? new Error('integration disconnected') : [row(`${id}-1`, { _account: 'bogus' }), row(`${id}-2`)]),
  });
  const out = await loadAccounts(env.data, { ...base, accounts: [FB, GG, G2], deadline: far() });
  assert.equal(env.maxRunning, 1);
  assert.deepEqual(env.reports().map((c) => c.args.request.level), ['FACEBOOK_ADSET', 'GOOGLE_CAMPAIGN', 'GOOGLE_V2_ADGROUP']);
  assert.ok(env.reports().every((c) => c.opts.maxPages === MAX_PAGES && c.opts.pageSize === PAGE_SIZE && c.opts.timeoutMs <= 15000));
  assert.deepEqual(out.rows.map((r) => r._account), ['101', '101', '303', '303']);
  assert.deepEqual(out.failed.map((f) => [f.account.id, f.message]), [['202', 'integration disconnected']]);
  assert.equal(out.loaded.length, 2);
});

test('the deadline stops the loop; skipped accounts are not cached and load on the next render', async () => {
  let t = 0;
  const clock = () => t;
  const env = setup({ clock, report: (id) => { t = 50; return [row(`${id}-1`)]; } });
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
  const env = setup({ report: (id) => (n++ === 0 ? { rows: [row(`${id}-1`)], pages: 1, truncated: true, error: 'time budget' } : [row(`${id}-1`), row(`${id}-2`)]) });
  const a = await loadAccounts(env.data, { ...base, accounts: [FB], deadline: far() });
  assert.deepEqual(a.cut.map((c) => [c.account.id, c.count, c.reason]), [['101', 1, 'time budget']]);
  assert.equal(a.rows.length, 1);
  const b = await loadAccounts(env.data, { ...base, accounts: [FB], deadline: far() });
  assert.equal(b.rows.length, 2);
  assert.equal(env.reports().length, 2);
});

test('the whole ad-set load is stored for Scale only when complete, and then a render makes no call', async () => {
  const env = setup({ report: (id) => [row(`${id}1`)] });
  const supported = [FB, GG];
  const key = 'report:LAST_CLICK:0:2026-09-15:2026-10-14:adset';
  const memo = new Map();

  await loadReport(env.data, { ...base, selected: [FB], supported, memo, deadline: far() });
  assert.equal(env.data.peek(key), undefined, 'a partial selection is not the whole load');

  await loadReport(env.data, { ...base, selected: [GG], supported, memo, deadline: far() });
  const whole = await env.data.peek(key);
  assert.deepEqual(whole.adsetRows.map((r) => [r.id, r.cost, r._account]), [['1011', 10, '101'], ['2021', 10, '202']]);

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
  const env = setup({ report: (id) => (id === '202' ? new Error('nope') : [row(`${id}1`)]) });
  await loadReport(env.data, { ...base, selected: [FB, GG], supported: [FB, GG], memo: new Map(), deadline: far() });
  assert.equal(env.data.peek('report:LAST_CLICK:0:2026-09-15:2026-10-14:adset'), undefined);
});

test('a newer render stops the older loop before its next call', async () => {
  let current = true;
  const env = setup({ report: (id) => { current = false; return [row(`${id}1`)]; } });
  const out = await loadReport(env.data, { ...base, selected: [FB, GG, G2], supported: [FB, GG, G2], memo: new Map(), deadline: far(), isCurrent: () => current });
  assert.equal(out.stale, true);
  assert.equal(env.reports().length, 1);
  assert.equal(env.calls.some((c) => c.name === 'hyros_get_sources'), false);
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
  const batches = env.calls.map((c) => c.args.request);
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
