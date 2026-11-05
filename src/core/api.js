/**
 * Minimal browser client for the HYROS customer API (`/api/v1.0`).
 *
 * Every call is a GET with its arguments in the query string, except one:
 * runReport POSTs /reports/generate (starts a report, changes no data) and
 * reads it with GET /reports/poll/{id}, a read path like the others. Auth is
 * `Authorization: Bearer <token>`, the short-lived token from auth.js (handed
 * over by HYROS or from the HYROS sign-in); never an `API-Key`. The token
 * defines the account; nothing else selects it.
 *
 * Transport errors, as ApiError codes:
 *   401  token rejected        -> drop it, ask auth.js for a new one, retry once; then 'auth',
 *                                 with `refusal` when HYROS says the account is not active
 *   403  account or role       -> 'forbidden'
 *   429  per-account limit     -> wait Retry-After (1 s, then 2 s without it), at most
 *                                 twice; then 'rate_limited'
 *   abort after timeoutMs      -> 'timeout'
 *   no answer from any host    -> 'network', once every base in routes.js failed at network
 *                                 level (an ad blocker, a firewall); without routes the fetch
 *                                 error as it is
 *   path outside READ_PATHS    -> 'not_allowed', before any request
 *   not configured / no token  -> 'NO_TOKEN', or 'SIGN_IN' when the user has to sign in
 *   400 and other failures     -> no code, the server text in the message
 *
 * With `routes` (src/core/routes.js) every request starts on the direct API
 * and moves to a fallback host only when the fetch never got an HTTP answer.
 *
 * Two identical calls in flight share one request.
 *
 * No SDK on purpose: plain fetch, zero dependencies.
 */
import { isNetworkError } from './routes.js';

/** `refusal`, on an 'auth' error, is the reason HYROS refused the account: a new credential cannot fix it. */
export class ApiError extends Error {
  constructor(message, detail, code, refusal = null) {
    super(message);
    this.name = 'ApiError';
    this.detail = detail;
    if (code) this.code = code;
    if (refusal) this.refusal = refusal;
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
  '/reports/poll/{id}',
]);
const READ_PATH_SET = new Set(READ_PATHS);

/**
 * A read path with `{id}` takes the id from `params.id`, never from the path a
 * caller writes: it must match PATH_ID (no '/', '?', '#', '%' or '.'), so it can
 * only fill that one segment, and it is not sent in the query.
 */
const PATH_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** The only POST: runReport starts a report with it. Not a read path, so get() refuses it. */
const REPORT_GENERATE = '/reports/generate';

/** Waits before the first and second retry of a 429 that carries no Retry-After. */
export const RATE_LIMIT_WAITS_MS = Object.freeze([1000, 2000]);
const DEFAULT_TIMEOUT_MS = 25000;

let cfg = null;

/**
 * Wire the client to the API base url (ending in `/api/v1.0`) and the token
 * source (auth.js). Until this runs, every call fails with code 'NO_TOKEN'.
 * With `routes` (routes.js) the bases come from its 'api' channel and `url`
 * is only reported; without it `url` is the only base.
 * `rateLimitWaitsMs` exists for tests.
 */
export function configure({ url, routes = null, getToken, markInvalid, rateLimitWaitsMs = RATE_LIMIT_WAITS_MS }) {
  cfg = { url: url.replace(/\/+$/, ''), routes, getToken, markInvalid, rateLimitWaitsMs };
  inFlight.clear();
}

