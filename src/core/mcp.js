/**
 * Minimal browser client for the HYROS MCP server.
 *
 * The server runs Spring AI's STATELESS transport on `/mcp`: every call is a
 * self-contained JSON-RPC POST, no session to hold open. Auth is
 * `Authorization: Bearer <token>`, the short-lived token from auth.js (handed
 * over by HYROS or from the HYROS sign-in). The token defines the account;
 * nothing else selects it.
 *
 * Transport errors, as McpError codes:
 *   401  token rejected        -> drop it, ask auth.js for a new one, retry once; then 'auth'
 *   403  account or role       -> 'forbidden'
 *   429  per-account limit     -> wait Retry-After (1 s, then 2 s without it), at most
 *                                 twice; then 'rate_limited'
 *   abort after timeoutMs      -> 'timeout'
 *   tool outside READ_TOOLS    -> 'not_allowed', before any request
 *   not configured / no token  -> 'NO_TOKEN', or 'SIGN_IN' when the user has to sign in
 *
 * Two identical calls in flight share one request: the MCP rejects the second
 * with "Already processing a request for id ...".
 *
 * No SDK on purpose: plain fetch and JSON-RPC, zero dependencies.
 */

export class McpError extends Error {
  constructor(message, detail, code) {
    super(message);
    this.name = 'McpError';
    this.detail = detail;
    if (code) this.code = code;
  }
}

/**
 * The only tools this dashboard may call. Extra defense on top of the real
 * guarantee, which is the token's read-only scope on the server.
 */
export const READ_TOOLS = Object.freeze([
  'hyros_get_user_info',
  'hyros_get_ad_accounts',
  'hyros_get_sources',
  'hyros_get_stages',
  'hyros_get_attribution_report',
  'hyros_get_leads',
  'hyros_get_sales',
  'hyros_get_calls',
  'hyros_get_subscriptions',
  'hyros_get_lead_journey',
  'hyros_get_lead_clicks',
  'hyros_get_marginal_cac_curve',
  'hyros_get_domains',
  'hyros_assert_script_presence_on_domain',
  'hyros_check_tracking_parameters_for_integrations',
]);
const READ_TOOL_SET = new Set(READ_TOOLS);

/** Waits before the first and second retry of a 429 that carries no Retry-After. */
export const RATE_LIMIT_WAITS_MS = Object.freeze([1000, 2000]);
const RATE_LIMIT_TEXT = /request limit|rate limit|too many requests/i;
const DEFAULT_TIMEOUT_MS = 25000;

let cfg = null;

/**
 * Wire the client to the MCP url and the token source (auth.js). Until this
 * runs, every call fails with code 'NO_TOKEN'. `rateLimitWaitsMs` exists for tests.
 */
export function configure({ url, getToken, markInvalid, rateLimitWaitsMs = RATE_LIMIT_WAITS_MS }) {
  cfg = { url, getToken, markInvalid, rateLimitWaitsMs };
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

let _id = 0;
const inFlight = new Map();

/**
 * The server text of a non-2xx body. The 429 body is `{"error":"<string>"}`,
 * the REST envelope is `{result:'ERROR', message:'...'}`, and a gateway may
 * answer plain text; keep whatever is there, capped.
 */
function errorText(text) {
  try {
    const body = JSON.parse(text);
    const msg = typeof body?.error === 'string' ? body.error
      : body?.error?.message || body?.message || body?.error_description || null;
    if (msg) return String(msg);
  } catch { /* not JSON */ }
  return String(text || '').trim().slice(0, 400);
}

/**
 * Streamable HTTP may answer with either application/json or an SSE stream
 * carrying the single response frame. Handle both.
 */
async function readRpcBody(res) {
  const ctype = res.headers.get('content-type') || '';
  const text = await res.text();

  if (ctype.includes('text/event-stream')) {
    // Take the last non-empty `data:` payload that parses as JSON.
    let last = null;
    for (const line of text.split(/\r?\n/)) {
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      try { last = JSON.parse(payload); } catch { /* keep scanning */ }
    }
    if (!last) throw new McpError('No JSON frame in SSE response', text.slice(0, 400));
    return last;
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new McpError(`Non-JSON response (HTTP ${res.status})`, text.slice(0, 400));
  }
}

/**
 * One HTTP round trip. Returns `{ result }`, `{ unauthorized }` for a 401 or
 * `{ rateLimited, message, retryAfterMs }` for a 429; anything else that failed throws.
 */
async function attempt(method, params, token, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(cfg.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // Advertise both so the server may pick either transport encoding.
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++_id, method, params }),
      signal: ctrl.signal,
    });

    if (res.status === 401) {
      return { unauthorized: true, message: errorText(await res.text()) };
    }
    if (res.status === 429) {
      const retryAfterMs = parseRetryAfter(res.headers.get('retry-after'));
      return { rateLimited: true, retryAfterMs, message: errorText(await res.text()) || 'You have reached the MCP request limit' };
    }
    if (res.status === 403) {
      const text = errorText(await res.text());
      throw new McpError(`MCP refused the request (HTTP 403)${text ? `: ${text}` : ''}`, text, 'forbidden');
    }
    if (!res.ok) {
      const text = errorText(await res.text());
      throw new McpError(`MCP answered HTTP ${res.status}${text ? `: ${text}` : ''}`, text);
    }

    const body = await readRpcBody(res);
    if (body.error) {
      const msg = typeof body.error === 'string' ? body.error : body.error.message || 'MCP error';
      if (RATE_LIMIT_TEXT.test(msg)) return { rateLimited: true, message: msg };
      throw new McpError(msg, body.error);
    }
    return { result: body.result };
  } catch (err) {
    if (err.name === 'AbortError') throw new McpError(`MCP call timed out after ${timeoutMs}ms`, null, 'timeout');
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
    throw new McpError(err?.message || 'No dashboard credential', null, 'NO_TOKEN');
  }
}

