/**
 * Minimal browser client for the HYROS customer API (`/api/v1.0`).
 *
 * Every call is a GET with its arguments in the query string. Auth is
 * `Authorization: Bearer <token>`, the short-lived token from auth.js (handed
 * over by HYROS or from the HYROS sign-in); never an `API-Key`. The token
 * defines the account; nothing else selects it.
 *
 * Transport errors, as ApiError codes:
 *   401  token rejected        -> drop it, ask auth.js for a new one, retry once; then 'auth'
 *   403  account or role       -> 'forbidden'
 *   429  per-account limit     -> wait Retry-After (1 s, then 2 s without it), at most
 *                                 twice; then 'rate_limited'
 *   abort after timeoutMs      -> 'timeout'
 *   path outside READ_PATHS    -> 'not_allowed', before any request
 *   not configured / no token  -> 'NO_TOKEN', or 'SIGN_IN' when the user has to sign in
 *   400 and other failures     -> no code, the server text in the message
 *
 * Two identical calls in flight share one request.
 *
 * No SDK on purpose: plain fetch, zero dependencies.
 */

export class ApiError extends Error {
  constructor(message, detail, code) {
    super(message);
    this.name = 'ApiError';
    this.detail = detail;
    if (code) this.code = code;
  }
}

/**
 * The only paths this dashboard may call. Extra defense on top of the real
 * guarantee, which is the token's read-only credential on the server: HYROS
 * answers 403 to anything but a read from it.
 */
export const READ_PATHS = Object.freeze([
  '/user-info',
  '/ad-accounts',
  '/sources',
  '/stages',
  '/attribution',
  '/attribution/marginal-cac-curve',
  '/leads',
  '/leads/aggregation',
  '/leads/journey',
  '/leads/clicks',
  '/sales',
  '/sales/aggregation',
  '/calls',
  '/calls/aggregation',
  '/subscriptions',
]);
const READ_PATH_SET = new Set(READ_PATHS);

/** Waits before the first and second retry of a 429 that carries no Retry-After. */
export const RATE_LIMIT_WAITS_MS = Object.freeze([1000, 2000]);
const DEFAULT_TIMEOUT_MS = 25000;

let cfg = null;

/**
 * Wire the client to the API base url (ending in `/api/v1.0`) and the token
 * source (auth.js). Until this runs, every call fails with code 'NO_TOKEN'.
 * `rateLimitWaitsMs` exists for tests.
 */
export function configure({ url, getToken, markInvalid, rateLimitWaitsMs = RATE_LIMIT_WAITS_MS }) {
  cfg = { url: url.replace(/\/+$/, ''), getToken, markInvalid, rateLimitWaitsMs };
  inFlight.clear();
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Retry-After (seconds or an HTTP date) in ms, or null. */
export function parseRetryAfter(value, now = Date.now()) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  if (/^\d+$/.test(text)) return Number(text) * 1000;
  if (!/[a-z]/i.test(text)) return null;
  const at = Date.parse(text);
  return Number.isFinite(at) ? Math.max(0, at - now) : null;
}

/**
 * The query string of a call. The API reads an array as one comma-separated
 * parameter (a repeated one keeps only its first value, or answers 400), so a
 * value holding a comma cannot be sent. null and undefined are left out.
 */
export function toQuery(params = {}) {
  const query = new URLSearchParams();
  for (const [name, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      const items = value.filter((v) => v !== undefined && v !== null).map(String);
      if (!items.length) continue;
      const bad = items.find((v) => v.includes(','));
      if (bad !== undefined) throw new ApiError(`${name} cannot hold a comma: ${bad}`, null, 'bad_request');
      query.set(name, items.join(','));
    } else {
      query.set(name, String(value));
    }
  }
  return query.toString();
}

const inFlight = new Map();

/**
 * The server text of a non-2xx body. API errors are `{result:'ERROR', message:[...]}`,
 * a 401 is plain `Unauthorized`, and a gateway may answer anything; keep whatever is there, capped.
 */
function errorText(text) {
  try {
    const body = JSON.parse(text);
    const msg = Array.isArray(body?.message) ? body.message.filter(Boolean).join(' ')
      : typeof body?.error === 'string' ? body.error
        : body?.message || body?.error?.message || null;
    if (msg) return String(msg);
  } catch { /* not JSON */ }
  return String(text || '').trim().slice(0, 400);
}

/**
 * Some reads answer 200 with only `message` and no `result` when there is
 * nothing to compute (an attribution report or a curve without data). That is
 * a failure the user should read, not an empty table.
 */
function messageOnly(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || body.result !== undefined) return null;
  const msg = Array.isArray(body.message) ? body.message.filter(Boolean).join(' ') : body.message;
  return msg ? String(msg) : null;
}

/**
 * One HTTP round trip. Returns `{ body }`, `{ unauthorized }` for a 401 or
 * `{ rateLimited, message, retryAfterMs }` for a 429; anything else that failed throws.
 */
