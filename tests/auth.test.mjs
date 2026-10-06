import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAuth, createHostProvider, AuthError, TOKEN_TIMEOUT_MS } from '../src/core/auth.js';

const HOST = 'http://localhost:4323';
const ORIGINS = ['https://app.hyros.com', HOST];

/** A clock with timers that only fire when the test advances it. */
function fakeClock(start = 1_000_000) {
  let t = start;
  let seq = 0;
  const timers = new Map();
  return {
    now: () => t,
    setTimer: (fn, ms) => { const id = ++seq; timers.set(id, { at: t + ms, fn }); return id; },
    clearTimer: (id) => { timers.delete(id); },
    pending: () => timers.size,
    async advance(ms) {
      const until = t + ms;
      for (;;) {
        const next = [...timers.entries()].filter(([, v]) => v.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        timers.delete(next[0]);
        t = next[1].at;
        next[1].fn();
        await flush();
      }
      t = until;
      await flush();
    },
  };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

/** A window inside a frame: records what it posts to its parent and lets the test deliver messages. */
function fakeWin({ embedded = true } = {}) {
  const listeners = new Set();
  const posted = [];
  const parent = { postMessage: (data, targetOrigin) => posted.push({ data, targetOrigin }) };
  const win = {
    posted,
    addEventListener: (type, fn) => { if (type === 'message') listeners.add(fn); },
    removeEventListener: (type, fn) => { if (type === 'message') listeners.delete(fn); },
    deliver: (event) => { for (const fn of listeners) fn(event); },
  };
  win.parent = embedded ? parent : win;
  return win;
}

function setup({ embedded = true } = {}) {
  const clock = fakeClock();
  const win = fakeWin({ embedded });
  const provider = createHostProvider({ win, origins: ORIGINS, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  const auth = createAuth({ provider, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  const sendToken = (data, { origin = HOST, source = win.parent } = {}) => win.deliver({ origin, source, data });
  return { clock, win, provider, auth, sendToken };
}

test('the first request posts ready once per allowed origin, with that origin as target', async () => {
  const { win, auth, sendToken } = setup();
  const got = auth.getToken('initial');
  assert.deepEqual(win.posted.map((p) => p.targetOrigin), ORIGINS);
  for (const { data } of win.posted) {
    assert.deepEqual(data, { type: 'ready', version: 1 });
    assert.equal(typeof data.version, 'number');
    assert.equal('source' in data, false);
  }
  sendToken({ type: 'token', version: 1, token: 't1' });
  assert.equal(await got, 't1');
});

test('tokens from an unlisted origin, another window, a string version or without a token are ignored', async () => {
  const { auth, sendToken, clock } = setup();
  const got = auth.getToken('initial');
  sendToken({ type: 'token', version: 1, token: 'evil' }, { origin: 'https://evil.example' });
  sendToken({ type: 'token', version: 1, token: 'evil' }, { source: {} });
  sendToken({ type: 'token', version: '1', token: 'evil' });
  sendToken({ type: 'token', version: 1 });
  sendToken({ type: 'token', version: 1, token: '' });
  sendToken('token');
  await flush();
  assert.equal(auth.state(), 'waiting');
  sendToken({ type: 'token', version: 1, token: 'good' });
  assert.equal(await got, 'good');
  assert.equal(clock.pending(), 0);
});

test('a token without expiresAt schedules no renewal and is reused', async () => {
  const { win, auth, sendToken, clock } = setup();
  const got = auth.getToken('initial');
  sendToken({ type: 'token', version: 1, token: 't1' });
  await got;
  assert.equal(clock.pending(), 0);
  assert.equal(await auth.getToken(), 't1');
  assert.equal(win.posted.length, ORIGINS.length);
  assert.equal(auth.state(), 'ready');
});

test('a token with expiresAt is renewed in the background 2 min before it expires', async () => {
  const { win, auth, sendToken, clock } = setup();
  const got = auth.getToken('initial');
  sendToken({ type: 'token', version: 1, token: 't1', expiresAt: clock.now() + 5 * 60_000 });
  await got;
  assert.equal(clock.pending(), 1);

  const states = [];
  auth.onChange((s) => states.push(s));
  win.posted.length = 0;
  await clock.advance(3 * 60_000 - 1);
  assert.equal(win.posted.length, 0);
  await clock.advance(1);
  assert.equal(win.posted.length, ORIGINS.length);
  assert.deepEqual(win.posted[0].data, { type: 'token-request', version: 1, reason: 'expiring' });

  sendToken({ type: 'token', version: 1, token: 't2', expiresAt: clock.now() + 15 * 60_000 });
  await flush();
  assert.equal(await auth.getToken(), 't2');
  assert.equal(auth.state(), 'ready');
  assert.deepEqual(states, []);
});

test('an expiresAt in the past or not a number is treated as absent', async () => {
  const { auth, sendToken, clock } = setup();
  const got = auth.getToken('initial');
  sendToken({ type: 'token', version: 1, token: 't1', expiresAt: clock.now() - 1 });
  await got;
  assert.equal(clock.pending(), 0);
  assert.equal(await auth.getToken(), 't1');
});

test('markInvalid then getToken(unauthorized) posts a token-request with that reason', async () => {
  const { win, auth, sendToken } = setup();
  const first = auth.getToken('initial');
  sendToken({ type: 'token', version: 1, token: 't1' });
  await first;

  auth.markInvalid('other');
  assert.equal(await auth.getToken(), 't1');

  win.posted.length = 0;
  auth.markInvalid('t1');
  const second = auth.getToken('unauthorized');
  assert.deepEqual(win.posted[0].data, { type: 'token-request', version: 1, reason: 'unauthorized' });
  sendToken({ type: 'token', version: 1, token: 't2' });
  assert.equal(await second, 't2');
});

test('no answer within 10 s rejects NO_TOKEN and leaves state missing; retry asks with reason retry', async () => {
  const { win, auth, clock, sendToken } = setup();
  const got = auth.getToken('initial');
  assert.equal(auth.state(), 'waiting');
  const failed = assert.rejects(got, (err) => err instanceof AuthError && err.code === 'NO_TOKEN');
  await clock.advance(TOKEN_TIMEOUT_MS);
  await failed;
  assert.equal(auth.state(), 'missing');

  win.posted.length = 0;
  const retry = auth.getToken('retry');
  assert.deepEqual(win.posted[0].data, { type: 'token-request', version: 1, reason: 'retry' });
  sendToken({ type: 'token', version: 1, token: 't1' });
  assert.equal(await retry, 't1');
  assert.equal(auth.state(), 'ready');
});

test('concurrent requests share one round trip', async () => {
  const { win, auth, sendToken } = setup();
  const a = auth.getToken('initial');
  const b = auth.getToken('initial');
  assert.equal(win.posted.length, ORIGINS.length);
  sendToken({ type: 'token', version: 1, token: 't1' });
  assert.deepEqual(await Promise.all([a, b]), ['t1', 't1']);
});

test('outside a frame: not embedded, and getToken rejects without posting', async () => {
  const { win, auth } = setup({ embedded: false });
  assert.equal(auth.isEmbedded(), false);
  await assert.rejects(auth.getToken('initial'), (err) => err.code === 'NO_TOKEN');
  assert.equal(win.posted.length, 0);
  assert.equal(auth.state(), 'missing');
});
