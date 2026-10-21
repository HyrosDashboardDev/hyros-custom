import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  loadCohort, loadRecords, loadCredited, loadJourney, renderCohort, renderRecords, renderCredited, renderJourney, priceOf, leadIncome,
} from '../src/ui/drill.js';
import { fmt } from '../src/ui/fmt.js';
import { esc } from '../src/ui/dom.js';
import { toQuery } from '../src/core/api.js';

const ctx = { fmt, esc };

/** A stand-in for ctx.data keyed on API paths (flat params), recording every call and the order calls started and ended. */
function fakeData({ leads = [], nextPageId = null, leadsError = null, recordsFor = () => ({ rows: [], truncated: false }), journey, clicks } = {}) {
  const calls = [];
  const log = [];
  let running = 0;
  let maxRunning = 0;
  return {
    calls,
    log,
    get maxRunning() { return maxRunning; },
    now: () => new Date('2026-09-15T12:00:00Z'),
    call: async (name, args, opts) => {
      calls.push({ name, args, opts });
      if (name === '/leads/journey') { if (journey instanceof Error) throw journey; return journey; }
      throw new Error(`unexpected ${name}`);
    },
    pagedInfo: async (name, args, opts) => {
      calls.push({ name, args, opts });
      // The cohort walk: `nextPageId` stands for pages left past maxPages.
      if (name === '/leads') return { rows: leads, truncated: Boolean(nextPageId), ...(leadsError ? { error: leadsError } : {}) };
      if (name === '/leads/clicks') {
        if (clicks instanceof Error) throw clicks;
        return { rows: clicks?.result || [], truncated: Boolean(clicks?.nextPageId) };
      }
      running += 1;
      maxRunning = Math.max(maxRunning, running);
      const first = args.leadIds?.[0] ?? (args.lastSourceTags || args.firstSourceTags)?.[0];
      log.push(`start ${first}`);
      await new Promise((resolve) => setImmediate(resolve));
      log.push(`end ${first}`);
      running -= 1;
      return recordsFor(args.leadIds, args);
    },
  };
}

const lead = (i, extra = {}) => ({ id: `L${i}`, email: `u${i}@example.test`, creationDate: '2026-09-01T10:00:00-05:00', ...extra });

test('loadCohort walks GET /leads by tag up to 8 pages of 250, sends the first 50 tags, counts the rest and drops merged leads', async () => {
  const data = fakeData({ leads: [lead(1), lead(2, { originLead: { id: 'L1' } }), lead(3)], nextPageId: 'p2' });
  const tags = Array.from({ length: 55 }, (_, i) => `@t${i}`);
  const out = await loadCohort(data, [...tags, '@t0', null, '@a,b'], { tz: '-05:00' });
  assert.equal(data.calls.length, 1);
  assert.equal(data.calls[0].name, '/leads');
  assert.deepEqual(Object.keys(data.calls[0].args), ['tags'], 'no date filter unless asked');
  assert.equal(data.calls[0].opts.pageSize, 250);
  assert.equal(data.calls[0].opts.maxPages, 8);
  assert.deepEqual(data.calls[0].args.tags, tags.slice(0, 50));
  assert.ok(data.calls[0].args.tags.every((t) => !t.includes(',')), 'a tag with a comma cannot be sent');
  assert.doesNotThrow(() => toQuery(data.calls[0].args));
  assert.equal(out.tagsSent, 50);
  assert.equal(out.tagsLeft, 6, 'the 5 past the cap and the one holding a comma');
  assert.deepEqual(out.ids, ['L1', 'L3']);
  assert.equal(out.leads[0].joined, '2026-09-01T10:00:00-05:00');
  assert.equal(out.truncated, true);
  const last = await loadCohort(fakeData({ leads: [lead(1)] }), ['@a']);
  assert.equal(last.truncated, false);
});

