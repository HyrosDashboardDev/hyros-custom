import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createAuth, createHostProvider, createOAuthProvider, pkceChallenge, AuthError, TOKEN_TIMEOUT_MS, DASHBOARD_SCOPE, OAUTH_CLIENT_NAME,
} from '../src/core/auth.js';

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

const AUTH_SERVER = 'https://mcp.example';
const PAGE = 'https://dash.example/';

/** `blocked` makes every call throw, like Safari with site data blocked. */
function fakeStorage(seed = {}, { blocked = false } = {}) {
  const map = new Map(Object.entries(seed));
  const guard = () => { if (blocked) throw new Error('SecurityError'); };
  return {
    map,
    getItem: (k) => { guard(); return map.has(k) ? map.get(k) : null; },
    setItem: (k, v) => { guard(); map.set(k, String(v)); },
    removeItem: (k) => { guard(); map.delete(k); },
  };
}

const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

function oauthSetup({ search = '', local = fakeStorage(), session = fakeStorage(), routes = {}, clock = fakeClock(), redirectUri = PAGE } = {}) {
  const requests = [];
  const assigned = [];
  const replaced = [];
  const win = {
    location: { search, href: `${PAGE}${search}`, assign: (url) => assigned.push(url) },
    history: { state: null, replaceState: (_state, _title, url) => replaced.push(url) },
  };
  const fetchFn = async (url, init) => {
    const path = new URL(url).pathname;
    const body = init.headers['content-type'] === 'application/json' ? JSON.parse(init.body) : Object.fromEntries(new URLSearchParams(init.body));
    requests.push({ path, body });
    const route = routes[path];
    if (!route) return json(404, { error: 'not_found' });
    return route(body, requests.filter((r) => r.path === path).length);
  };
  const provider = createOAuthProvider({ authServer: AUTH_SERVER, redirectUri, win, fetchFn, local, session, now: clock.now });
  const auth = createAuth({ provider, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  return { provider, auth, requests, assigned, replaced, local, session, clock };
}

const registered = () => json(201, { client_id: 'client-1' });
const tokens = (n, { scope = `${DASHBOARD_SCOPE}`, expiresIn = 900 } = {}) => json(200, {
  access_token: `access-${n}`, refresh_token: `refresh-${n}`, token_type: 'Bearer', expires_in: expiresIn, scope,
});
const attemptOf = (session) => JSON.parse(session.map.get('hyros-dashboard-oauth-attempt'));
const pendingSignIn = (extra = {}) => fakeStorage({
  'hyros-dashboard-oauth-attempt': JSON.stringify({ state: 'st-1', verifier: 'ver-1', clientId: 'client-1', redirectUri: PAGE, ...extra }),
});

test('oauth: signIn registers the page once and sends the user to the HYROS sign-in with PKCE and the read scope', async () => {
  const { provider, requests, assigned, local, session } = oauthSetup({ routes: { '/connect/register': registered } });

  await provider.signIn();

  assert.deepEqual(requests.map((r) => r.path), ['/connect/register']);
  assert.deepEqual(requests[0].body, {
    client_name: OAUTH_CLIENT_NAME,
    redirect_uris: [PAGE],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    scope: 'mcp:read',
  });
  assert.deepEqual(JSON.parse(local.map.get('hyros-dashboard-oauth-client')), { authServer: AUTH_SERVER, redirectUri: PAGE, clientId: 'client-1' });

  const url = new URL(assigned[0]);
  const attempt = attemptOf(session);
  assert.equal(`${url.origin}${url.pathname}`, `${AUTH_SERVER}/oauth2/authorize`);
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('client_id'), 'client-1');
  assert.equal(url.searchParams.get('redirect_uri'), PAGE);
  assert.equal(url.searchParams.get('scope'), 'mcp:read');
  assert.equal(url.searchParams.get('state'), attempt.state);
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('code_challenge'), await pkceChallenge(attempt.verifier));
  assert.ok(attempt.verifier.length >= 43, 'the verifier has at least 256 bits');

  await provider.signIn();
  assert.equal(requests.length, 1, 'the cached client id is reused');
  assert.notEqual(new URL(assigned[1]).searchParams.get('state'), attempt.state, 'every sign-in gets a new state');
});

