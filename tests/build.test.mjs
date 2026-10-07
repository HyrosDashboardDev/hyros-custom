import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Runs build.mjs from the repo root with the given env on top of a copy of process.env without HYROS_MCP_URL. */
function build(env) {
  const base = { ...process.env };
  delete base.HYROS_MCP_URL;
  return spawnSync(process.execPath, ['build.mjs'], { cwd: ROOT, env: { ...base, ...env }, encoding: 'utf8' });
}

test('build bakes HYROS_MCP_URL into index.html and copies only the site', (t) => {
  const out = mkdtempSync(join(tmpdir(), 'hyros-build-'));
  t.after(() => rmSync(out, { recursive: true, force: true }));

  const run = build({ HYROS_MCP_URL: 'https://localhost:8046/mcp', OUT_DIR: out });

  assert.equal(run.status, 0, run.stderr);
  const html = readFileSync(join(out, 'index.html'), 'utf8');
  assert.ok(html.includes('<meta name="hyros-mcp-url" content="https://localhost:8046/mcp">'), html);
  assert.ok(existsSync(join(out, 'src', 'app.js')));
  assert.ok(existsSync(join(out, 'assets')));
  for (const left of ['dev', 'scripts', 'tests']) {
    assert.ok(!existsSync(join(out, left)), `${left}/ was copied`);
  }
});

test('build fails without HYROS_MCP_URL instead of falling back to prod', (t) => {
  const out = mkdtempSync(join(tmpdir(), 'hyros-build-'));
  t.after(() => rmSync(out, { recursive: true, force: true }));

  const run = build({ OUT_DIR: out });

  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /HYROS_MCP_URL/);
});
