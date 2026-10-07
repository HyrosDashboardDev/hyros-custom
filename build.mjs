/**
 * Production build for Vercel.
 *
 * HYROS provisions one Vercel project per dashboard and sets HYROS_MCP_URL on
 * it: the MCP server of the HYROS environment that provisioned it. A static
 * deployment cannot read environment variables at runtime, so this build
 * copies the site into the output directory and bakes the url into
 * index.html as <meta name="hyros-mcp-url">, which src/core/config.js reads.
 *
 * Usage: HYROS_MCP_URL=<url> node build.mjs   (OUT_DIR defaults to public/)
 */
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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
function readMcpUrl() {
  const value = process.env.HYROS_MCP_URL;
  try {
    if (value) {
      new URL(value);
      return value;
    }
  } catch {
    // Not a url: reported below.
  }
  console.error(`HYROS_MCP_URL must be the MCP server url of the HYROS environment, got: ${value === undefined ? '(not set)' : JSON.stringify(value)}`);
  process.exit(1);
}

function escapeAttribute(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

const mcpUrl = readMcpUrl();

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
const meta = `${indent}<meta name="hyros-mcp-url" content="${escapeAttribute(mcpUrl)}">`;
const at = viewport.index + viewport[0].length;
await writeFile(indexPath, `${html.slice(0, at)}\n${meta}${html.slice(at)}`);

console.log(`Built ${OUT} with HYROS_MCP_URL=${mcpUrl}`);
