import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  siteOf, siteTargets, hostOf, readDomains, readScripts, readParamRows, isFlagged, groupSites, siteSummary,
  runChecks, hasGoogleAccount, MAX_SITE_URLS,
} from '../src/views/health/checks.js';
import { html } from '../src/views/health/view.js';
import { fmt } from '../src/ui/fmt.js';
import { esc, kpis } from '../src/ui/dom.js';

/** A stand-in for ctx.data: `answers[tool](request)` per tool, records every call and how many ran at once. */
function fakeData(answers = {}) {
  const calls = [];
  const memo = new Map();
  let running = 0;
  let maxRunning = 0;
  const run = async (name, args, opts) => {
    calls.push({ name, args, opts });
    running += 1;
    maxRunning = Math.max(maxRunning, running);
    await new Promise((resolve) => setImmediate(resolve));
    running -= 1;
    const answer = answers[name];
    if (!answer) throw new Error(`unexpected ${name}`);
    return answer(args?.request, args);
  };
  return {
    calls,
    get maxRunning() { return maxRunning; },
    call: run,
    pagedInfo: async (name, args, opts) => run(name, args, opts),
    cached: (key, loader) => {
      if (!memo.has(key)) { const p = loader(); memo.set(key, p); p.catch(() => memo.delete(key)); }
      return memo.get(key);
    },
  };
}

const allFound = (req) => Object.fromEntries(req.domains.map((u) => [u, 'SUCCESSFUL']));
const far = () => Date.now() + 100000;

test('siteOf keeps the registrable domain and co.uk-style suffixes', () => {
  assert.equal(siteOf('data.shop.com'), 'shop.com');
  assert.equal(siteOf('https://t.shop.co.uk/x'), 'shop.co.uk');
  assert.equal(siteOf('shop.com'), 'shop.com');
});

test('siteTargets: apex and www together, at most 12 URLs, whole sites only', () => {
  const domains = Array.from({ length: 9 }, (_, i) => `data.site${i}.com`);
  const t = siteTargets(domains);
  assert.equal(t.length, MAX_SITE_URLS);
  assert.deepEqual(t.slice(0, 2).map((x) => x.url), ['https://site0.com/', 'https://www.site0.com/']);
  const perSite = new Map();
  for (const x of t) perSite.set(x.trackingDomain, (perSite.get(x.trackingDomain) || 0) + 1);
  assert.ok([...perSite.values()].every((n) => n === 2), 'never half a site');
  // An odd cap leaves the last site out instead of splitting it.
  assert.equal(siteTargets(domains, 5).length, 4);
  // Two tracking domains of one site are fetched once.
  assert.equal(siteTargets(['a.shop.com', 'b.shop.com']).length, 2);
});

test('readers: tolerant shapes, null when unreadable', () => {
  assert.deepEqual(readDomains(['a.com', { domain: 'b.com' }]), ['a.com', 'b.com']);
  assert.deepEqual(readDomains({ result: ['a.com'] }), ['a.com']);
  assert.equal(readDomains('nope'), null);
  assert.equal(readDomains({ foo: 1 }), null);
  assert.deepEqual(readScripts({ result: { 'https://a.com/': 'SUCCESSFUL' } }), { 'https://a.com/': 'SUCCESSFUL' });
  assert.deepEqual(readScripts([{ url: 'https://a.com/', present: false }]), { 'https://a.com/': 'SCRIPT_NOT_FOUND' });
  assert.equal(readScripts('text'), null);
  assert.equal(readScripts([1, 2]), null);
  assert.equal(readParamRows({ result: [{ valid: true }] }).length, 1);
  assert.equal(readParamRows({ valid: false, campaignId: 1 }).length, 1);
  assert.equal(readParamRows({ message: 'x' }), null);
  assert.equal(readParamRows('x'), null);
  // Every row and every domain is kept: the tiles count them all.
  assert.equal(readParamRows(Array.from({ length: 60 }, () => ({ valid: true }))).length, 60);
  assert.equal(readDomains(Array.from({ length: 25 }, (_, i) => `d${i}.com`)).length, 25);
});

