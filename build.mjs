/**
 * Production build for Vercel.
 *
 * HYROS provisions one Vercel project per dashboard and sets HYROS_MCP_URL on
 * it: the MCP server of the HYROS environment that provisioned it. A static
 * deployment cannot read environment variables at runtime, so this build
 * copies the site into the output directory and bakes the url into
 * index.html as <meta name="hyros-mcp-url">, which src/core/config.js reads.
 * HYROS_API_URL is optional: when set it is baked as <meta name="hyros-api-url">;
 * without it the page uses the customer API of the environment of the MCP url.
 * When both urls are on the direct hosts of the same known environment, the
 * metas only pick that environment and the page starts on its direct hosts;
 * HYROS_API_URL is used as given only when they do not (a local server).
 * HYROS_FALLBACK_API_URL and HYROS_FALLBACK_AUTH_URL are optional too: the
 * fallback host of the customer API (with its /v1/api/v1.0 path) and of the
 * OAuth server, baked as <meta name="hyros-fallback-api-url"> and
 * <meta name="hyros-fallback-auth-url">. Each one, when set, is the only
 * fallback of its channel; without it the page has no fallback for that
 * channel.
 *
 * Usage: HYROS_MCP_URL=<url> [HYROS_API_URL=<url>] [HYROS_FALLBACK_API_URL=<url>]
 *        [HYROS_FALLBACK_AUTH_URL=<url>] node build.mjs   (OUT_DIR defaults to public/)
 */
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveApiUrl } from './src/core/config.js';

const ROOT = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(ROOT, process.env.OUT_DIR || 'public');

/** Everything the page needs at runtime; nothing else is published. */
const ENTRIES = ['index.html', 'styles.css', 'src', 'assets'];

const VIEWPORT_META = /^.*<meta name="viewport"[^>]*>.*$/m;

/**
 * A missing or malformed url fails the build. Falling back to production
 * silently would point a QA or local dashboard at production data, which is
 * exactly what this build exists to prevent.
 */
function readUrl(name, what, { optional = false } = {}) {
  const value = process.env[name];
  if (optional && !value) return null;
  try {
    if (value) {
      new URL(value);
      return value;
    }
  } catch {
    // Not a url: reported below.
  }
  console.error(`${name} must be the ${what} of the HYROS environment, got: ${value === undefined ? '(not set)' : JSON.stringify(value)}`);
  process.exit(1);
}

function escapeAttribute(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

const mcpUrl = readUrl('HYROS_MCP_URL', 'MCP server url');
const apiUrl = readUrl('HYROS_API_URL', 'customer API url', { optional: true });
const fallbackApiUrl = readUrl('HYROS_FALLBACK_API_URL', 'fallback customer API url', { optional: true });
const fallbackAuthUrl = readUrl('HYROS_FALLBACK_AUTH_URL', 'fallback OAuth server origin', { optional: true });
// The same rule the page applies: without the variable the MCP url must name a known environment.
if (!resolveApiUrl(mcpUrl, { metaUrl: apiUrl })) {
  console.error(`HYROS_API_URL must be set: ${mcpUrl} is not the MCP of a known HYROS environment`);
  process.exit(1);
}

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });
for (const entry of ENTRIES) {
  await cp(join(ROOT, entry), join(OUT, entry), { recursive: true });
}

const indexPath = join(OUT, 'index.html');
const html = await readFile(indexPath, 'utf8');
const viewport = html.match(VIEWPORT_META);
if (!viewport) {
  console.error('index.html has no <meta name="viewport"> line to place the hyros-mcp-url meta after');
  process.exit(1);
}
const indent = viewport[0].match(/^\s*/)[0];
let meta = `${indent}<meta name="hyros-mcp-url" content="${escapeAttribute(mcpUrl)}">`;
if (apiUrl) meta += `\n${indent}<meta name="hyros-api-url" content="${escapeAttribute(apiUrl)}">`;
if (fallbackApiUrl) meta += `\n${indent}<meta name="hyros-fallback-api-url" content="${escapeAttribute(fallbackApiUrl)}">`;
if (fallbackAuthUrl) meta += `\n${indent}<meta name="hyros-fallback-auth-url" content="${escapeAttribute(fallbackAuthUrl)}">`;
const at = viewport.index + viewport[0].length;
await writeFile(indexPath, `${html.slice(0, at)}\n${meta}${html.slice(at)}`);

const baked = [
  ['HYROS_MCP_URL', mcpUrl],
  ['HYROS_API_URL', apiUrl],
  ['HYROS_FALLBACK_API_URL', fallbackApiUrl],
  ['HYROS_FALLBACK_AUTH_URL', fallbackAuthUrl],
].filter(([, value]) => value).map(([name, value]) => `${name}=${value}`);
console.log(`Built ${OUT} with ${baked.join(' ')}`);