test('loadRecords batches lead ids by 50 and runs the batches in series', async () => {
  const ids = Array.from({ length: 120 }, (_, i) => `L${i}`);
  const data = fakeData({ recordsFor: (batch) => ({ rows: batch.map((id) => ({ lead: { email: `${id}@x.test` }, creationDate: 'Thu Jul 02 01:10:33 UTC 2026', price: { price: 10, currency: 'EUR' } })), truncated: false }) });
  const out = await loadRecords(data, 'sales', ids);
  const batches = data.calls.map((c) => c.args.leadIds.length);
  assert.deepEqual(batches, [50, 50, 20]);
  assert.ok(data.calls.every((c) => c.name === '/sales' && c.opts.maxPages === 4 && c.opts.pageSize === 250));
  assert.ok(data.calls.every((c) => Object.keys(c.args).join() === 'leadIds'));
  assert.equal(data.maxRunning, 1);
  assert.deepEqual(data.log, ['start L0', 'end L0', 'start L50', 'end L50', 'start L100', 'end L100']);
  assert.equal(out.records.length, 120);
  assert.equal(out.records[0].date, '2026-07-02T01:10:33+00:00');
  assert.equal(out.records[0].amount, 10);
  assert.equal(out.truncated, false);
});

test('loadRecords: a truncated batch, a newer drill and the deadline all read as truncated', async () => {
  const ids = Array.from({ length: 100 }, (_, i) => `L${i}`);
  const cut = await loadRecords(fakeData({ recordsFor: () => ({ rows: [], truncated: true }) }), 'calls', ids);
  assert.equal(cut.truncated, true);

  let current = true;
  const data = fakeData({ recordsFor: () => { current = false; return { rows: [], truncated: false }; } });
  const stale = await loadRecords(data, 'calls', ids, { isCurrent: () => current });
  assert.equal(data.calls.length, 1);
  assert.equal(stale.truncated, true);

  const late = fakeData();
  const out = await loadRecords(late, 'calls', ids, { deadline: Date.now() - 1 });
  assert.equal(late.calls.length, 0);
  assert.equal(out.error, 'time budget');
});

test('loadRecords maps calls with their state, falling back to qualified', async () => {
  const data = fakeData({ recordsFor: () => ({ rows: [{ lead: { email: 'a@x.test' }, tag: '@demo', qualified: true, creationDate: 'Sun Sep 13 11:00:00 EST 2026' }, { lead: { email: 'b@x.test' }, state: 'NO_SHOW' }], truncated: false }) });
  const out = await loadRecords(data, 'calls', ['L1']);
  assert.equal(data.calls[0].name, '/calls');
  assert.deepEqual(out.records.map((r) => r.state), ['QUALIFIED', 'NO_SHOW']);
  assert.equal(out.records[0].name, '@demo');
  assert.equal(out.records[0].date, '2026-09-13T11:00:00-05:00');
});

test('loadJourney asks for the journey and a year of clicks from the account day start', async () => {
  const data = fakeData({
    journey: { result: [{
      lead: lead(1),
      sales: [{ creationDate: 'Wed May 01 13:00:00 UTC 2024', price: { price: 90, currency: 'EUR' }, usdPrice: { price: 99, currency: 'USD' }, product: { name: 'P' } }],
      calls: [{ creationDate: 'Thu May 02 09:00:00 ART 2024', tag: '@demo', qualified: true }],
      journey: [{ type: 'sale', date: '2024-05-01T08:00:00-05:00', name: 'P' }],
    }] },
    clicks: { result: [{ date: 'Tue Apr 30 22:15:00 UTC 2024', page: 'https://shop.test/a', adspendType: 'NONE' }] },
  });
  const out = await loadJourney(data, 'u1@example.test', { tz: '-05:00' });
  const j = data.calls.find((c) => c.name === '/leads/journey');
  const c = data.calls.find((x) => x.name === '/leads/clicks');
  assert.deepEqual(j.args, { emails: ['u1@example.test'], includeEvents: true });
  // /leads/clicks takes exactly one selector: emails, never email or leadIds beside it.
  assert.deepEqual(c.args, { emails: ['u1@example.test'], fromDate: '2025-09-15T00:00:00-05:00' });
  assert.equal(c.opts.maxPages, 2);
  assert.equal(c.opts.pageSize, 250);
  assert.equal(toQuery(j.args), 'emails=u1%40example.test&includeEvents=true');
  assert.equal(out.journey.sales[0].date, '2024-05-01T13:00:00+00:00');
  assert.equal(out.journey.sales[0].amount, 90);
  assert.equal(out.journey.calls[0].date, '2024-05-02T09:00:00-03:00');
  assert.equal(out.journey.journey[0].date, '2024-05-01T08:00:00-05:00');
  assert.equal(out.clicks[0].date, '2024-04-30T22:15:00+00:00');
  assert.equal(out.clicks[0].platform, null);
  assert.equal(out.clicksTruncated, false);
  assert.equal(out.clicksError, null);
});