test('isFlagged follows the DTO boolean, never the row text', () => {
  assert.equal(isFlagged({ valid: false }), true);
  assert.equal(isFlagged({ valid: true, campaignName: 'invalid traffic test' }), false);
  assert.equal(isFlagged({ missing: ['gclid'] }), true);
});

test('the full outcome enum: found, missing and inconclusive', () => {
  const sites = siteTargets(['a.com', 'b.com', 'c.com', 'd.com', 'e.com']);
  const scripts = {
    'https://a.com/': 'SUCCESSFUL', 'https://www.a.com/': 'SCRIPT_NOT_FOUND',
    'https://b.com/': 'DOMAIN_NOT_FOUND', 'https://www.b.com/': 'SCRIPT_DETECTED',
    'https://c.com/': 'SCRIPT_NOT_FOUND', 'https://www.c.com/': 'DOMAIN_NOT_FOUND',
    'https://d.com/': 'TIMEOUT_ERROR', 'https://www.d.com/': 'TIMEOUT_ERROR',
    'https://e.com/': 'UNKNOWN_ERROR', 'https://www.e.com/': 'DOMAIN_NOT_FOUND',
  };
  const g = Object.fromEntries(groupSites(sites, scripts).map((x) => [x.site, x]));
  assert.equal(g['a.com'].found, true);
  assert.equal(g['b.com'].found, true, 'SCRIPT_DETECTED is found');
  assert.deepEqual([g['c.com'].found, g['c.com'].checked], [false, true], 'SCRIPT_NOT_FOUND is the only missing outcome');
  assert.deepEqual([g['d.com'].inconclusive, g['d.com'].timedOut, g['d.com'].checked], [true, true, false]);
  assert.deepEqual([g['e.com'].inconclusive, g['e.com'].timedOut], [true, false]);
  assert.deepEqual(siteSummary(Object.values(g)), { checked: 3, ok: 2, missing: 1, unsure: 2, inconclusive: 2 });
  // Visits on a subdomain confirm a site the check read as missing.
  const visited = groupSites(sites, scripts, ['shop.c.com']).find((x) => x.site === 'c.com');
  assert.equal(visited.visited, true);
});

test('runChecks: domains, both Google channels, then script batches of 3 in series; no visits when every URL has the script', async () => {
  const data = fakeData({
    hyros_get_domains: () => ['data.one.com', 'data.two.com'],
    hyros_check_tracking_parameters_for_integrations: (req) => [{ campaignName: `c ${req.type}`, valid: req.type === 'SEARCH' }],
    hyros_assert_script_presence_on_domain: allFound,
  });
  const h = await runChecks(data, { hasGoogle: true, today: '2026-09-15', deadline: far() });
  assert.equal(data.maxRunning, 1);
  assert.deepEqual(data.calls.map((c) => c.name), [
    'hyros_get_domains',
    'hyros_check_tracking_parameters_for_integrations', 'hyros_check_tracking_parameters_for_integrations',
    'hyros_assert_script_presence_on_domain', 'hyros_assert_script_presence_on_domain',
  ]);
  assert.deepEqual(data.calls[0].args, {}, 'hyros_get_domains takes no arguments');
  assert.equal(data.calls[0].opts.timeoutMs, 15000);
  assert.deepEqual(data.calls.slice(1, 3).map((c) => c.args), [{ request: { type: 'SEARCH' } }, { request: { type: 'PERFORMANCE_MAX' } }]);
  assert.deepEqual(data.calls.slice(3).map((c) => c.args.request.domains.length), [3, 1]);
  assert.equal(data.calls[3].opts.timeoutMs, 45000);
  assert.equal(h.checks.script.status, 'ok');
  assert.equal(h.checks.params.status, 'ok');
  assert.deepEqual(h.checks.params.channels, { SEARCH: 'ok', PERFORMANCE_MAX: 'ok' });
  assert.equal(h.checks.visits.status, 'skipped');
  assert.equal(h.trackingParams.flatMap((p) => p.rows).filter(isFlagged).length, 1);
});

