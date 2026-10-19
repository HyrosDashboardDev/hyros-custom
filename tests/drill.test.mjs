import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadCohort, loadRecords, loadJourney, renderCohort, renderRecords, renderJourney, priceOf, leadIncome } from '../src/ui/drill.js';
import { fmt } from '../src/ui/fmt.js';
import { esc } from '../src/ui/dom.js';

const ctx = { fmt, esc };

/** A stand-in for ctx.data that records every call, with the order calls started and ended. */
function fakeData({ leads = [], nextPageId = null, recordsFor = () => ({ rows: [], truncated: false }), journey, clicks } = {}) {
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
      if (name === 'hyros_get_leads') return { result: leads, nextPageId };
      if (name === 'hyros_get_lead_journey') { if (journey instanceof Error) throw journey; return journey; }
      if (name === 'hyros_get_lead_clicks') { if (clicks instanceof Error) throw clicks; return clicks; }
      throw new Error(`unexpected ${name}`);
    },
    pagedInfo: async (name, args, opts) => {
      calls.push({ name, args, opts });
      running += 1;
      maxRunning = Math.max(maxRunning, running);
      log.push(`start ${args.request.leadIds[0]}`);
      await new Promise((resolve) => setImmediate(resolve));
      log.push(`end ${args.request.leadIds[0]}`);
      running -= 1;
      return recordsFor(args.request.leadIds);
    },
  };
}

const lead = (i, extra = {}) => ({ id: `L${i}`, email: `u${i}@example.test`, creationDate: '2026-09-01T10:00:00-05:00', ...extra });

test('loadCohort asks for one page of 250 leads by tag, sends the first 50 tags, counts the rest and drops merged leads', async () => {
  const data = fakeData({ leads: [lead(1), lead(2, { originLead: { id: 'L1' } }), lead(3)], nextPageId: 'p2' });
  const tags = Array.from({ length: 55 }, (_, i) => `@t${i}`);
  const out = await loadCohort(data, [...tags, '@t0', null]);
  assert.equal(data.calls.length, 1);
  assert.equal(data.calls[0].name, 'hyros_get_leads');
  assert.equal(data.calls[0].args.request.pageSize, 250);
  assert.deepEqual(data.calls[0].args.request.tags, tags.slice(0, 50));
  assert.equal(out.tagsSent, 50);
  assert.equal(out.tagsLeft, 5);
  assert.deepEqual(out.ids, ['L1', 'L3']);
  assert.equal(out.truncated, true);
});

test('loadRecords batches lead ids by 50 and runs the batches in series', async () => {
  const ids = Array.from({ length: 120 }, (_, i) => `L${i}`);
  const data = fakeData({ recordsFor: (batch) => ({ rows: batch.map((id) => ({ lead: { email: `${id}@x.test` }, creationDate: 'Thu Jul 02 01:10:33 UTC 2026', price: { price: 10, currency: 'EUR' } })), truncated: false }) });
  const out = await loadRecords(data, 'sales', ids);
  const batches = data.calls.map((c) => c.args.request.leadIds.length);
  assert.deepEqual(batches, [50, 50, 20]);
  assert.ok(data.calls.every((c) => c.name === 'hyros_get_sales' && c.opts.maxPages === 4 && c.opts.pageSize === 250));
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
  const data = fakeData({ recordsFor: () => ({ rows: [{ lead: { email: 'a@x.test' }, tag: '@demo', qualified: true }, { lead: { email: 'b@x.test' }, state: 'NO_SHOW' }], truncated: false }) });
  const out = await loadRecords(data, 'calls', ['L1']);
  assert.equal(data.calls[0].name, 'hyros_get_calls');
  assert.deepEqual(out.records.map((r) => r.state), ['QUALIFIED', 'NO_SHOW']);
  assert.equal(out.records[0].name, '@demo');
});

test('loadJourney asks for the journey and a year of clicks from the account day start', async () => {
  const data = fakeData({ journey: [{ lead: lead(1), sales: [], journey: [] }], clicks: { result: [{ date: '2026-09-01T10:00:00Z', page: 'https://shop.test/a', adspendType: 'NONE' }] } });
  const out = await loadJourney(data, 'u1@example.test', { tz: '-05:00' });
  const j = data.calls.find((c) => c.name === 'hyros_get_lead_journey');
  const c = data.calls.find((x) => x.name === 'hyros_get_lead_clicks');
  assert.deepEqual(j.args, { request: { emails: ['u1@example.test'], includeEvents: true } });
  assert.deepEqual(c.args, { request: { emails: ['u1@example.test'], fromDate: '2025-09-15T00:00:00-05:00', pageSize: 100 } });
  assert.equal(out.clicks[0].platform, null);
  assert.equal(out.clicksError, null);
});

test('loadRecords sends the date range with every batch', async () => {
  const data = fakeData();
  const dates = { fromDate: '2026-01-01T00:00:00-05:00', toDate: '2026-09-30T23:59:59-05:00' };
  await loadRecords(data, 'sales', Array.from({ length: 60 }, (_, i) => `L${i}`), { dates });
  assert.equal(data.calls.length, 2);
  assert.ok(data.calls.every((c) => c.args.request.fromDate === dates.fromDate && c.args.request.toDate === dates.toDate));
  assert.match(renderRecords(ctx, { kind: 'sales', records: [], cohortSize: 3, inRange: true }).subtitle, /^0 sales in the range from 3 touched leads/);
});

test('loadJourney: failed clicks do not fail the journey; a failed journey throws; no lead is null', async () => {
  const ok = await loadJourney(fakeData({ journey: [{ lead: lead(1) }], clicks: new Error('clicks down') }), 'u1@example.test');
  assert.equal(ok.clicksError, 'clicks down');
  assert.deepEqual(ok.clicks, []);
  assert.equal(ok.journey.lead.email, 'u1@example.test');

  await assert.rejects(loadJourney(fakeData({ journey: new Error('journey down'), clicks: { result: [] } }), 'x@y.test'), /journey down/);
  assert.equal(await loadJourney(fakeData({ journey: [], clicks: { result: [] } }), 'x@y.test'), null);
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
  assert.match(renderCohort(ctx, { leads: [{ email: 'a@x.test' }], truncated: true }).subtitle, /1\+ leads.*newest 250 shown/);
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
