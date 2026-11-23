// add-database v1. Copied by the add-database skill: do not edit, run the skill again to update it.
/**
 * The page's way to its own database: the routes the dashboard defines under `api/db/`, on the same origin as
 * the page. Views import it (`import { db } from '../../core/db.js'`) and never call `fetch`, the same rule as
 * `ctx.data` for HYROS. Every call carries the token the page already sends to HYROS (`credential()` in
 * `api.js`); the route checks it with HYROS and only accepts the account that owns this dashboard.
 *
 *   db.get('notes', { stage: 'won' })        GET    /api/db/notes?stage=won
 *   db.post('notes', { text })               POST   /api/db/notes
 *   db.patch('notes', { id, text })          PATCH  /api/db/notes
 *   db.del('notes', { id })                  DELETE /api/db/notes?id=...
 *
 * A failure rejects with a DbError whose `code` is the route's: 'auth' (after one retry with a new token),
 * 'forbidden', 'bad_request', 'not_found', 'storage_full', 'no_database', 'unavailable', 'timeout',
 * 'network' or 'internal'. `message` is fit to show.
 */
import { credential } from './api.js';

const TIMEOUT_MS = 20000;
const NAME = /^[a-z0-9][a-z0-9/_-]{0,80}$/;

export class DbError extends Error {
  constructor(message, code, status = null) {
    super(message);
    this.name = 'DbError';
    this.code = code;
    this.status = status;
  }
}

function hrefOf(name, params) {
  if (!NAME.test(name)) throw new DbError(`Invalid route name: ${name}`, 'bad_request');
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params || {})) {
    if (value !== undefined && value !== null) query.append(key, String(value));
  }
  const qs = query.toString();
  return `/api/db/${name}${qs ? `?${qs}` : ''}`;
}

async function attempt(method, href, token, body, fetchFn) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  const headers = { accept: 'application/json', authorization: `Bearer ${token}` };
  if (body !== undefined) headers['content-type'] = 'application/json';
  try {
    const res = await fetchFn(href, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: ctrl.signal });
    if (res.status === 204) return { ok: true, value: null };
    const json = await res.json().catch(() => null);
    if (res.ok) return { ok: true, value: json };
    const code = json?.error?.code || (res.status >= 500 ? 'internal' : 'bad_request');
    return { ok: false, status: res.status, code, message: json?.error?.message || `The dashboard database answered HTTP ${res.status}` };
  } catch (err) {
    if (err.name === 'AbortError') throw new DbError('The dashboard database took too long to answer', 'timeout');
    throw new DbError('The dashboard database could not be reached', 'network');
  } finally {
    clearTimeout(timer);
  }
}

/** One request; a refused token is reported once and the call is retried with a new one. `fetchFn` exists for tests. */
export async function request(method, name, { params, body, fetchFn = globalThis.fetch } = {}) {
  const href = hrefOf(name, params);
  const source = credential();
  if (!source) throw new DbError('The dashboard is not signed in yet', 'auth');
  let token = await source.getToken();
  let out = await attempt(method, href, token, body, fetchFn);
  if (!out.ok && out.status === 401) {
    source.markInvalid(token);
    token = await source.getToken('unauthorized');
    out = await attempt(method, href, token, body, fetchFn);
  }
  if (out.ok) return out.value;
  throw new DbError(out.message, out.code, out.status);
}

export const db = Object.freeze({
  get: (name, params) => request('GET', name, { params }),
  post: (name, body) => request('POST', name, { body }),
  patch: (name, body) => request('PATCH', name, { body }),
  del: (name, params) => request('DELETE', name, { params }),
});