test('runChecks: visits only when a URL lacks the script; leads then clicks of the last 7 days', async () => {
  const data = fakeData({
    hyros_get_domains: () => ['data.one.com'],
    hyros_assert_script_presence_on_domain: (req) => Object.fromEntries(req.domains.map((u) => [u, 'SCRIPT_NOT_FOUND'])),
    hyros_get_leads: () => ({ result: [{ id: 'L1' }, { id: 'L2', originLead: { id: 'L1' } }, { id: 'L3' }] }),
    hyros_get_lead_clicks: () => ({ rows: [{ page: 'https://www.one.com/a' }, { trackedUrl: 'https://shop.one.com/' }, { page: 'nope' }], truncated: false }),
  });
  const h = await runChecks(data, { hasGoogle: false, today: '2026-09-15', deadline: far() });
  const names = data.calls.map((c) => c.name);
  assert.deepEqual(names, ['hyros_get_domains', 'hyros_assert_script_presence_on_domain', 'hyros_get_leads', 'hyros_get_lead_clicks']);
  assert.equal(h.checks.params.status, 'skipped');
  assert.deepEqual(data.calls[2].args, { request: { pageSize: 50 } });
  assert.deepEqual(data.calls[3].args, { request: { leadIds: ['L1', 'L3'], fromDate: '2026-09-08' } });
  assert.equal(data.calls[3].opts.maxPages, 4);
  assert.equal(data.calls[3].opts.pageSize, 250);
  assert.deepEqual(h.visitedHosts, ['one.com', 'shop.one.com']);
  assert.equal(h.checks.visits.status, 'ok');
  const g = groupSites(h.sites, h.scripts, h.visitedHosts);
  assert.equal(g[0].visited, true);
});

test('runChecks: params failing does not stop the script check', async () => {
  const data = fakeData({
    hyros_get_domains: () => ['a.com'],
    hyros_check_tracking_parameters_for_integrations: () => { throw new Error('integration expired'); },
    hyros_assert_script_presence_on_domain: allFound,
  });
  const h = await runChecks(data, { hasGoogle: true, today: '2026-09-15', deadline: far() });
  assert.equal(h.checks.params.status, 'failed');
  assert.match(h.checks.params.reason, /integration expired/);
  assert.equal(h.checks.script.status, 'ok');
});

test('runChecks: an unreadable reply is failed, not empty', async () => {
  const domains = await runChecks(fakeData({ hyros_get_domains: () => 'weird text' }), { hasGoogle: false, today: '2026-09-15', deadline: far() });
  assert.equal(domains.checks.domains.status, 'failed');
  assert.equal(domains.checks.domains.reason, 'unexpected reply shape');
  assert.equal(domains.checks.script.status, 'skipped');

  const script = await runChecks(fakeData({ hyros_get_domains: () => ['a.com'], hyros_assert_script_presence_on_domain: () => 42 }),
    { hasGoogle: false, today: '2026-09-15', deadline: far() });
  assert.equal(script.checks.script.status, 'failed');
  assert.equal(script.checks.script.reason, 'unexpected reply shape');

  const params = await runChecks(fakeData({
    hyros_get_domains: () => [], hyros_check_tracking_parameters_for_integrations: () => ({ message: '?' }),
  }), { hasGoogle: true, today: '2026-09-15', deadline: far() });
  assert.equal(params.checks.params.status, 'failed');
  assert.equal(params.checks.domains.status, 'empty');
  assert.equal(params.checks.script.reason, 'no verified domains');
});

test('runChecks: a script batch is not started with less than 8 s left; the unchecked URLs are listed', async () => {
  const data = fakeData({ hyros_get_domains: () => ['a.com', 'b.com'], hyros_assert_script_presence_on_domain: allFound });
  const h = await runChecks(data, { hasGoogle: false, today: '2026-09-15', deadline: Date.now() + 5000 });
  assert.equal(data.calls.filter((c) => c.name === 'hyros_assert_script_presence_on_domain').length, 0);
  assert.equal(h.checks.script.status, 'skipped');
  assert.equal(h.checks.script.reason, 'time budget');
  assert.equal(h.checks.script.unchecked.length, 4);

  const roomy = fakeData({ hyros_get_domains: () => ['a.com'], hyros_assert_script_presence_on_domain: allFound });
  await runChecks(roomy, { hasGoogle: false, today: '2026-09-15', deadline: Date.now() + 20000 });
  const slow = roomy.calls.find((c) => c.name === 'hyros_assert_script_presence_on_domain');
  assert.ok(slow.opts.timeoutMs <= 20000 && slow.opts.timeoutMs > 15000, 'slow timeout clamped by the deadline');

  const late = fakeData({ hyros_get_domains: () => ['a.com'] });
  const none = await runChecks(late, { hasGoogle: true, today: '2026-09-15', deadline: Date.now() - 1 });
  assert.equal(late.calls.length, 0);
  assert.equal(none.checks.domains.reason, 'time budget');
  assert.equal(none.checks.params.status, 'skipped');
});