async function attempt(href, token, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(href, {
      method: 'GET',
      headers: { accept: 'application/json', authorization: `Bearer ${token}` },
      signal: ctrl.signal,
    });

    if (res.status === 401) {
      return { unauthorized: true, message: errorText(await res.text()) };
    }
    if (res.status === 429) {
      const retryAfterMs = parseRetryAfter(res.headers.get('retry-after'));
      return { rateLimited: true, retryAfterMs, message: errorText(await res.text()) || 'You have reached the API request limit' };
    }
    if (res.status === 403) {
      const text = errorText(await res.text());
      throw new ApiError(`HYROS refused the request (HTTP 403)${text ? `: ${text}` : ''}`, text, 'forbidden');
    }
    const text = await res.text();
    if (!res.ok) {
      const msg = errorText(text);
      throw new ApiError(`HYROS answered HTTP ${res.status}${msg ? `: ${msg}` : ''}`, msg);
    }
    try {
      return { body: text ? JSON.parse(text) : null };
    } catch {
      throw new ApiError(`Non-JSON response (HTTP ${res.status})`, text.slice(0, 400));
    }
  } catch (err) {
    if (err.name === 'AbortError') throw new ApiError(`HYROS call timed out after ${timeoutMs}ms`, null, 'timeout');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** A token from auth.js; a NO_TOKEN or SIGN_IN rejection keeps its code, anything else becomes NO_TOKEN. */
async function tokenFor(reason) {
  try {
    return await cfg.getToken(reason);
  } catch (err) {
    if (err?.code === 'NO_TOKEN' || err?.code === 'SIGN_IN') throw err;
    throw new ApiError(err?.message || 'No dashboard credential', null, 'NO_TOKEN');
  }
}

/** A GET with the 401 and 429 policies above. */
async function send(href, timeoutMs) {
  const started = Date.now();
  let token = await tokenFor();
  let reauthed = false;
  for (let limited = 0; ;) {
    const left = timeoutMs - (Date.now() - started);
    if (left <= 0) throw new ApiError(`HYROS call timed out after ${timeoutMs}ms`, null, 'timeout');
    const out = await attempt(href, token, left);

    if (out.unauthorized) {
      if (reauthed) {
        throw new ApiError(`HYROS rejected the dashboard credential (HTTP 401)${out.message ? `: ${out.message}` : ''}`, out.message, 'auth');
      }
      reauthed = true;
      cfg.markInvalid(token);
      token = await tokenFor('unauthorized');
      continue;
    }

    if (out.rateLimited) {
      const wait = out.retryAfterMs ?? cfg.rateLimitWaitsMs[limited];
      if (limited >= cfg.rateLimitWaitsMs.length || wait > timeoutMs - (Date.now() - started)) {
        throw new ApiError(`HYROS rate limit (HTTP 429): ${out.message}`, { retries: limited, retryAfterMs: out.retryAfterMs ?? null }, 'rate_limited');
      }
      limited += 1;
      if (wait > 0) await sleep(wait);
      continue;
    }

    return out.body;
  }
}

/**
 * GET one read path and return the parsed body as the API sends it: usually
 * the envelope `{ result, nextPageId?, message?, request_id? }`. In-flight
 * dedup on the url.
 */
export function get(path, params = {}, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (!cfg) return Promise.reject(new ApiError('The HYROS API client is not configured', null, 'NO_TOKEN'));
  if (!READ_PATH_SET.has(path)) {
    return Promise.reject(new ApiError(`${path} is not a read path this dashboard may call`, null, 'not_allowed'));
  }
  let query;
  try { query = toQuery(params); } catch (err) { return Promise.reject(err); }
  const href = `${cfg.url}${path}${query ? `?${query}` : ''}`;
  const running = inFlight.get(href);
  if (running) return running;
  const call = send(href, timeoutMs).then((body) => {
    const msg = messageOnly(body);
    if (msg) throw new ApiError(`${path}: ${msg}`, body);
    return body;
  }).finally(() => {
    if (inFlight.get(href) === call) inFlight.delete(href);
  });
  inFlight.set(href, call);
  return call;
}

/** "An invalid or expired pagination cursor is rejected with 400": the error names the cursor. */
const CURSOR_ERROR = /page ?id|cursor|pagination/i;

/**
 * Walk a paginated read (`{ result: [...], nextPageId }`, `pageSize` and
 * `pageId` in the query) and say how far it got:
 *   { rows, pages, truncated, error? }
 * `truncated` is true when `maxPages` was reached with a nextPageId still
 * present, when `deadline` (ms epoch) arrived first (`error: 'time budget'`),
 * or when the server rejected the cursor mid-way (`error: <server text>`).
 * In that last case the rows fetched so far are returned instead of thrown
 * away. Any other failure still throws (rate limit, auth, bad request).
 */
export async function getPagedInfo(path, params = {}, { maxPages = 20, pageSize = 250, deadline = null, timeoutMs } = {}) {
  const rows = [];
  const opts = timeoutMs ? { timeoutMs } : {};
  let pageId;
  let pages = 0;
  for (let page = 0; page < maxPages; page += 1) {
    if (deadline && Date.now() >= deadline) return { rows, pages, truncated: true, error: 'time budget' };
    let body;
    try {
      body = await get(path, { ...params, pageSize, ...(pageId ? { pageId } : {}) }, opts);
    } catch (err) {
      if (pages > 0 && !err.code && CURSOR_ERROR.test(err.message || '')) {
        return { rows, pages, truncated: true, error: err.message };
      }
      throw err;
    }
    pages += 1;
    rows.push(...(Array.isArray(body) ? body : body?.result || []));
    pageId = Array.isArray(body) ? null : body?.nextPageId;
    if (!pageId) return { rows, pages, truncated: false };
  }
  return { rows, pages, truncated: true };
}

/** Rows only: the same walk for callers that do not need the truncation signal. */
export async function getPaged(path, params = {}, opts = {}) {
  return (await getPagedInfo(path, params, opts)).rows;
}
