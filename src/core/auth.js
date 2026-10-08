/**
 * The dashboard credential. Inside HYROS (an iframe) HYROS hands it over
 * postMessage (createHostProvider); at its own url the page signs in through
 * the MCP OAuth server with the read-only scope (createOAuthProvider).
 *
 * Contract v1 of the iframe side (docs/PROTOCOL.md):
 *   dashboard -> host   { type: 'ready', version: 1 }                     first request
 *   dashboard -> host   { type: 'token-request', version: 1, reason }     every later request
 *   host -> dashboard   { type: 'token', version: 1, token, expiresAt? }
 *
 * Tokens live only in memory, inside createAuth and the OAuth provider. They
 * are never written to storage, a cookie, the url or a log line.
 */
import { CONFIG } from './config.js';

export const PROTOCOL_VERSION = 1;
/** How long to wait for the host to answer one request. */
export const TOKEN_TIMEOUT_MS = 10000;
/** A token with an `expiresAt` is renewed this long before it expires. */
export const RENEW_LEAD_MS = 120000;

const TOKEN_REQUEST_REASONS = new Set(['expiring', 'unauthorized', 'retry']);

/** `code` is 'NO_TOKEN', or 'SIGN_IN' when the user has to sign in again. */
export class AuthError extends Error {
  constructor(message = 'HYROS did not hand over the dashboard credential', code = 'NO_TOKEN') {
    super(message);
    this.name = 'AuthError';
    this.code = code;
  }
}

/**
 * The postMessage side of the contract.
 *   isAvailable()    true when the page runs inside a frame
 *   request(reason)  asks the host for a token; resolves { token, expiresAt? } or rejects AuthError
 *   dispose()        stops listening
 *
 * A request is posted once per allowed origin, each with that origin as the
 * target, so the browser only delivers it if the parent really is that origin.
 * Concurrent requests share one promise. A token that arrives while nothing is
 * pending is ignored.
 */
