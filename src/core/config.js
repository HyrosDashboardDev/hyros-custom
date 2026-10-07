/**
 * Static configuration. Nothing here is a secret: the credential arrives at
 * runtime from the HYROS page that embeds this dashboard (see auth.js).
 */
export const CONFIG = Object.freeze({
  mcp: Object.freeze({
    prod: 'https://mcp.hyros.com/mcp',
    qa: 'https://mcp-qa.hyros.com/mcp',
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
 * The MCP url this page talks to. `<meta name="hyros-mcp-url">` wins: build.mjs
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
