// add-database v1. Copied by the add-database skill: do not edit, run the skill again to update it.
/**
 * Who is calling a route under `api/`. Those routes are public urls, so every request must carry the
 * dashboard's HYROS token (`Authorization: Bearer`), the same one the page sends to HYROS. The token is
 * checked with HYROS itself (`GET /user-info`), never locally: HYROS also refuses a token whose session was
 * killed or whose account was blocked. It must belong to the account that owns this dashboard, which HYROS
 * names in DASHBOARD_ACCOUNT_ID; a token of any other account is refused.
 *
 * An accepted token is remembered for CACHE_MS by its hash, so most requests skip the round trip. The token
 * itself is never stored, logged or put in an error.
 */
import { createHash } from 'node:crypto';
import { HttpError } from './errors.js';

export const CACHE_MS = 60000;
const MAX_CACHED = 500;
const TIMEOUT_MS = 8000;

const accepted = new Map();

/** The bearer token of the request, or null. */
export function bearer(req) {
  const header = req.headers?.authorization || req.headers?.Authorization || '';
  const match = /^Bearer\s+(\S+)$/i.exec(String(header));
  return match ? match[1] : null;
}

function keyOf(token) {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * The account and email of a token HYROS accepts, or an HttpError: 401 when HYROS refuses it, 403 when it
 * belongs to another account, 503 when HYROS cannot be asked. `fetchFn` and `now` exist for tests.
 */
export async function verifyWithHyros(token, { env = process.env, fetchFn = fetch, now = Date.now() } = {}) {
  const key = keyOf(token);
  const cached = accepted.get(key);
  if (cached && cached.until > now) return cached.identity;

  const apiUrl = String(env.HYROS_API_URL || '').replace(/\/+$/, '');
  const accountId = env.DASHBOARD_ACCOUNT_ID;
  if (!apiUrl || !accountId) throw new HttpError(503, 'no_database', 'The dashboard has no database yet');

  let res;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    res = await fetchFn(`${apiUrl}/user-info`, { headers: { accept: 'application/json', authorization: `Bearer ${token}` }, signal: ctrl.signal });
  } catch {
    throw new HttpError(503, 'unavailable', 'HYROS could not be reached to check the credential');
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 401) throw new HttpError(401, 'auth', 'HYROS rejected the dashboard credential');
  if (res.status === 403) throw new HttpError(403, 'forbidden', 'This HYROS login cannot use this dashboard');
  if (!res.ok) throw new HttpError(503, 'unavailable', `HYROS answered HTTP ${res.status} checking the credential`);

  const body = await res.json().catch(() => null);
  const profile = body?.result?.userProfile;
  if (!profile?.accountId) throw new HttpError(503, 'unavailable', 'HYROS did not say which account the credential belongs to');
  if (profile.accountId !== accountId) throw new HttpError(403, 'forbidden', 'This dashboard belongs to another account');

  const identity = { accountId: profile.accountId, email: profile.email || null };
  if (accepted.size >= MAX_CACHED) accepted.delete(accepted.keys().next().value);
  accepted.set(key, { identity, until: now + CACHE_MS });
  return identity;
}

/** The identity of the caller of `req`, or an HttpError. */
export async function requireDashboardUser(req, options) {
  const token = bearer(req);
  if (!token) throw new HttpError(401, 'auth', 'Missing dashboard credential');
  return verifyWithHyros(token, options);
}

/** Forgets every accepted token. For tests. */
export function clearCache() {
  accepted.clear();
}
