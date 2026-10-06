/**
 * The dashboard credential. HYROS embeds this page in an iframe and hands it a
 * short-lived token over postMessage, so the token never travels in a url.
 *
 * Contract v1 (docs/PROTOCOL.md):
 *   dashboard -> host   { type: 'ready', version: 1 }                     first request
 *   dashboard -> host   { type: 'token-request', version: 1, reason }     every later request
 *   host -> dashboard   { type: 'token', version: 1, token, expiresAt? }
 *
 * The token lives only in memory, inside createAuth. It is never written to
 * storage, a cookie, the url or a log line.
 */
import { CONFIG } from './config.js';

export const PROTOCOL_VERSION = 1;
/** How long to wait for the host to answer one request. */
export const TOKEN_TIMEOUT_MS = 10000;
/** A token with an `expiresAt` is renewed this long before it expires. */
export const RENEW_LEAD_MS = 120000;

const TOKEN_REQUEST_REASONS = new Set(['expiring', 'unauthorized', 'retry']);

export class AuthError extends Error {
  code = 'NO_TOKEN';

  constructor(message = 'HYROS did not hand over the dashboard credential') {
    super(message);
    this.name = 'AuthError';
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

/**
 * Holds the current token and decides when to ask for a new one.
 *   getToken(reason)   the current token, or a new one from the provider
 *   markInvalid(token) drops the current token if it is that one (after a 401)
 *   isEmbedded()       whether a host can answer at all
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