test('oauth: a client registered for another redirect uri or server is registered again', async () => {
  const local = fakeStorage({ 'hyros-dashboard-oauth-client': JSON.stringify({ authServer: AUTH_SERVER, redirectUri: 'https://other.example/', clientId: 'old' }) });
  const { provider, requests, assigned } = oauthSetup({ local, routes: { '/connect/register': registered } });
  await provider.signIn();
  assert.equal(requests.length, 1);
  assert.equal(new URL(assigned[0]).searchParams.get('client_id'), 'client-1');
});

test('oauth: the code HYROS redirects back with is redeemed with the verifier, the url cleaned, and the token used', async () => {
  const session = pendingSignIn();
  const { provider, auth, requests, replaced, clock } = oauthSetup({
    search: '?mcp=qa&code=the-code&state=st-1',
    session,
    routes: { '/oauth2/token': () => tokens(1) },
  });

  assert.deepEqual(replaced, [`${PAGE}?mcp=qa`], 'code and state leave the address bar at once, ?mcp= stays');
  assert.equal(provider.hasCallback(), true);

  assert.equal(await auth.getToken(), 'access-1');
  assert.deepEqual(requests, [{
    path: '/oauth2/token',
    body: { grant_type: 'authorization_code', code: 'the-code', redirect_uri: PAGE, client_id: 'client-1', code_verifier: 'ver-1' },
  }]);
  assert.equal(session.map.size, 0, 'the verifier is gone once used');
  assert.equal(provider.hasCallback(), false);
  assert.equal(auth.state(), 'ready');
  assert.equal(clock.pending(), 1, 'expires_in schedules the background renewal');
});

test('oauth: a state that does not match is refused without calling HYROS', async () => {
  const { auth, requests, session } = oauthSetup({ search: '?code=c&state=forged', session: pendingSignIn() });
  await assert.rejects(auth.getToken(), (err) => err.code === 'SIGN_IN');
  assert.equal(requests.length, 0);
  assert.equal(session.map.size, 0);
});

test('oauth: a code with no sign-in started in this tab is refused', async () => {
  const { auth, requests } = oauthSetup({ search: '?code=c&state=st-1' });
  await assert.rejects(auth.getToken(), (err) => err.code === 'SIGN_IN');
  assert.equal(requests.length, 0);
});

test('oauth: an error HYROS redirects back with asks to sign in again, with its description', async () => {
  const { auth, requests } = oauthSetup({ search: '?error=access_denied&error_description=User+said+no&state=st-1', session: pendingSignIn() });
  await assert.rejects(auth.getToken(), (err) => err.code === 'SIGN_IN' && /User said no/.test(err.message));
  assert.equal(requests.length, 0);
});

test('oauth: a code HYROS refuses asks to sign in again', async () => {
  const { auth } = oauthSetup({
    search: '?code=c&state=st-1',
    session: pendingSignIn(),
    routes: { '/oauth2/token': () => json(400, { error: 'invalid_grant' }) },
  });
  await assert.rejects(auth.getToken(), (err) => err.code === 'SIGN_IN');
});

test('oauth: a credential without the read scope is refused', async () => {
  const { auth } = oauthSetup({
    search: '?code=c&state=st-1',
    session: pendingSignIn(),
    routes: { '/oauth2/token': () => tokens(1, { scope: 'openid mcp' }) },
  });
  await assert.rejects(auth.getToken(), (err) => err.code === 'SIGN_IN' && /read-only/.test(err.message));
});

test('oauth: with no code and no session, getToken asks to sign in without calling HYROS', async () => {
  const { provider, auth, requests } = oauthSetup();
  assert.equal(provider.hasCallback(), false);
  assert.equal(provider.wasAbandoned(), false);
  await assert.rejects(auth.getToken(), (err) => err instanceof AuthError && err.code === 'SIGN_IN');
  assert.equal(requests.length, 0);
});

test('oauth: after a 401 the session refreshes with the latest refresh token; concurrent requests share one refresh', async () => {
  let n = 1;
  const { auth, requests } = oauthSetup({
    search: '?code=c&state=st-1',
    session: pendingSignIn(),
    routes: { '/oauth2/token': () => tokens(n++) },
  });
  assert.equal(await auth.getToken(), 'access-1');

  auth.markInvalid('access-1');
  const [a, b] = await Promise.all([auth.getToken('unauthorized'), auth.getToken('unauthorized')]);
  assert.deepEqual([a, b], ['access-2', 'access-2']);

  auth.markInvalid('access-2');
  assert.equal(await auth.getToken('unauthorized'), 'access-3');

  const refreshes = requests.filter((r) => r.body.grant_type === 'refresh_token').map((r) => r.body);
  assert.deepEqual(refreshes, [
    { grant_type: 'refresh_token', refresh_token: 'refresh-1', client_id: 'client-1' },
    { grant_type: 'refresh_token', refresh_token: 'refresh-2', client_id: 'client-1' },
  ]);
});