export function createHostProvider({
  win = globalThis.window,
  origins = CONFIG.hostOrigins,
  timeoutMs = TOKEN_TIMEOUT_MS,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  const available = Boolean(win) && win.parent != null && win.parent !== win;
  let pending = null;
  let announced = false;

  function onMessage(event) {
    if (!pending) return;
    if (event.source !== win.parent || !origins.includes(event.origin)) return;
    const data = event.data;
    if (!data || typeof data !== 'object') return;
    if (data.type !== 'token' || data.version !== PROTOCOL_VERSION) return;
    if (typeof data.token !== 'string' || !data.token) return;
    const grant = { token: data.token };
    if (Number.isFinite(data.expiresAt) && data.expiresAt > now()) grant.expiresAt = data.expiresAt;
    const { resolve, timer } = pending;
    pending = null;
    clearTimer(timer);
    resolve(grant);
  }

  if (available) win.addEventListener('message', onMessage);

  function request(reason) {
    if (!available) return Promise.reject(new AuthError('This dashboard is not embedded in HYROS'));
    if (pending) return pending.promise;

    // The first request is the `ready` HYROS already answers; later ones say why they ask.
    const message = announced
      ? { type: 'token-request', version: PROTOCOL_VERSION, reason: TOKEN_REQUEST_REASONS.has(reason) ? reason : 'retry' }
      : { type: 'ready', version: PROTOCOL_VERSION };
    announced = true;

    let resolve;
    let reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    const timer = setTimer(() => {
      pending = null;
      reject(new AuthError());
    }, timeoutMs);
    pending = { promise, resolve, timer };

    for (const origin of origins) {
      try { win.parent.postMessage(message, origin); } catch { /* malformed origin in config: skip it */ }
    }
    return promise;
  }

  function dispose() {
    if (available) win.removeEventListener('message', onMessage);
    if (pending) clearTimer(pending.timer);
    pending = null;
  }

  return { isAvailable: () => available, request, dispose };
}

export const OAUTH_PATHS = Object.freeze({
  register: '/connect/register',
  authorize: '/oauth2/authorize',
  token: '/oauth2/token',
});
/** HYROS issues a read-only credential, accepted at /mcp only, for this scope. */
export const DASHBOARD_SCOPE = 'mcp:read';
export const OAUTH_CLIENT_NAME = 'HYROS Custom Dashboard';
export const OAUTH_TIMEOUT_MS = 15000;
const CLIENT_KEY = 'hyros-dashboard-oauth-client';
const ATTEMPT_KEY = 'hyros-dashboard-oauth-attempt';
const CALLBACK_PARAMS = ['code', 'state', 'error', 'error_description', 'error_uri', 'iss'];

/** Null where the browser blocks site data. */
function storageOf(name) {
  try { return globalThis[name] || null; } catch { return null; }
}

function readJson(storage, key) {
  try { return JSON.parse(storage?.getItem(key) || 'null'); } catch { return null; }
}

function writeJson(storage, key, value) {
  try {
    if (!storage) return false;
    storage.setItem(key, JSON.stringify(value));
    return true;
  } catch { return false; }
}

function removeKey(storage, key) {
  try { storage?.removeItem(key); } catch { /* nothing to remove */ }
}

function base64url(bytes) {
  return btoa(String.fromCodePoint(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

export async function pkceChallenge(verifier, crypto = globalThis.crypto) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

function readCallback(search) {
  const params = new URLSearchParams(search);
  if (!params.has('code') && !params.has('error')) return null;
  return {
    code: params.get('code'),
    state: params.get('state'),
    error: params.get('error'),
    errorDescription: params.get('error_description'),
  };
}

/**
 * Authorization code with PKCE as a public client, same interface as
 * createHostProvider. The client id is kept in localStorage, state and
 * verifier in sessionStorage until HYROS redirects back, tokens in memory.
 *   request()      the code HYROS redirected back with, else a refresh; rejects 'SIGN_IN'
 *   hasCallback()  whether this page load is HYROS redirecting back
 *   wasAbandoned() whether a sign-in started in this tab never came back (the user went back)
 *   signIn()       registers the page once, then leaves for the HYROS sign-in
 */
export function createOAuthProvider({
  authServer,
  redirectUri,
  win = globalThis.window,
  fetchFn = (...args) => globalThis.fetch(...args),
  crypto = globalThis.crypto,
  local = storageOf('localStorage'),
  session = storageOf('sessionStorage'),
  now = Date.now,
  timeoutMs = OAUTH_TIMEOUT_MS,
}) {
  let callback = readCallback(win.location.search);
  let refreshToken = null;
  let clientId = null;
  let pending = null;
  let abandoned = false;

  if (callback) {
    const clean = new URL(win.location.href);
    for (const name of CALLBACK_PARAMS) clean.searchParams.delete(name);
    win.history.replaceState(win.history.state, '', clean.href);
  } else if (readJson(session, ATTEMPT_KEY)) {
    // A sign-in that never came back: HYROS does not redirect for a client id it does not know, so register again.
    abandoned = true;
    removeKey(session, ATTEMPT_KEY);
    removeKey(local, CLIENT_KEY);
  }

  const signInError = (message) => new AuthError(message, 'SIGN_IN');

  async function call(path, init) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetchFn(new URL(path, authServer).href, { ...init, signal: ctrl.signal });
      let body = null;
      try { body = await res.json(); } catch { /* not JSON */ }
      return { ok: res.ok, status: res.status, body };
    } catch (err) {
      throw new AuthError(err?.name === 'AbortError' ? 'HYROS took too long to answer the sign-in' : 'Could not reach HYROS to sign in');
    } finally {
      clearTimeout(timer);
    }
  }

  async function registeredClient() {
    const cached = readJson(local, CLIENT_KEY);
    if (cached?.authServer === authServer && cached?.redirectUri === redirectUri && typeof cached.clientId === 'string') {
      return cached.clientId;
    }
    const res = await call(OAUTH_PATHS.register, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        client_name: OAUTH_CLIENT_NAME,
        redirect_uris: [redirectUri],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
        scope: DASHBOARD_SCOPE,
      }),
    });
    const id = res.body?.client_id;
    if (!res.ok || typeof id !== 'string' || !id) {
      throw new AuthError(`HYROS could not register this dashboard for sign-in (HTTP ${res.status})`);
    }
    writeJson(local, CLIENT_KEY, { authServer, redirectUri, clientId: id });
    return id;
  }

  async function signIn() {
    const id = await registeredClient();
    const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
    const state = base64url(crypto.getRandomValues(new Uint8Array(16)));
    if (!writeJson(session, ATTEMPT_KEY, { state, verifier, clientId: id, redirectUri })) {
      throw new AuthError('This browser blocks the storage the HYROS sign-in needs. Allow site data for this page and try again.');
    }
    const url = new URL(OAUTH_PATHS.authorize, authServer);
    url.search = new URLSearchParams({
      response_type: 'code',
      client_id: id,
      redirect_uri: redirectUri,
      scope: DASHBOARD_SCOPE,
      state,
      code_challenge: await pkceChallenge(verifier, crypto),
      code_challenge_method: 'S256',
    }).toString();
    win.location.assign(url.href);
  }

  /** Any OAuth error ends the session: neither a code nor a refused refresh token works twice. */
  async function token(params, refused) {
    const res = await call(OAUTH_PATHS.token, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams(params).toString(),
    });
    if (res.ok) return adopt(res.body);
    const error = typeof res.body?.error === 'string' ? res.body.error : null;
    if (error || res.status === 400 || res.status === 401) {
      refreshToken = null;
      if (error === 'invalid_client') removeKey(local, CLIENT_KEY);
      throw signInError(refused);
    }
    throw new AuthError(`HYROS could not renew the dashboard credential (HTTP ${res.status})`);
  }

  function adopt(body) {
    if (typeof body?.access_token !== 'string' || !body.access_token) {
      throw new AuthError('HYROS answered the sign-in without a credential');
    }
    if (!String(body.scope || '').split(' ').includes(DASHBOARD_SCOPE)) {
      refreshToken = null;
      throw signInError('HYROS did not grant read-only access to this dashboard. Sign in again.');
    }
    refreshToken = typeof body.refresh_token === 'string' && body.refresh_token ? body.refresh_token : null;
    const grant = { token: body.access_token };
    const seconds = Number(body.expires_in);
    if (Number.isFinite(seconds) && seconds > 0) grant.expiresAt = now() + seconds * 1000;
    return grant;
  }

  async function redeem(answer) {
    const attempt = readJson(session, ATTEMPT_KEY);
    removeKey(session, ATTEMPT_KEY);
    if (answer.error) {
      throw signInError(`HYROS did not sign you in: ${answer.errorDescription || answer.error}`);
    }
    if (!attempt || !answer.code || attempt.state !== answer.state) {
      throw signInError('This sign-in was not started from this page. Sign in again.');
    }
    clientId = attempt.clientId;
    return token({
      grant_type: 'authorization_code',
      code: answer.code,
      redirect_uri: attempt.redirectUri,
      client_id: attempt.clientId,
      code_verifier: attempt.verifier,
    }, 'HYROS did not accept this sign-in. Sign in again.');
  }

  function obtain() {
    if (callback) {
      const answer = callback;
      callback = null;
      return redeem(answer);
    }
    if (refreshToken) {
      return token({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId }, 'Your HYROS session ended. Sign in again.');
    }
    return Promise.reject(signInError('Sign in with your HYROS account to see this dashboard.'));
  }

  function request() {
    if (!pending) pending = obtain().finally(() => { pending = null; });
    return pending;
  }

  return {
    isAvailable: () => true,
    request,
    hasCallback: () => callback !== null,
    wasAbandoned: () => abandoned,
    signIn,
    dispose: () => {},
  };
}