test('loadJourney flags a click history with more pages, and the drawer says so', async () => {
  const data = fakeData({ journey: [{ lead: lead(1) }], clicks: { result: [{ date: '2026-09-01T10:00:00Z', page: 'https://shop.test/a' }], nextPageId: 'p3' } });
  const out = await loadJourney(data, 'u1@example.test');
  assert.equal(out.clicksTruncated, true);
  assert.match(renderJourney(ctx, out).html, /Click history · 1\+ tracked clicks, list cut short/);
});

test('loadRecords sends the date range with every batch', async () => {
  const data = fakeData();
  const dates = { fromDate: '2026-01-01T00:00:00-05:00', toDate: '2026-09-30T23:59:59-05:00' };
  await loadRecords(data, 'sales', Array.from({ length: 60 }, (_, i) => `L${i}`), { dates });
  assert.equal(data.calls.length, 2);
  assert.ok(data.calls.every((c) => c.args.fromDate === dates.fromDate && c.args.toDate === dates.toDate));
  assert.match(renderRecords(ctx, { kind: 'sales', records: [], cohortSize: 3, inRange: true }).subtitle, /^0 sales in the range from 3 touched leads/);
});

test('loadJourney: failed clicks do not fail the journey; a failed journey throws; no lead is null', async () => {
  const ok = await loadJourney(fakeData({ journey: { result: [{ lead: lead(1) }] }, clicks: new Error('clicks down') }), 'u1@example.test');
  assert.equal(ok.clicksError, 'clicks down');
  assert.deepEqual(ok.clicks, []);
  assert.equal(ok.journey.lead.email, 'u1@example.test');

  await assert.rejects(loadJourney(fakeData({ journey: new Error('journey down'), clicks: { result: [] } }), 'x@y.test'), /journey down/);
  assert.equal(await loadJourney(fakeData({ journey: { result: [] }, clicks: { result: [] } }), 'x@y.test'), null);
});

test('priceOf: price wins over usdPrice, usdPrice only when price is missing', () => {
  assert.deepEqual(priceOf({ price: { price: 90, currency: 'EUR' }, usdPrice: { price: 100 } }), { amount: 90, currency: 'EUR', usdAmount: 100 });
  assert.deepEqual(priceOf({ usdPrice: { price: 100 } }), { amount: 100, currency: 'USD' });
  assert.deepEqual(priceOf({}), { amount: 0, currency: null });
});

test('leadIncome sums sales in the account currency only', () => {
  assert.equal(leadIncome([{ amount: 10, currency: 'EUR' }, { amount: 5, currency: null }, { amount: 99, currency: 'USD' }], 'EUR'), 15);
});