/** A JSON-RPC call with the 401 and 429 policies above. */
async function send(method, params, timeoutMs) {
  const started = Date.now();
  let token = await tokenFor();
  let reauthed = false;
  for (let limited = 0; ;) {
    const left = timeoutMs - (Date.now() - started);
    if (left <= 0) throw new McpError(`MCP call timed out after ${timeoutMs}ms`, null, 'timeout');
    const out = await attempt(method, params, token, left);

    if (out.unauthorized) {
      if (reauthed) {
        throw new McpError(`MCP rejected the dashboard credential (HTTP 401)${out.message ? `: ${out.message}` : ''}`, out.message, 'auth');
      }
      reauthed = true;
      cfg.markInvalid(token);
      token = await tokenFor('unauthorized');
      continue;
    }

    if (out.rateLimited) {
      const wait = out.retryAfterMs ?? cfg.rateLimitWaitsMs[limited];
      if (limited >= cfg.rateLimitWaitsMs.length || wait > timeoutMs - (Date.now() - started)) {
        throw new McpError(`MCP rate limit (HTTP 429): ${out.message}`, { retries: limited, retryAfterMs: out.retryAfterMs ?? null }, 'rate_limited');
      }
      limited += 1;
      if (wait > 0) await sleep(wait);
      continue;
    }

    return out.result;
  }
}

/** `send` with in-flight dedup on method and params (the JSON-RPC id is not part of the key). */
function rpc(method, params, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (!cfg) return Promise.reject(new McpError('The MCP client is not configured', null, 'NO_TOKEN'));
  const key = `${method}:${JSON.stringify(params)}`;
  const running = inFlight.get(key);
  if (running) return running;
  const call = send(method, params, timeoutMs).finally(() => {
    if (inFlight.get(key) === call) inFlight.delete(key);
  });
  inFlight.set(key, call);
  return call;
}

/** List the tools the token can see. Cheap end-to-end connectivity probe. */
export async function listTools() {
  const result = await rpc('tools/list', {});
  return (result?.tools || []).map((t) => t.name);
}

/**
 * Call one MCP tool and return its decoded payload.
 *
 * Tool results arrive as `{ content: [{type:'text', text:'<json>'}] }` and
 * sometimes also as `structuredContent`. Prefer the structured form, fall back
 * to parsing the text block, and finally hand back the raw text.
 */
export async function callTool(name, args = {}, opts = {}) {
  if (!READ_TOOL_SET.has(name)) {
    throw new McpError(`${name} is not a read tool this dashboard may call`, null, 'not_allowed');
  }
  const result = await rpc('tools/call', { name, arguments: args }, opts);

  if (result?.isError) {
    const msg = result?.content?.map((c) => c.text).join('\n') || 'tool reported an error';
    throw new McpError(`${name}: ${msg}`, null, RATE_LIMIT_TEXT.test(msg) ? 'rate_limited' : undefined);
  }
  if (result?.structuredContent !== undefined) return result.structuredContent;

  const text = (result?.content || [])
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('');

  if (!text) return null;
  try { return JSON.parse(text); } catch { return text; }
}

/** "An invalid or expired pagination cursor is rejected with 400": the tool error names the cursor. */
const CURSOR_ERROR = /page ?id|cursor|pagination/i;

/**
 * Walk a paginated HYROS tool (`{ result: [...], nextPageId }`) and say how
 * far it got:
 *   { rows, pages, truncated, error? }
 * `truncated` is true when `maxPages` was reached with a nextPageId still
 * present, when `deadline` (ms epoch) arrived first (`error: 'time budget'`),
 * or when the server rejected the cursor mid-way (`error: <server text>`).
 * In that last case the rows fetched so far are returned instead of thrown
 * away. Any other failure still throws (rate limit, auth, tool errors).
 */
export async function callToolPagedInfo(name, args = {}, { maxPages = 20, pageSize = 250, deadline = null, timeoutMs } = {}) {
  const rows = [];
  const opts = timeoutMs ? { timeoutMs } : {};
  let pageId;
  let pages = 0;
  for (let page = 0; page < maxPages; page += 1) {
    if (deadline && Date.now() >= deadline) return { rows, pages, truncated: true, error: 'time budget' };
    const req = { ...args.request, pageSize, ...(pageId ? { pageId } : {}) };
    let body;
    try {
      body = await callTool(name, { ...args, request: req }, opts);
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
export async function callToolPaged(name, args = {}, opts = {}) {
  return (await callToolPagedInfo(name, args, opts)).rows;
}