/** The base the next call goes to and whether it is a fallback host; null before configure. */
export function connection() {
  if (!cfg) return null;
  return cfg.routes ? cfg.routes.active('api') : { base: cfg.url, viaFallback: false };
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
 * The reason of a 401 in the API's own `{result:'ERROR', message:[...]}`, which
 * HYROS sends when the account is no longer active. A credential that expired or
 * was revoked gets a plain 401 instead, and a new one fixes it.
 */
function refusalOf(text) {
  try {
    return JSON.parse(text)?.result === 'ERROR' ? errorText(text) || null : null;
  } catch { return null; }
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
async function attempt(href, token, timeoutMs, payload) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const headers = { accept: 'application/json', authorization: `Bearer ${token}` };
  const init = payload === undefined
    ? { method: 'GET', headers }
    : { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(payload) };
  try {
    const res = await fetch(href, { ...init, signal: ctrl.signal });

    if (res.status === 401) {
      const text = await res.text();
      return { unauthorized: true, message: errorText(text), refusal: refusalOf(text) };
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

/**
 * One round trip of `rel` (path and query): on the configured url, or through
 * the routes, which retry it on the next base after a network failure.
 */
function attemptOn(rel, token, started, timeoutMs, payload) {
  const at = async (base) => {
    const left = timeoutMs - (Date.now() - started);
    if (left <= 0) throw new ApiError(`HYROS call timed out after ${timeoutMs}ms`, null, 'timeout');
    return attempt(`${base}${rel}`, token, left, payload);
  };
  if (!cfg.routes) return at(cfg.url);
  return cfg.routes.withFallback('api', at).catch((err) => {
    if (isNetworkError(err)) throw new ApiError('Could not reach HYROS', err.message, 'network');
    throw err;
  });
}

/** A GET of `rel` (path and query), or a POST of `payload`, with the 401 and 429 policies above. */
async function send(rel, timeoutMs, payload) {
  const started = Date.now();
  let token = await tokenFor();
  let reauthed = false;
  for (let limited = 0; ;) {
    const out = await attemptOn(rel, token, started, timeoutMs, payload);

    if (out.unauthorized) {
      if (reauthed) {
        throw new ApiError(`HYROS rejected the dashboard credential (HTTP 401)${out.message ? `: ${out.message}` : ''}`, out.message, 'auth', out.refusal);
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
 * dedup on the path and query, whichever host serves it.
 */
export function get(path, params = {}, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (!cfg) return Promise.reject(new ApiError('The HYROS API client is not configured', null, 'NO_TOKEN'));
  if (!READ_PATH_SET.has(path)) {
    return Promise.reject(new ApiError(`${path} is not a read path this dashboard may call`, null, 'not_allowed'));
  }
  let target = path;
  let rest = params;
  if (path.includes('{id}')) {
    const { id, ...others } = params || {};
    if (typeof id !== 'string' || !PATH_ID.test(id)) {
      return Promise.reject(new ApiError(`${path} needs a valid id`, null, 'bad_request'));
    }
    target = path.replace('{id}', id);
    rest = others;
  }
  let query;
  try { query = toQuery(rest); } catch (err) { return Promise.reject(err); }
  const rel = `${target}${query ? `?${query}` : ''}`;
  const running = inFlight.get(rel);
  if (running) return running;
  const call = send(rel, timeoutMs).then((body) => {
    const msg = messageOnly(body);
    if (msg) throw new ApiError(`${path}: ${msg}`, body);
    return body;
  }).finally(() => {
    if (inFlight.get(rel) === call) inFlight.delete(rel);
  });
  inFlight.set(rel, call);
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

/** A body that answered 200 with only a message is a failure (see messageOnly). */
function bodyOf(path) {
  return (body) => {
    const msg = messageOnly(body);
    if (msg) throw new ApiError(`${path}: ${msg}`, body);
    return body;
  };
}

/**
 * The checks a report configuration passes before it is sent: a plain object
 * with a groupBy name and YYYY-MM-DD dates. HYROS validates the rest.
 */
function checkConfiguration(configuration) {
  const c = configuration;
  const day = /^\d{4}-\d{2}-\d{2}$/;
  if (!c || typeof c !== 'object' || Array.isArray(c)) return 'configuration must be an object';
  if (typeof c.groupBy !== 'string' || !/^[A-Z_]{1,40}$/.test(c.groupBy)) return 'configuration.groupBy is missing or invalid';
  if (!day.test(String(c.startDate)) || !day.test(String(c.endDate))) return 'configuration.startDate and endDate must be YYYY-MM-DD';
  return null;
}

/** How often runReport asks for the report, and how long it waits for it in all (under the view's 2 minutes). */
export const REPORT_POLL_MS = 3000;
export const REPORT_MAX_MS = 115000;

/** The `message` of a poll answer, whether HYROS puts it on the result or on the envelope. */
function reportMessage(body) {
  const msg = body?.result?.message ?? body?.message;
  return Array.isArray(msg) ? msg.filter(Boolean).join(' ') : (msg ? String(msg) : '');
}

/**
 * Start a report (POST /reports/generate with `{ configuration }`) and poll
 * GET /reports/poll/<id> every `pollMs` until it is SUCCESSFUL; answers the
 * `report` (`{ rows, totals, totalRows }`). Fails with code:
 *   'report_failed' / 'report_expired'  the status, with the server's message
 *   'report_timeout'                    still IN_PROGRESS after `maxMs`
 *   'cancelled'                         `signal` aborted between polls
 * `onProgress({ status, polls, elapsedMs })` is called after each step, so a
 * view can show the report is still being built.
 * Transport errors (403, 429, ...) come through as they are.
 */
export async function runReport(configuration, { pollMs = REPORT_POLL_MS, maxMs = REPORT_MAX_MS, signal = null, timeoutMs, onProgress = null } = {}) {
  const opts = timeoutMs ? { timeoutMs } : {};
  const started = Date.now();
  let polls = 0;
  const progress = (status) => { try { onProgress?.({ status, polls, elapsedMs: Date.now() - started }); } catch { /* a view's callback never stops the report */ } };
  const cancelled = () => new ApiError('The report was cancelled', null, 'cancelled');
  if (!cfg) throw new ApiError('The HYROS API client is not configured', null, 'NO_TOKEN');
  const bad = checkConfiguration(configuration);
  if (bad) throw new ApiError(bad, null, 'bad_request');
  const generated = await send(REPORT_GENERATE, opts.timeoutMs || DEFAULT_TIMEOUT_MS, { configuration }).then(bodyOf(REPORT_GENERATE));
  const id = generated?.result;
  if (typeof id !== 'string' || !PATH_ID.test(id)) throw new ApiError('HYROS did not answer a valid report id', null);
  progress('GENERATED');
  for (;;) {
    if (signal?.aborted) throw cancelled();
    if (Date.now() - started + pollMs > maxMs) {
      throw new ApiError(`The report was not ready after ${Math.round(maxMs / 1000)} s`, null, 'report_timeout');
    }
    if (pollMs > 0) await sleep(pollMs);
    if (signal?.aborted) throw cancelled();
    const body = await get('/reports/poll/{id}', { id }, opts);
    const status = body?.result?.status;
    polls += 1;
    progress(status ?? 'UNKNOWN');
    if (status === 'SUCCESSFUL') return body.result.report || { rows: [], totals: null, totalRows: 0 };
    if (status === 'FAILED' || status === 'EXPIRED') {
      const msg = reportMessage(body);
      throw new ApiError(`Report ${status}${msg ? `: ${msg}` : ''}`, msg || null, `report_${status.toLowerCase()}`);
    }
    if (status !== 'IN_PROGRESS') throw new ApiError(`Unexpected report status: ${status ?? 'none'}`, body);
  }
}
