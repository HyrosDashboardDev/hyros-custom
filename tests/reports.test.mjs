import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { configure, get, runReport } from '../src/core/api.js';

const CFG = { groupBy: 'TRAFFIC_SOURCE', startDate: '2026-09-01', endDate: '2026-09-30' };

const URL = 'https://api.test/api/v1.0';
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

/** Answers each request with the next of `answers` (status 200 unless given) and records it. */
function serve(answers) {
  const seen = [];
  let i = 0;
  globalThis.fetch = async (href, init) => {
    seen.push({ href, init });
    const a = answers[Math.min(i++, answers.length - 1)];
    return new Response(JSON.stringify(a.body ?? a), { status: a.status || 200 });
  };
  configure({ url: URL, getToken: async () => 'tok', markInvalid: () => {} });
  return seen;
}

test('/reports/poll/{id} is a read path: the id fills its one segment and nothing else', async () => {
  const seen = serve([{ result: { status: 'IN_PROGRESS' } }]);
  await get('/reports/poll/{id}', { id: 'c81c6061f1f7', pageSize: 10 });
  assert.equal(seen[0].href, `${URL}/reports/poll/c81c6061f1f7?pageSize=10`);
  assert.equal(seen[0].init.method, 'GET');
  for (const id of ['../leads', 'abc?x=1', 'a/b', '', 'a#b', 'a%2Fb', 'a.b', 42, undefined]) {
    await assert.rejects(get('/reports/poll/{id}', { id }), (err) => err.code === 'bad_request', String(id));
  }
  await assert.rejects(get('/reports/poll/c81c6061f1f7'), (err) => err.code === 'not_allowed');
  await assert.rejects(get('/reports/generate'), (err) => err.code === 'not_allowed');
  assert.equal(seen.length, 1);
});

test('runReport POSTs the configuration as JSON with the Bearer token', async () => {
  const seen = serve([{ result: 'r1' }, { result: { status: 'SUCCESSFUL', report: { rows: [] } } }]);
  await runReport(CFG, { pollMs: 0 });
  assert.equal(seen[0].href, `${URL}/reports/generate`);
  assert.equal(seen[0].init.method, 'POST');
  assert.equal(seen[0].init.headers.authorization, 'Bearer tok');
  assert.equal(seen[0].init.headers['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(seen[0].init.body), { configuration: CFG });
  assert.equal(seen[1].init.method, 'GET');
  assert.equal(seen[1].init.body, undefined);
});

test('runReport with an account generates and polls the report on that account', async () => {
  const seen = serve([{ result: 'r1' }, { result: { status: 'IN_PROGRESS' } }, { result: { status: 'SUCCESSFUL', report: { rows: [] } } }]);
  await runReport(CFG, { pollMs: 0, account: 'client-1' });
  assert.deepEqual(seen.map((s) => s.init.headers['Accessible-Account-Id']), ['client-1', 'client-1', 'client-1']);
});

test('runReport refuses a bad configuration before any request', async () => {
  const seen = serve([{ result: 'r1' }]);
  for (const bad of [null, [], {}, { ...CFG, groupBy: 'x/../y' }, { ...CFG, startDate: '2026-09-01T00:00' }]) {
    await assert.rejects(runReport(bad, { pollMs: 0 }), (err) => err.code === 'bad_request');
  }
  assert.equal(seen.length, 0);
});

test('a report id that could change the path is never polled', async () => {
  for (const id of ['../leads', 'abc?x=1', 'a/b', '', 'a#b', 'a%2Fb', 42]) {
    const seen = serve([{ result: id }]);
    await assert.rejects(runReport(CFG, { pollMs: 0 }), /valid report id/);
    assert.equal(seen.length, 1, String(id));
  }
});

test('runReport generates, polls while IN_PROGRESS and answers the report', async () => {
  const report = { rows: [{ name: 'a' }], totals: { name: 'Total' }, totalRows: 1 };
  const seen = serve([{ result: 'rep1' }, { result: { status: 'IN_PROGRESS' } }, { result: { status: 'SUCCESSFUL', report } }]);
  const out = await runReport(CFG, { pollMs: 0 });
  assert.deepEqual(out, report);
  assert.deepEqual(seen.map((s) => [s.init.method, s.href]), [
    ['POST', `${URL}/reports/generate`],
    ['GET', `${URL}/reports/poll/rep1`],
    ['GET', `${URL}/reports/poll/rep1`],
  ]);
});

test('runReport fails with the message of FAILED and EXPIRED', async () => {
  serve([{ result: 'rep1' }, { result: { status: 'FAILED', message: 'Too many sources' } }]);
  await assert.rejects(runReport(CFG, { pollMs: 0 }), (err) => err.code === 'report_failed' && /Too many sources/.test(err.message));
  serve([{ result: 'rep1' }, { result: { status: 'EXPIRED' }, message: ['Generate it again'] }]);
  await assert.rejects(runReport(CFG, { pollMs: 0 }), (err) => err.code === 'report_expired' && /Generate it again/.test(err.message));
});

test('runReport gives up after maxMs, stops when cancelled, and passes a 403 through', async () => {
  serve([{ result: 'rep1' }, { result: { status: 'IN_PROGRESS' } }]);
  await assert.rejects(runReport(CFG, { pollMs: 5, maxMs: 30 }), (err) => err.code === 'report_timeout');
  const ctrl = new AbortController();
  ctrl.abort();
  serve([{ result: 'rep1' }]);
  await assert.rejects(runReport(CFG, { pollMs: 0, signal: ctrl.signal }), (err) => err.code === 'cancelled');
  serve([{ status: 403, body: { result: 'ERROR', message: ['Missing role'] } }]);
  await assert.rejects(runReport(CFG, { pollMs: 0 }), (err) => err.code === 'forbidden' && /Missing role/.test(err.message));
});

test('runReport reports its progress after the generate and each poll', async () => {
  serve([{ result: 'rep1' }, { result: { status: 'IN_PROGRESS' } }, { result: { status: 'SUCCESSFUL', report: { rows: [] } } }]);
  const seen = [];
  await runReport(CFG, { pollMs: 0, onProgress: (p) => seen.push([p.status, p.polls]) });
  assert.deepEqual(seen, [['GENERATED', 0], ['IN_PROGRESS', 1], ['SUCCESSFUL', 2]]);
});
