import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startMock, mock, calls } from '../scripts/mock-api.mjs';
import { configure, get, getPagedInfo, parseRetryAfter, toQuery, RATE_LIMIT_WAITS_MS, READ_PATHS } from '../src/core/api.js';

let server;
let url;

/** An in-memory stand-in for auth.js: hands out tok-1, tok-2, ... and records why it was asked. */
function fakeAuth() {
  let n = 0;
  let current = null;
  const seen = { reasons: [], invalidated: [] };
  return {
    seen,
    getToken: async (reason = 'initial') => {
      if (current) return current;
      seen.reasons.push(reason);
      current = `tok-${++n}`;
      return current;
    },
    markInvalid: (token) => {
      seen.invalidated.push(token);
      if (current === token) current = null;
    },
  };
}

let auth;
const wire = (extra = {}) => {
  auth = fakeAuth();
  configure({ url, getToken: auth.getToken, markInvalid: auth.markInvalid, rateLimitWaitsMs: [10, 20], ...extra });
};

before(async () => {
  server = await startMock(0);
  url = `http://127.0.0.1:${server.address().port}/api/v1.0`;
});
after(() => server.close());
beforeEach(() => {
  mock.reset();
  calls.length = 0;
});

test('before configure every call fails NO_TOKEN without a request', async () => {
  await assert.rejects(get('/user-info'), (err) => err.code === 'NO_TOKEN');
  assert.equal(calls.length, 0);
});

