/**
 * Local development: two origins, like production.
 *
 *   http://localhost:4321   the dashboard (index.html, styles.css, src/, assets/)
 *   http://localhost:4323   the harness that plays HYROS (dev/host.html)
 *
 * The dashboard answers with `frame-ancestors http://localhost:4323`, so only
 * the harness may frame it. Use `localhost`, not 127.0.0.1: they are different
 * origins and src/core/config.js lists http://localhost:4323.
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const DASHBOARD_PORT = 4321;
const HOST_PORT = 4323;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json', '.woff2': 'font/woff2', '.png': 'image/png', '.ico': 'image/x-icon' };

/** Resolve a url path under `base`, or null when it escapes it or is not on the allow list. */
function resolvePath(base, urlPath, allowed) {
  const clean = normalize(decodeURIComponent(urlPath)).replace(/^([/\\])+/, '');
  if (!allowed(clean.split(sep).join('/'))) return null;
  const full = join(base, clean);
  return full.startsWith(base) ? full : null;
}

function serve({ port, base, index, allowed, headers }) {
  const server = createServer(async (req, res) => {
    const { pathname } = new URL(req.url, 'http://localhost');
    const file = resolvePath(base, pathname === '/' ? index : pathname, allowed);
    if (!file) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      return res.end('not found');
    }
    try {
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store', ...headers });
      return res.end(body);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain' });
      return res.end('not found');
    }
  });
  return new Promise((resolve) => server.listen(port, 'localhost', () => resolve(server)));
}

await serve({
  port: DASHBOARD_PORT,
  base: ROOT,
  index: 'index.html',
  allowed: (path) => path === 'index.html' || path === 'styles.css' || path.startsWith('src/') || path.startsWith('assets/'),
  headers: {
    'content-security-policy': `frame-ancestors http://localhost:${HOST_PORT}`,
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'strict-origin-when-cross-origin',
  },
});

await serve({
  port: HOST_PORT,
  base: join(ROOT, 'dev'),
  index: 'host.html',
  allowed: (path) => path === 'host.html' || path === 'host.js',
  headers: { 'x-content-type-options': 'nosniff' },
});

console.log(`dashboard  http://localhost:${DASHBOARD_PORT}   (direct: shows "Open this dashboard from HYROS")`);
console.log(`harness    http://localhost:${HOST_PORT}   (plays HYROS: paste a token, it answers ready and token-request)`);