test('renderers escape emails, names and sources', () => {
  const evil = '<img src=x onerror=alert(1)>';
  const cohort = renderCohort(ctx, { leads: [{ email: evil, stage: evil, firstSource: { ad: evil, tag: '@a' }, lastSource: { name: evil, tag: '@b' } }], note: evil });
  assert.ok(!cohort.html.includes('<img') && !cohort.subtitle.includes('<img'));

  const records = renderRecords(ctx, { kind: 'sales', records: [{ email: evil, name: evil, source: evil, state: 'REFUNDED', amount: 5, currency: 'EUR' }], cohortSize: 1 });
  assert.ok(!records.html.includes('<img'));

  const journey = renderJourney(ctx, { journey: { lead: { stage: evil }, sales: [], journey: [{ type: evil, name: evil, keyword: evil, extra: evil, subNames: [evil] }] }, clicks: [{ page: evil, source: evil, platform: evil, previousUrl: evil }], clicksError: evil });
  assert.ok(!journey.html.includes('<img') && !journey.subtitle.includes('<img'));
});

test('renderers state truncation, empty lists and failed clicks', () => {
  assert.match(renderCohort(ctx, { leads: [{ email: 'a@x.test' }], truncated: true }).subtitle, /1\+ leads.*newest 1 shown/);
  assert.match(renderCohort(ctx, { leads: [] }).html, /class="empty"/);
  assert.match(renderRecords(ctx, { kind: 'calls', records: [], cohortSize: 3 }).html, /No calls recorded/);

  const cut = renderRecords(ctx, { kind: 'sales', records: [], cohortSize: 0, tagsSent: 50, tagsLeft: 23 });
  assert.match(cut.subtitle, /^0\+ sales/);
  assert.match(cut.subtitle, /first 50 of 73 sources/);
  assert.match(cut.html, /No sales from the first 50 of 73 sources\. The other 23 were not queried/);
  assert.doesNotMatch(cut.html, /No sales recorded/);
  assert.match(renderCohort(ctx, { leads: [], tagsSent: 50, tagsLeft: 1 }).html, /No leads from the first 50 of 51 sources/);
  assert.doesNotMatch(renderRecords(ctx, { kind: 'sales', records: [], cohortSize: 3, tagsSent: 3 }).subtitle, /sources<\/span>/);
  const j = renderJourney(ctx, { journey: { lead: {}, sales: [], journey: [] }, clicks: [], clicksError: 'down' });
  assert.match(j.html, /note err">Click history could not be fetched: down/);
  assert.match(j.html, /No journey events/);
});

test('loadCredited asks for the last source tags in batches of 50, in series, with the range', async () => {
  const tags = Array.from({ length: 60 }, (_, i) => `@t${i}`);
  const dates = { fromDate: '2026-01-01T00:00:00-05:00', toDate: '2026-09-30T23:59:59-05:00' };
  const data = fakeData({ recordsFor: (_, req) => ({ rows: [{ lead: { email: `${req.lastSourceTags[0]}@x.test` }, creationDate: '2026-07-01T10:00:00Z', price: { price: 5, currency: 'EUR' }, lastSource: { name: 'L' }, firstSource: { name: 'F' } }], truncated: false }) });
  const out = await loadCredited(data, 'sales', [...tags, '@t0'], { model: 'LAST_CLICK', dates });
  assert.deepEqual(data.calls.map((c) => c.args.lastSourceTags.length), [50, 10]);
  assert.ok(data.calls.every((c) => c.name === '/sales' && c.args.fromDate === dates.fromDate && c.args.toDate === dates.toDate));
  assert.ok(data.calls.every((c) => c.opts.maxPages === 40), 'a credited list is the cell itself: it reads up to 40 pages per batch');
  assert.ok(data.calls.every((c) => !('leadIds' in c.args) && !('firstSourceTags' in c.args)));
  assert.equal(data.maxRunning, 1);
  assert.equal(out.records.length, 2);
  assert.equal(out.records[0].source, 'L', 'a last click drill names the last source');
});

test('loadCredited leaves a tag holding a comma out and counts it, and the drawer says so', async () => {
  const data = fakeData({ recordsFor: () => ({ rows: [], truncated: false }) });
  const out = await loadCredited(data, 'sales', ['@a', '@b,c'], { model: 'LAST_CLICK' });
  assert.deepEqual(data.calls.map((c) => c.args.lastSourceTags), [['@a']]);
  assert.doesNotThrow(() => toQuery(data.calls[0].args));
  assert.equal(out.tagsSent, 1);
  assert.equal(out.tagsLeft, 1);
  const view = renderCredited(ctx, { kind: 'sales', ...out, attribution: 'LAST_CLICK' });
  assert.match(view.subtitle, /^0\+ sales credited in the range/);
  assert.match(view.subtitle, /first 1 of 2 sources/);
  assert.match(view.html, /The other 1 were not queried/);
});

test('loadCredited under scientific keeps first sources within 30 days of the first click and last sources after', async () => {
  const sale = (id, days, extra = {}) => ({
    id, lead: { email: `${id}@x.test` }, price: { price: 10, currency: 'EUR' },
    creationDate: new Date(Date.parse('2026-07-01T00:00:00Z') + days * 86400000).toISOString(),
    firstSource: { name: 'F', clickDate: '2026-07-01T00:00:00+00:00' }, lastSource: { name: 'L' }, ...extra,
  });
  const byField = {
    firstSourceTags: [sale('s1', 10), sale('s2', 40), sale('s3', 30), sale('s5', 5, { firstSource: { name: 'F' } })],
    lastSourceTags: [sale('s4', 45), sale('s6', 10), sale('s3', 30)],
  };
  const data = fakeData({ recordsFor: (_, req) => ({ rows: req.firstSourceTags ? byField.firstSourceTags : byField.lastSourceTags, truncated: false }) });
  const out = await loadCredited(data, 'sales', ['@a'], { model: 'SCIENTIFIC', dates: { fromDate: 'F', toDate: 'T' } });
  assert.deepEqual(data.calls.map((c) => Object.keys(c.args).filter((k) => k.endsWith('SourceTags'))), [['firstSourceTags'], ['lastSourceTags']]);
  assert.ok(data.calls.every((c) => c.args.fromDate === 'F' && c.args.toDate === 'T'));
  assert.deepEqual(out.records.map((r) => r.email), ['s1@x.test', 's3@x.test', 's4@x.test'],
    'within 30 days by the first source, later by the last; no click date is no credit; one sale once');
  assert.deepEqual(out.records.map((r) => r.source), ['F', 'F', 'L']);
  assert.match(renderCredited(ctx, { kind: 'sales', ...out, attribution: 'SCIENTIFIC' }).subtitle, /^3 sales credited in the range.*credited · scientific/);
});

test('loadCredited under scientific still runs the last-source filter when the first one hit the page cap', async () => {
  const data = fakeData({ recordsFor: (_, req) => ({ rows: [], truncated: Boolean(req.firstSourceTags) }) });
  const out = await loadCredited(data, 'calls', ['@a'], { model: 'SCIENTIFIC' });
  assert.deepEqual(data.calls.map((c) => (c.args.firstSourceTags ? 'first' : 'last')), ['first', 'last']);
  assert.equal(out.truncated, true);
});

test('loadCredited uses the first source tags under first click, on calls too', async () => {
  const data = fakeData({ recordsFor: () => ({ rows: [{ lead: { email: 'a@x.test' }, firstSource: { name: 'F' }, lastSource: { name: 'L' } }], truncated: true }) });
  const out = await loadCredited(data, 'calls', ['@a'], { model: 'FIRST_CLICK' });
  assert.equal(data.calls[0].name, '/calls');
  assert.deepEqual(data.calls[0].args.firstSourceTags, ['@a']);
  assert.equal(out.records[0].source, 'F');
  assert.equal(out.truncated, true);
});

test('loadCohort sends the join date range when given', async () => {
  const data = fakeData({ leads: [lead(1)] });
  await loadCohort(data, ['@a'], { dates: { fromDate: 'F', toDate: 'T' } });
  assert.equal(data.calls[0].args.fromDate, 'F');
  assert.equal(data.calls[0].args.toDate, 'T');
});

test('loadCohort passes the deadline on and keeps the error of a walk cut short', async () => {
  const deadline = Date.now() + 60000;
  const data = fakeData({ leads: [lead(1)], nextPageId: 'p9', leadsError: 'time budget' });
  const out = await loadCohort(data, ['@a'], { deadline });
  assert.equal(data.calls[0].opts.deadline, deadline);
  assert.equal(out.truncated, true);
  assert.equal(out.error, 'time budget');
});

test('a touched drill cut short says older leads were not queried instead of a bare 0', () => {
  const out = renderRecords(ctx, { kind: 'sales', records: [], cohortSize: 2000, cohortCut: true, inRange: true });
  assert.match(out.subtitle, /^0\+ sales in the range from 2,000 touched leads, the newest that touched it; older leads were not queried/);
  assert.match(out.html, /No sales in the range from the 2,000 touched leads queried\. Older leads were not queried\./);
  assert.doesNotMatch(out.html, /No sales recorded/);

  const late = renderRecords(ctx, { kind: 'calls', records: [{ email: 'a@x.test' }], cohortSize: 40, truncated: true, error: 'time budget' });
  assert.match(late.subtitle, /^1\+ calls from 40 touched leads, stopped at the time limit, the rest was not queried/);
  assert.doesNotMatch(late.subtitle, /newest shown/);
  assert.match(renderRecords(ctx, { kind: 'calls', records: [], cohortSize: 40, error: 'time budget' }).html, /stopped at its time limit/);

  const whole = renderRecords(ctx, { kind: 'sales', records: [], cohortSize: 12, inRange: true });
  assert.match(whole.subtitle, /^0 sales in the range from 12 touched leads/);
  assert.match(whole.html, /No sales recorded for this cohort in the range/);
});

test('a leads drill cut short says older leads were not read', () => {
  const out = renderCohort(ctx, { leads: [{ email: 'a@x.test' }], truncated: true, inRange: true });
  assert.match(out.subtitle, /^1\+ leads joined in the range and touched this source, newest 1 shown, older ones not read/);
  assert.match(out.subtitle, /touched ≠ credited/);
  assert.match(renderCohort(ctx, { leads: [], truncated: true }).html, /Older leads were not read/);
  assert.match(renderCohort(ctx, { leads: [], truncated: true, error: 'time budget' }).subtitle, /stopped at the time limit/);
});


test('renderCredited counts and sums only the sales that are not refunded, and lists all', () => {
  const records = [
    { email: 'a@x.test', amount: 100, currency: 'EUR', state: null },
    { email: 'b@x.test', amount: 50, currency: 'EUR', state: 'RECURRING' },
    { email: 'c@x.test', amount: 22, currency: 'EUR', state: 'REFUNDED' },
  ];
  const out = renderCredited({ ...ctx, fmt: { ...fmt, currency: 'EUR' } }, { kind: 'sales', records, attribution: 'LAST_CLICK' });
  assert.match(out.subtitle, /^2 sales credited in the range/);
  assert.match(out.subtitle, /1 refunded, listed but not counted/);
  assert.match(out.subtitle, /credited · last click/);
  assert.doesNotMatch(out.subtitle, /touched/);
  assert.equal((out.html.match(/class="cohort-row"/g) || []).length, 3);
  assert.match(renderCredited(ctx, { kind: 'calls', records: [], attribution: 'FIRST_CLICK' }).html, /No calls credited to this row in the range/);
});

test('renderCohort names the leads by join date and says they are touched, not credited', () => {
  const touched = renderCohort(ctx, { leads: [{ email: 'a@x.test' }], inRange: true });
  assert.match(touched.subtitle, /^1 leads joined in the range and touched this source/);
  assert.match(touched.subtitle, /touched ≠ credited/);
});
