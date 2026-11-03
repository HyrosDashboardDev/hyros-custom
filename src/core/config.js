/**
 * Static configuration. Nothing here is a secret: the credential arrives at
 * runtime, from the HYROS page that embeds this dashboard or from the HYROS
 * sign-in (see auth.js).
 */
export const CONFIG = Object.freeze({
  mcp: Object.freeze({
    prod: 'https://mcp.hyros.com/mcp',
    qa: 'https://mcp-qa.hyros.com/mcp',
  }),
  /** The customer API of each environment, the one the data comes from. */
  api: Object.freeze({
    prod: 'https://api.hyros.com/v1/api/v1.0',
    qa: 'https://api-staging.hyros.com/v1/api/v1.0',
  }),
  /**
   * Pages allowed to hand this dashboard a token. The dashboard only posts to
   * these origins and only accepts tokens coming from them.
   * http://localhost:4323 is the local harness (dev/host.html).
   */
  hostOrigins: Object.freeze([
    'https://app.hyros.com',
    'https://ui-test.hyros.com',
    'https://localhost:8080',
    'http://localhost:4323',
  ]),
});

/**
 * The MCP url of the HYROS environment this page belongs to: its origin is the
 * sign-in server and it picks the API (resolveApiUrl). `<meta name="hyros-mcp-url">` wins: build.mjs
 * writes it from HYROS_MCP_URL, which HYROS sets on the Vercel project when it
 * provisions the dashboard. Without the meta, `?mcp=qa` on the dashboard's own
 * url selects QA and anything else is prod; that only matters for the local
 * harness and for manual deploys built without the variable.
 */
export function resolveMcpUrl({
  search = globalThis.location?.search || '',
  metaUrl = globalThis.document?.querySelector('meta[name="hyros-mcp-url"]')?.content,
} = {}) {
  if (metaUrl) return metaUrl;
  const env = new URLSearchParams(search).get('mcp');
  return env === 'qa' ? CONFIG.mcp.qa : CONFIG.mcp.prod;
}

/**
 * The customer API url the data comes from. `<meta name="hyros-api-url">` wins:
 * build.mjs writes it from HYROS_API_URL when the Vercel project has it.
 * Without it, the API of the environment of `mcpUrl`; null for an MCP url that
 * belongs to no known environment (a local server), which then needs the meta.
 */
export function resolveApiUrl(mcpUrl, {
  metaUrl = globalThis.document?.querySelector('meta[name="hyros-api-url"]')?.content,
} = {}) {
  if (metaUrl) return metaUrl;
  for (const env of Object.keys(CONFIG.mcp)) {
    if (mcpUrl === CONFIG.mcp[env]) return CONFIG.api[env];
  }
  return null;
}

/** The MCP server is the OAuth server the dashboard signs in with. */
export function resolveAuthServer(mcpUrl) {
  return new URL(mcpUrl).origin;
}

/** This page, keeping only `?mcp=` so a QA sign-in comes back to QA. HYROS matches it exactly. */
export function resolveRedirectUri({
  origin = globalThis.location?.origin,
  pathname = globalThis.location?.pathname || '/',
  search = globalThis.location?.search || '',
} = {}) {
  const mcp = new URLSearchParams(search).get('mcp');
  const query = mcp ? `?${new URLSearchParams({ mcp })}` : '';
  return `${origin}${pathname}${query}`;
}

/** The direct hosts of an environment: its MCP and its API. */
function hostsOf(env) {
  return new Set([CONFIG.mcp[env], CONFIG.api[env]].map((url) => new URL(url).hostname));
}

function envOfUrl(url) {
  let host;
  try { host = new URL(url).hostname; } catch { return null; }
  return Object.keys(CONFIG.mcp).find((env) => hostsOf(env).has(host)) || null;
}

/**
 * The HYROS environment ('prod' or 'qa') the MCP and API urls belong to, read
 * from their direct hosts; null when either is on any other host (a local
 * server, for instance) or they name different environments. A null `apiUrl`
 * leaves the MCP url to decide. With an environment the page starts on its
 * direct hosts (directUrls) and falls back to the hosts of resolveFallback;
 * with null it uses the configured urls only.
 */
export function resolveEnv(mcpUrl, apiUrl) {
  const env = envOfUrl(mcpUrl);
  if (!env) return null;
  if (apiUrl == null) return env;
  return envOfUrl(apiUrl) === env ? env : null;
}

/**
 * The fallback hosts, `{ api, auth }`, tried after the direct hosts of the
 * environment (src/core/routes.js): the ones HYROS set on the Vercel project,
 * which build.mjs bakes from HYROS_FALLBACK_API_URL and HYROS_FALLBACK_AUTH_URL
 * as `<meta name="hyros-fallback-api-url">` and
 * `<meta name="hyros-fallback-auth-url">`. Each meta is the only fallback of
 * its channel; a channel without its meta has no fallback.
 */
export function resolveFallback({
  apiMeta = globalThis.document?.querySelector('meta[name="hyros-fallback-api-url"]')?.content,
  authMeta = globalThis.document?.querySelector('meta[name="hyros-fallback-auth-url"]')?.content,
} = {}) {
  const pick = (meta) => (typeof meta === 'string' && meta ? [meta] : []);
  return { api: pick(apiMeta), auth: pick(authMeta) };
}

/** The direct customer API base and OAuth server of an environment, or null for an unknown one. */
export function directUrls(env) {
  if (!Object.hasOwn(CONFIG.mcp, env)) return null;
  return { api: CONFIG.api[env], auth: new URL(CONFIG.mcp[env]).origin };
}