test('a GET with the Bearer token and nothing else, never an API-Key', async () => {
  wire();
  const realFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = (input, init) => { seen.push({ input, init }); return realFetch(input, init); };
  try {
    const body = await get('/user-info');
    assert.equal(body.result.userProfile.email, 'mock@hyros.test');
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(seen.length, 1);
  assert.equal(seen[0].init.method, 'GET');
  assert.equal(seen[0].init.body, undefined);
  const names = Object.keys(seen[0].init.headers).map((h) => h.toLowerCase()).sort();
  assert.deepEqual(names, ['accept', 'authorization']);
  assert.equal(seen[0].init.headers.authorization, 'Bearer tok-1');
  assert.deepEqual(calls.map((c) => c.token), ['tok-1']);
});

test('arrays travel as one comma-separated parameter, and null or undefined are left out', async () => {
  wire();
  await get('/leads', { fromDate: '2026-09-01T00:00:00+02:00', emails: ['a@x.test', 'b+1@x.test'], tags: [], stage: undefined, qualified: false });
  assert.deepEqual(calls[0].params, { fromDate: '2026-09-01T00:00:00+02:00', emails: 'a@x.test,b+1@x.test', qualified: 'false' });
});

test('toQuery encodes a + and refuses a value holding a comma', () => {
  assert.equal(toQuery({ fromDate: '2026-09-01T00:00:00+02:00' }), 'fromDate=2026-09-01T00%3A00%3A00%2B02%3A00');
  assert.throws(() => toQuery({ tags: ['@a', 'b,c'] }), (err) => err.code === 'bad_request');
});

test('a path outside READ_PATHS fails not_allowed before touching the network', async () => {
  wire();
  await assert.rejects(get('/leads/delete'), (err) => err.code === 'not_allowed');
  await assert.rejects(get('/tracking-script'), (err) => err.code === 'not_allowed');
  assert.equal(calls.length, 0);
});

test('READ_PATHS holds the reads the dashboard uses, the CRM aggregations included', () => {
  for (const path of READ_PATHS) assert.match(path, /^\/[a-z-]+(\/[a-z-]+)?$/, path);
  for (const path of ['/leads/aggregation', '/sales/aggregation', '/calls/aggregation']) {
    assert.ok(READ_PATHS.includes(path), path);
  }
});

test('two identical calls in flight share one request', async () => {
  wire();
  mock.latencyMs = 30;
  const [a, b] = await Promise.all([get('/stages'), get('/stages')]);
  assert.deepEqual(a, b);
  assert.equal(calls.length, 1);
  await get('/stages');
  assert.equal(calls.length, 2, 'a finished call is not cached');
});

test('a 401 drops the token, asks for a new one and retries once', async () => {
  wire();
  mock.failNext({ status: 401, body: 'Unauthorized' });
  const body = await get('/user-info');
  assert.equal(body.result.userProfile.email, 'mock@hyros.test');
  assert.deepEqual(calls.map((c) => c.token), ['tok-1', 'tok-2']);
  assert.deepEqual(auth.seen.invalidated, ['tok-1']);
  assert.deepEqual(auth.seen.reasons, ['initial', 'unauthorized']);
});

test('a second 401 fails with code auth after exactly two attempts', async () => {
  wire();
  mock.failNext({ status: 401, times: 2, body: 'Unauthorized' });
  await assert.rejects(get('/user-info'), (err) => err.code === 'auth' && /Unauthorized/.test(err.message));
  assert.equal(calls.length, 2);
});

test('a NO_TOKEN from the token source keeps its code', async () => {
  configure({
    url,
    getToken: async () => { throw Object.assign(new Error('HYROS did not hand over the dashboard credential'), { code: 'NO_TOKEN' }); },
    markInvalid: () => {},
  });
  await assert.rejects(get('/user-info'), (err) => err.code === 'NO_TOKEN');
  assert.equal(calls.length, 0);
});

test('a SIGN_IN from the token source keeps its code', async () => {
  configure({
    url,
    getToken: async () => { throw Object.assign(new Error('Sign in with your HYROS account'), { code: 'SIGN_IN' }); },
    markInvalid: () => {},
  });
  await assert.rejects(get('/user-info'), (err) => err.code === 'SIGN_IN');
  assert.equal(calls.length, 0);
});

const LIMIT = { result: 'ERROR', message: ['You have reached the limit of api requests, please wait before sending again.'] };

test('429 three times without Retry-After: fixed waits, three attempts, then rate_limited with the server text', async () => {
  wire();
  mock.failNext({ status: 429, times: 3, body: LIMIT });
  await assert.rejects(get('/user-info'), (err) => err.code === 'rate_limited' && /limit of api requests/.test(err.message) && err.detail.retryAfterMs === null);
  assert.equal(calls.length, 3);
  assert.deepEqual([...RATE_LIMIT_WAITS_MS], [1000, 2000]);
});

test('429 with a short Retry-After waits that long instead of the fixed wait', async () => {
  wire({ rateLimitWaitsMs: [5000, 5000] });
  mock.failNext({ status: 429, retryAfter: 0, body: LIMIT });
  const started = Date.now();
  const stages = await get('/stages');
  assert.equal(stages.result.length, 2);
  assert.equal(calls.length, 2);
  assert.ok(Date.now() - started < 4000, 'the fixed 5 s wait was used instead of Retry-After: 0');
});

test('429 with a Retry-After longer than the time left fails at once with how long to wait', async () => {
  wire();
  mock.failNext({ status: 429, retryAfter: 60, body: LIMIT });
  const started = Date.now();
  await assert.rejects(get('/user-info'), (err) => err.code === 'rate_limited' && err.detail.retryAfterMs === 60000);
  assert.equal(calls.length, 1);
  assert.ok(Date.now() - started < 2000, 'waited for a Retry-After past the call timeout');
});

test('parseRetryAfter reads seconds and HTTP dates, and ignores anything else', () => {
  const now = Date.parse('2026-10-08T12:00:00Z');
  assert.equal(parseRetryAfter('7', now), 7000);
  assert.equal(parseRetryAfter('Thu, 08 Oct 2026 12:00:30 GMT', now), 30000);
  assert.equal(parseRetryAfter('Thu, 08 Oct 2026 11:59:00 GMT', now), 0);
  assert.equal(parseRetryAfter(null, now), null);
  assert.equal(parseRetryAfter('soon', now), null);
  assert.equal(parseRetryAfter('-5', now), null);
});

test('403 is forbidden with the server text; 400 and 500 carry status and text', async () => {
  wire();
  mock.failNext({ status: 403, body: { result: 'ERROR', message: ['Forbidden, missing api key roles', 'Get Lead'] } });
  await assert.rejects(get('/leads'), (err) => err.code === 'forbidden' && /missing api key roles Get Lead/.test(err.message));
  await assert.rejects(get('/attribution', { startDate: '2026-01-01T00:00:00' }), (err) => !err.code && /HTTP 400/.test(err.message) && /required/.test(err.message));
  mock.failNext({ status: 500, body: 'gateway exploded' });
  await assert.rejects(get('/leads'), (err) => !err.code && /HTTP 500/.test(err.message) && /gateway exploded/.test(err.message));
});

test('a 200 with only a message is the reason the read could not be served', async () => {
  wire();
  await assert.rejects(
    get('/attribution', { startDate: '2026-01-01T00:00:00', endDate: '2026-01-02T00:00:00', level: 'tiktok_ad', ids: ['9007'] }),
    (err) => /^\/attribution: Ad account integration is disconnected/.test(err.message),
  );
});

test('pagination: pageSize and pageId in the query; the page cap marks truncated, an exhausted list does not', async () => {
  wire();
  mock.pages('/leads', 3, 2);
  const capped = await getPagedInfo('/leads', { fromDate: '2026-09-01' }, { maxPages: 2, pageSize: 2 });
  assert.equal(capped.rows.length, 4);
  assert.equal(capped.truncated, true);
  assert.deepEqual(calls.map((c) => c.params), [
    { fromDate: '2026-09-01', pageSize: '2' },
    { fromDate: '2026-09-01', pageSize: '2', pageId: '/leads:1' },
  ]);
  const full = await getPagedInfo('/leads', {}, { maxPages: 5, pageSize: 2 });
  assert.equal(full.rows.length, 6);
  assert.equal(full.truncated, false);
  assert.equal(full.pages, 3);
});

test('pagination: the deadline stops the walk with error time budget', async () => {
  wire();
  mock.pages('/leads', 5, 1);
  mock.latencyMs = 40;
  const out = await getPagedInfo('/leads', {}, { maxPages: 5, deadline: Date.now() + 20 });
  assert.equal(out.pages, 1);
  assert.equal(out.truncated, true);
  assert.equal(out.error, 'time budget');
});

test('pagination: an expired cursor on page 2 keeps the rows so far and marks truncated', async () => {
  wire();
  mock.pages('/leads', 3, 2);
  mock.expireCursorOn('/leads');
  const out = await getPagedInfo('/leads', {}, { maxPages: 5, pageSize: 2 });
  assert.equal(out.rows.length, 2);
  assert.equal(out.truncated, true);
  assert.match(out.error, /pageId/);
});