/**
 * Holds the current token and decides when to ask for a new one.
 *   getToken(reason)   the current token, or a new one from the provider
 *   markInvalid(token) drops the current token if it is that one (after a 401)
 *   isEmbedded()       whether a provider can answer at all
 *   state()            'idle' | 'waiting' | 'ready' | 'missing'
 *   onChange(cb)       cb(state) on every change; returns the unsubscribe
 *
 * With `expiresAt` the token is renewed in the background `renewLeadMs`
 * before it expires, without changing state(). Without it the token is kept
 * until the MCP answers 401.
 */
export function createAuth({
  provider,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  renewLeadMs = RENEW_LEAD_MS,
}) {
  let current = null;
  let status = 'idle';
  let renewTimer = null;
  const listeners = new Set();

  function setState(next) {
    if (next === status) return;
    status = next;
    for (const cb of listeners) {
      try { cb(status); } catch { /* a listener must not break the auth flow */ }
    }
  }

  const fresh = () => Boolean(current) && (current.expiresAt === undefined || current.expiresAt - now() > renewLeadMs);
  const unexpired = () => Boolean(current) && (current.expiresAt === undefined || current.expiresAt > now());

  function cancelRenewal() {
    if (renewTimer) clearTimer(renewTimer);
    renewTimer = null;
  }

  function adopt(grant) {
    current = grant;
    cancelRenewal();
    if (grant.expiresAt !== undefined) {
      renewTimer = setTimer(() => {
        renewTimer = null;
        if (current !== grant) return;
        // A failed background renewal keeps the token; the next getToken asks again.
        provider.request('expiring').then(adopt, () => {});
      }, Math.max(0, grant.expiresAt - now() - renewLeadMs));
    }
    setState('ready');
    return grant.token;
  }

  function getToken(reason = 'initial') {
    if (fresh()) return Promise.resolve(current.token);
    if (!provider.isAvailable()) {
      setState('missing');
      return Promise.reject(new AuthError('This dashboard is not embedded in HYROS'));
    }
    // A renewal with a token still in hand keeps state() at 'ready'.
    if (!current) setState('waiting');
    return provider.request(current ? 'expiring' : reason).then(adopt, (err) => {
      if (unexpired()) return current.token;
      setState('missing');
      throw err instanceof AuthError ? err : new AuthError();
    });
  }

  function markInvalid(token) {
    if (!current || current.token !== token) return;
    current = null;
    cancelRenewal();
  }

  function onChange(cb) {
    listeners.add(cb);
    return () => listeners.delete(cb);
  }

  return {
    getToken,
    markInvalid,
    isEmbedded: () => provider.isAvailable(),
    state: () => status,
    onChange,
  };
}
