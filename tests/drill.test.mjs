import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadCohort, loadRecords, loadJourney, renderCohort, renderRecords, renderJourney, priceOf, leadIncome } from '../src/ui/drill.js';
import { fmt } from '../src/ui/fmt.js';
import { esc } from '../src/ui/dom.js';
import { toQuery } from '../src/core/api.js';

const ctx = { fmt, esc };

/** A stand-in for ctx.data keyed on API paths (flat params), recording every call and the order calls started and ended. */
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
      // `call` returns the body as sent: the envelope, with nextPageId when there is more.
      if (name === '/leads') return { result: leads, ...(nextPageId ? { nextPageId } : {}) };
      if (name === '/leads/journey') { if (journey instanceof Error) throw journey; return journey; }
      throw new Error(`unexpected ${name}`);
    },
    pagedInfo: async (name, args, opts) => {
      calls.push({ name, args, opts });
      if (name === '/leads/clicks') {
        if (clicks instanceof Error) throw clicks;
        return { rows: clicks?.result || [], truncated: Boolean(clicks?.nextPageId) };
      }
      running += 1;
      maxRunning = Math.max(maxRunning, running);
      log.push(`start ${args.leadIds[0]}`);
      await new Promise((resolve) => setImmediate(resolve));
      log.push(`end ${args.leadIds[0]}`);
      running -= 1;
      return recordsFor(args.leadIds);
    },
  };
}

const lead = (i, extra = {}) => ({ id: `L${i}`, email: `u${i}@example.test`, creationDate: '2026-09-01T10:00:00-05:00', ...extra });

test('loadCohort asks GET /leads for one page of 250 by tag, sends the first 50 tags, counts the rest and drops merged leads', async () => {
  const data = fakeData({ leads: [lead(1), lead(2, { originLead: { id: 'L1' } }), lead(3)], nextPageId: 'p2' });
  const tags = Array.from({ length: 55 }, (_, i) => `@t${i}`);
  const out = await loadCohort(data, [...tags, '@t0', null, '@a,b'], { tz: '-05:00' });
  assert.equal(data.calls.length, 1);
  assert.equal(data.calls[0].name, '/leads');
  assert.deepEqual(Object.keys(data.calls[0].args).sort(), ['pageSize', 'tags']);
  assert.equal(data.calls[0].args.pageSize, 250);
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

test('priceOf keeps the refunded amount of the price it read', () => {
  assert.deepEqual(priceOf({ price: { price: 90, refunded: 30, currency: 'EUR' } }), { amount: 90, currency: 'EUR', refundedAmount: 30 });
  assert.deepEqual(priceOf({ usdPrice: { price: 100, refunded: 100 } }), { amount: 100, currency: 'USD', refundedAmount: 100 });
  assert.deepEqual(priceOf({ price: { price: 90, refunded: 0, currency: 'EUR' } }), { amount: 90, currency: 'EUR' });
});

test('leadIncome sums sales in the account currency only', () => {
  assert.equal(leadIncome([{ amount: 10, currency: 'EUR' }, { amount: 5, currency: null }, { amount: 99, currency: 'USD' }], 'EUR'), 15);
});

test('sale totals are net of refunds, like HYROS revenue', () => {
  const sales = [
    { amount: 100, currency: 'USD' },
    { amount: 50, refundedAmount: 50, currency: 'USD', state: 'REFUNDED' },
    { amount: 40, refundedAmount: 10, currency: 'USD' },
  ];
  assert.equal(leadIncome(sales, 'USD'), 130);
  assert.match(renderRecords(ctx, { kind: 'sales', records: sales, cohortSize: 1 }).subtitle, /130/);
  const journey = renderJourney(ctx, { journey: { lead: {}, sales, journey: [] }, clicks: [] });
  assert.match(journey.subtitle, /income <b class="good">[^<]*130/);
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
