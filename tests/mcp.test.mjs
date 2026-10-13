import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startMock, mock, calls } from '../scripts/mock-mcp.mjs';
import { configure, callTool, callToolPagedInfo, listTools, parseRetryAfter, RATE_LIMIT_WAITS_MS } from '../src/core/mcp.js';

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
  url = `http://127.0.0.1:${server.address().port}/mcp`;
});
after(() => server.close());
beforeEach(() => {
  mock.reset();
  calls.length = 0;
});

test('before configure every call fails NO_TOKEN without a request', async () => {
  await assert.rejects(callTool('hyros_get_user_info'), (err) => err.code === 'NO_TOKEN');
  assert.equal(calls.length, 0);
});

test('sends the Bearer token and nothing else', async () => {
  wire();
  const realFetch = globalThis.fetch;
  const seenHeaders = [];
  globalThis.fetch = (input, init) => { seenHeaders.push(init.headers); return realFetch(input, init); };
  try {
    const user = await callTool('hyros_get_user_info');
    assert.equal(user.userProfile.email, 'mock@hyros.test');
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(seenHeaders.length, 1);
  const names = Object.keys(seenHeaders[0]).map((h) => h.toLowerCase()).sort();
  assert.deepEqual(names, ['accept', 'authorization', 'content-type']);
  assert.equal(seenHeaders[0].authorization, 'Bearer tok-1');
  assert.deepEqual(calls.map((c) => c.token), ['tok-1']);
});

test('a tool outside READ_TOOLS fails not_allowed before touching the network', async () => {
  wire();
  await assert.rejects(callTool('hyros_create_lead', { request: { email: 'x@y.z' } }), (err) => err.code === 'not_allowed');
  assert.equal(calls.length, 0);
});

test('two identical calls in flight share one request', async () => {
  wire();
  mock.latencyMs = 30;
  const [a, b] = await Promise.all([callTool('hyros_get_stages', { request: {} }), callTool('hyros_get_stages', { request: {} })]);
  assert.deepEqual(a, b);
  assert.equal(calls.length, 1);
  await callTool('hyros_get_stages', { request: {} });
  assert.equal(calls.length, 2, 'a finished call is not cached');
});

test('a 401 drops the token, asks for a new one and retries once', async () => {
  wire();
  mock.failNext({ status: 401, body: { error: 'invalid token' } });
  const user = await callTool('hyros_get_user_info');
  assert.equal(user.userProfile.email, 'mock@hyros.test');
  assert.deepEqual(calls.map((c) => c.token), ['tok-1', 'tok-2']);
  assert.deepEqual(auth.seen.invalidated, ['tok-1']);
  assert.deepEqual(auth.seen.reasons, ['initial', 'unauthorized']);
});

test('a second 401 fails with code auth after exactly two attempts', async () => {
  wire();
  mock.failNext({ status: 401, times: 2, body: { error: 'invalid token' } });
  await assert.rejects(callTool('hyros_get_user_info'), (err) => err.code === 'auth' && /invalid token/.test(err.message));
  assert.equal(calls.length, 2);
});

test('a NO_TOKEN from the token source keeps its code', async () => {
  configure({
    url,
    getToken: async () => { throw Object.assign(new Error('HYROS did not hand over the dashboard credential'), { code: 'NO_TOKEN' }); },
    markInvalid: () => {},
  });
  await assert.rejects(callTool('hyros_get_user_info'), (err) => err.code === 'NO_TOKEN');
  assert.equal(calls.length, 0);
});

test('429 three times without Retry-After: fixed waits, three attempts, then rate_limited with the server text', async () => {
  wire();
  mock.failNext({ status: 429, times: 3, body: { error: 'You have reached the request limit' } });
  await assert.rejects(callTool('hyros_get_user_info'), (err) => err.code === 'rate_limited' && /request limit/.test(err.message) && err.detail.retryAfterMs === null);
  assert.equal(calls.length, 3);
  assert.deepEqual([...RATE_LIMIT_WAITS_MS], [1000, 2000]);
});

test('429 with a short Retry-After waits that long instead of the fixed wait', async () => {
  wire({ rateLimitWaitsMs: [5000, 5000] });
  mock.failNext({ status: 429, retryAfter: 0, body: { error: 'You have reached the request limit' } });
  const started = Date.now();
  const stages = await callTool('hyros_get_stages', { request: {} });
  assert.equal(stages.result.length, 2);
  assert.equal(calls.length, 2);
  assert.ok(Date.now() - started < 4000, 'the fixed 5 s wait was used instead of Retry-After: 0');
});

test('429 with a Retry-After longer than the time left fails at once with how long to wait', async () => {
  wire();
  mock.failNext({ status: 429, retryAfter: 60, body: { error: 'You have reached the request limit' } });
  const started = Date.now();
  await assert.rejects(callTool('hyros_get_user_info'), (err) => err.code === 'rate_limited' && err.detail.retryAfterMs === 60000);
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

test('a SIGN_IN from the token source keeps its code', async () => {
  configure({
    url,
    getToken: async () => { throw Object.assign(new Error('Sign in with your HYROS account'), { code: 'SIGN_IN' }); },
    markInvalid: () => {},
  });
  await assert.rejects(callTool('hyros_get_user_info'), (err) => err.code === 'SIGN_IN');
  assert.equal(calls.length, 0);
});

test('429 once then success returns the result', async () => {
  wire();
  mock.failNext({ status: 429, body: { error: 'You have reached the request limit' } });
  const stages = await callTool('hyros_get_stages', { request: {} });
  assert.equal(stages.result.length, 2);
  assert.equal(calls.length, 2);
});

test('403 is forbidden with the server text; 500 carries status and text', async () => {
  wire();
  mock.failNext({ status: 403, body: { error: 'missing role API_GET_LEADS' } });
  await assert.rejects(callTool('hyros_get_leads', { request: {} }), (err) => err.code === 'forbidden' && /API_GET_LEADS/.test(err.message));
  mock.failNext({ status: 500, body: 'gateway exploded' });
  await assert.rejects(callTool('hyros_get_leads', { request: {} }), (err) => !err.code && /HTTP 500/.test(err.message) && /gateway exploded/.test(err.message));
});

test('pagination: the page cap marks truncated, an exhausted list does not', async () => {
  wire();
  mock.pages('hyros_get_leads', 3, 2);
  const capped = await callToolPagedInfo('hyros_get_leads', { request: {} }, { maxPages: 2, pageSize: 2 });
  assert.equal(capped.rows.length, 4);
  assert.equal(capped.truncated, true);
  const full = await callToolPagedInfo('hyros_get_leads', { request: {} }, { maxPages: 5, pageSize: 2 });
  assert.equal(full.rows.length, 6);
  assert.equal(full.truncated, false);
  assert.equal(full.pages, 3);
});

test('pagination: the deadline stops the walk with error time budget', async () => {
  wire();
  mock.pages('hyros_get_leads', 5, 1);
  mock.latencyMs = 40;
  const out = await callToolPagedInfo('hyros_get_leads', { request: {} }, { maxPages: 5, deadline: Date.now() + 20 });
  assert.equal(out.pages, 1);
  assert.equal(out.truncated, true);
  assert.equal(out.error, 'time budget');
});

test('pagination: an expired cursor on page 2 keeps the rows so far and marks truncated', async () => {
  wire();
  mock.pages('hyros_get_leads', 3, 2);
  mock.expireCursorOn('hyros_get_leads');
  const out = await callToolPagedInfo('hyros_get_leads', { request: {} }, { maxPages: 5, pageSize: 2 });
  assert.equal(out.rows.length, 2);
  assert.equal(out.truncated, true);
  assert.match(out.error, /pageId/);
});

test('an SSE-framed answer is parsed', async () => {
  wire();
  mock.sse = true;
  const user = await callTool('hyros_get_user_info');
  assert.equal(user.userProfile.email, 'mock@hyros.test');
  assert.ok((await listTools()).includes('hyros_get_user_info'));
});

test('a tool error is surfaced with the tool name', async () => {
  wire();
  await assert.rejects(
    callTool('hyros_get_attribution_report', { request: { ids: ['9001'], level: 'google_ad', startDate: '2026-01-01', endDate: '2026-01-02' } }),
    (err) => /hyros_get_attribution_report: Unsupported level/.test(err.message),
  );
});
