// add-database v2. Copied by the add-database skill: do not edit, run the skill again to update it.
/**
 * Who is calling a route under `api/`. Those routes are public urls, so every request must carry a bearer
 * token (`Authorization: Bearer`), and a route names who may call it (`route(..., { callers })`):
 *
 *   user   the page, with the dashboard's HYROS token. The token is checked with HYROS itself
 *          (`GET /user-info`), never locally: HYROS also refuses a token whose session was killed or whose
 *          account was blocked. It must belong to the account that owns this dashboard, which HYROS names in
 *          DASHBOARD_ACCOUNT_ID; a token of any other account is refused.
 *   cron   a Vercel cron job (`crons` in vercel.json), which sends CRON_SECRET, set by HYROS on the project
 *          with the database. Compared here in constant time, before HYROS is ever asked, so the secret never
 *          leaves the server.
 *
 * An accepted token is remembered for CACHE_MS by its hash, so most requests skip the round trip. The token
 * itself is never stored, logged or put in an error.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { HttpError } from './errors.js';

export const CACHE_MS = 60000;
const MAX_CACHED = 500;
const TIMEOUT_MS = 8000;

const accepted = new Map();

/** Who may call a route. */
export const CALLERS = Object.freeze(['user', 'cron']);

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

/** Whether `token` is CRON_SECRET, compared in constant time. False when the project has none. */
export function isCronSecret(token, env = process.env) {
  const secret = env.CRON_SECRET;
  if (!secret || !token) return false;
  const given = Buffer.from(String(token));
  const expected = Buffer.from(String(secret));
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/**
 * Who is calling `req`, among the `callers` a route takes: `{ caller: 'user', user: { accountId, email } }`
 * or `{ caller: 'cron', user: null }`, or an HttpError. The cron secret is recognized before anything else,
 * so it is never sent to HYROS, and it opens only a route that takes the cron.
 */
export async function identifyCaller(req, callers = ['user'], options = {}) {
  const token = bearer(req);
  if (!token) throw new HttpError(401, 'auth', 'Missing dashboard credential');
  if (isCronSecret(token, options.env)) {
    if (callers.includes('cron')) return { caller: 'cron', user: null };
    throw new HttpError(403, 'forbidden', 'This route does not take scheduled jobs');
  }
  if (!callers.includes('user')) throw new HttpError(401, 'auth', 'This route takes scheduled jobs only');
  return { caller: 'user', user: await verifyWithHyros(token, options) };
}

/** Forgets every accepted token. For tests. */
export function clearCache() {
  accepted.clear();
}