test('oauth: the token is renewed in the background 2 min before it expires', async () => {
  let n = 1;
  const { auth, requests, clock } = oauthSetup({
    search: '?code=c&state=st-1',
    session: pendingSignIn(),
    routes: { '/oauth2/token': () => tokens(n++, { expiresIn: 600 }) },
  });
  assert.equal(await auth.getToken(), 'access-1');
  await clock.advance(8 * 60_000);
  assert.equal(requests.at(-1).body.grant_type, 'refresh_token');
  assert.equal(await auth.getToken(), 'access-2');
});

test('oauth: a revoked session (invalid_grant on refresh) asks to sign in and stops refreshing', async () => {
  let n = 1;
  const { auth, requests } = oauthSetup({
    search: '?code=c&state=st-1',
    session: pendingSignIn(),
    routes: { '/oauth2/token': (body) => (body.grant_type === 'refresh_token' ? json(400, { error: 'invalid_grant' }) : tokens(n++)) },
  });
  await auth.getToken();
  auth.markInvalid('access-1');
  await assert.rejects(auth.getToken('unauthorized'), (err) => err.code === 'SIGN_IN');
  const before = requests.length;
  await assert.rejects(auth.getToken('retry'), (err) => err.code === 'SIGN_IN');
  assert.equal(requests.length, before, 'no second refresh with a dead token');
});

test('oauth: invalid_client forgets the registered client', async () => {
  const local = fakeStorage({ 'hyros-dashboard-oauth-client': JSON.stringify({ authServer: AUTH_SERVER, redirectUri: PAGE, clientId: 'client-1' }) });
  const { auth } = oauthSetup({
    search: '?code=c&state=st-1',
    session: pendingSignIn(),
    local,
    routes: { '/oauth2/token': () => json(401, { error: 'invalid_client' }) },
  });
  await assert.rejects(auth.getToken(), (err) => err.code === 'SIGN_IN');
  assert.equal(local.map.has('hyros-dashboard-oauth-client'), false);
});

test('oauth: HYROS unreachable on refresh is NO_TOKEN and keeps the session for Try again', async () => {
  let n = 1;
  let down = false;
  const { auth } = oauthSetup({
    search: '?code=c&state=st-1',
    session: pendingSignIn(),
    routes: { '/oauth2/token': () => { if (down) throw new TypeError('Failed to fetch'); return tokens(n++); } },
  });
  await auth.getToken();
  auth.markInvalid('access-1');
  down = true;
  await assert.rejects(auth.getToken('unauthorized'), (err) => err.code === 'NO_TOKEN');
  down = false;
  assert.equal(await auth.getToken('retry'), 'access-2');
});

test('oauth: a sign-in that never came back forgets the client, so the next one registers again', async () => {
  const local = fakeStorage({ 'hyros-dashboard-oauth-client': JSON.stringify({ authServer: AUTH_SERVER, redirectUri: PAGE, clientId: 'stale' }) });
  const session = pendingSignIn({ clientId: 'stale' });
  const { provider, requests, assigned } = oauthSetup({ local, session, routes: { '/connect/register': registered } });
  assert.equal(provider.wasAbandoned(), true);
  assert.equal(local.map.size, 0);
  await provider.signIn();
  assert.deepEqual(requests.map((r) => r.path), ['/connect/register']);
  assert.equal(new URL(assigned[0]).searchParams.get('client_id'), 'client-1');
});

test('oauth: blocked storage fails signIn with a clear message and no redirect', async () => {
  const blocked = fakeStorage({}, { blocked: true });
  const { provider, assigned } = oauthSetup({ local: blocked, session: blocked, routes: { '/connect/register': registered } });
  await assert.rejects(provider.signIn(), (err) => err instanceof AuthError && /storage/.test(err.message));
  assert.equal(assigned.length, 0);
});

test('oauth: a failed registration is NO_TOKEN with the status and no redirect', async () => {
  const { provider, assigned } = oauthSetup({ routes: { '/connect/register': () => json(500, null) } });
  await assert.rejects(provider.signIn(), (err) => err.code === 'NO_TOKEN' && /HTTP 500/.test(err.message));
  assert.equal(assigned.length, 0);
});