test('runChecks: a script timeout fails the check with a readable reason and stops the batches', async () => {
  const timeout = Object.assign(new Error('MCP call timed out after 45000ms'), { code: 'timeout' });
  const data = fakeData({ hyros_get_domains: () => ['a.com', 'b.com'], hyros_assert_script_presence_on_domain: () => { throw timeout; } });
  const h = await runChecks(data, { hasGoogle: false, today: '2026-09-15', deadline: far() });
  assert.equal(data.calls.filter((c) => c.name === 'hyros_assert_script_presence_on_domain').length, 1);
  assert.equal(h.checks.script.status, 'failed');
  assert.match(h.checks.script.reason, /did not answer within 45s/);
});

test('runChecks: a newer render stops the series before its next call', async () => {
  let current = true;
  const data = fakeData({ hyros_get_domains: () => { current = false; return ['a.com']; }, hyros_assert_script_presence_on_domain: allFound });
  const h = await runChecks(data, { hasGoogle: false, today: '2026-09-15', deadline: far(), isCurrent: () => current });
  assert.equal(data.calls.length, 1);
  assert.equal(h.stopped, true);
});

test('hasGoogleAccount: GOOGLE and GOOGLE_V2 only', () => {
  assert.equal(hasGoogleAccount([{ type: 'FACEBOOK' }]), false);
  assert.equal(hasGoogleAccount([{ type: 'GOOGLE_V2' }]), true);
});

test('html escapes every HYROS string and explains a tile with no result', async () => {
  const data = fakeData({
    hyros_get_domains: () => ['data.<x>.com'],
    hyros_check_tracking_parameters_for_integrations: () => [{ campaignName: '<img src=x>', valid: false, customerId: '1' }],
    hyros_assert_script_presence_on_domain: () => { throw new Error('<boom>'); },
  });
  const h = await runChecks(data, { hasGoogle: true, today: '2026-09-15', deadline: far() });
  const out = html({ fmt, esc, kpis }, h, { adAccounts: [{ id: '1', name: '<script>', type: 'GOOGLE' }], account: {} });
  assert.doesNotMatch(out, /<img src=x>|<script>|<boom>/);
  assert.match(out, /&lt;img src=x&gt;/);
  assert.match(out, /failed: &lt;boom&gt;/);
  assert.match(out, /Ads missing tracking params<\/div>\s*<div class="kpi-value bad">2</, "one flagged row per channel");
});

test('html counts flagged ads past the first 50 and lists them first', async () => {
  // 60 ads per channel, the flagged one last.
  const rows = [...Array.from({ length: 59 }, (_, i) => ({ campaignName: `ok-${i}`, valid: true })), { campaignName: 'late-bad', valid: false }];
  const data = fakeData({
    hyros_get_domains: () => Array.from({ length: 25 }, (_, i) => `d${i}.com`),
    hyros_check_tracking_parameters_for_integrations: () => rows,
    hyros_assert_script_presence_on_domain: allFound,
  });
  const h = await runChecks(data, { hasGoogle: true, today: '2026-09-15', deadline: far() });
  const out = html({ fmt, esc, kpis }, h, { adAccounts: [{ id: '1', name: 'g', type: 'GOOGLE' }], account: {} });
  assert.match(out, /Ads missing tracking params<\/div>\s*<div class="kpi-value bad">2</);
  assert.match(out, /Verified domains<\/div>\s*<div class="kpi-value">25</);
  assert.ok(out.indexOf('late-bad') < out.indexOf('ok-0'), 'flagged rows are listed first');
  assert.match(out, /70 more ads not listed \(120 checked, missing ones first\)/);
});
