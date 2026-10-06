/**
 * The rules CLAUDE.md and VIEWS.md state, checked on the source: views reach
 * HYROS only through ctx.data, the core depends on nothing above it, every
 * registered view honors the contract and ships a SPEC.md, colors come only
 * from the tokens in styles.css, and no file uses what the HYROS iframe
 * sandbox blocks or what can throw in a partitioned frame.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'src');

function walk(dir, ext = '.js') {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path, ext) : path.endsWith(ext) ? [path] : [];
  });
}

/**
 * Two views of a source file: `code` without comments (strings kept, for
 * import specifiers) and `bare` without comments or string contents (for
 * calls and braces). Template literals are treated as plain strings.
 */
function strip(text) {
  let code = '';
  let bare = '';
  for (let i = 0; i < text.length;) {
    const c = text[i];
    const next = text[i + 1];
    if (c === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i += 1;
      continue;
    }
    if (c === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? text.length : end + 2;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < text.length && text[j] !== c) j += text[j] === '\\' ? 2 : 1;
      const literal = text.slice(i, j + 1);
      code += literal;
      bare += c + ' '.repeat(Math.max(0, literal.length - 2)) + c;
      i = j + 1;
      continue;
    }
    code += c;
    bare += c;
    i += 1;
  }
  return { code, bare };
}

const IMPORT_RE = /(?:import|export)\s[^;]*?from\s*['"]([^'"]+)['"]|import\s*['"]([^'"]+)['"]|import\s*\(\s*['"`]([^'"`]+)['"`]/g;

function importsOf(file) {
  const { code } = strip(readFileSync(file, 'utf8'));
  return [...code.matchAll(IMPORT_RE)]
    .map((m) => m[1] || m[2] || m[3])
    .filter((spec) => spec.startsWith('.'))
    .map((spec) => resolve(dirname(file), spec));
}

const rel = (path) => relative(ROOT, path).split(sep).join('/');
const files = walk(SRC);
const viewFiles = files.filter((f) => rel(f).startsWith('src/views/'));
const coreFiles = files.filter((f) => rel(f).startsWith('src/core/'));

test('views never import the MCP client, the auth module or the config, and never call fetch', () => {
  const banned = ['src/core/mcp.js', 'src/core/auth.js', 'src/core/config.js'];
  for (const file of viewFiles) {
    for (const target of importsOf(file)) {
      assert.ok(!banned.includes(rel(target)), `${rel(file)} imports ${rel(target)}; use ctx.data instead`);
    }
    assert.doesNotMatch(strip(readFileSync(file, 'utf8')).bare, /(^|[^\w$.])fetch\s*\(/, `${rel(file)} calls fetch; use ctx.data instead`);
  }
});

test('the core imports nothing from views or data', () => {
  for (const file of coreFiles) {
    for (const target of importsOf(file)) {
      assert.ok(!/^src\/(views|data)\//.test(rel(target)), `${rel(file)} imports ${rel(target)}`);
    }
  }
});

test('every registered view exports the contract and matches its folder', async () => {
  const { VIEWS } = await import(pathToFileURL(join(SRC, 'views/registry.js')).href);
  assert.ok(Array.isArray(VIEWS) && VIEWS.length > 0, 'registry.js exports a non-empty VIEWS');
  assert.equal(new Set(VIEWS).size, VIEWS.length, 'view ids are unique');
  for (const id of VIEWS) {
    const { view } = await import(pathToFileURL(join(SRC, 'views', id, 'view.js')).href);
    assert.ok(view, `src/views/${id}/view.js exports view`);
    assert.equal(view.id, id, `src/views/${id}/view.js has id '${id}'`);
    assert.equal(typeof view.title, 'string', `${id}: title is a string`);
    assert.equal(typeof view.render, 'function', `${id}: render is a function`);
  }
});

test('every registered view folder has a SPEC.md', async () => {
  const { VIEWS } = await import(pathToFileURL(join(SRC, 'views/registry.js')).href);
  for (const id of VIEWS) {
    assert.ok(existsSync(join(SRC, 'views', id, 'SPEC.md')), `src/views/${id}/SPEC.md is missing; every view ships its spec`);
  }
});

/** A 3, 4, 6 or 8 digit hex color. Colors live as tokens in styles.css :root; src/ uses var(--token). */
const HEX_COLOR = /#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b/;

test('no hex color literal in src/ JavaScript or view stylesheets (colors come from styles.css tokens)', () => {
  // Strings are kept on purpose: markup and inline styles live in template literals.
  for (const file of files) {
    assert.doesNotMatch(strip(readFileSync(file, 'utf8')).code, HEX_COLOR, `${rel(file)} hardcodes a color; use a token from styles.css`);
  }
  for (const file of walk(join(SRC, 'views'), '.css')) {
    const css = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    assert.doesNotMatch(css, HEX_COLOR, `${rel(file)} hardcodes a color; use a token from styles.css`);
  }
});

test('the hex detector itself: catches colors, ignores ids and entities', () => {
  assert.match('color: #fff', HEX_COLOR);
  assert.match('style="color:#1F1E1D"', HEX_COLOR);
  assert.match('background: #1F1E1D80;', HEX_COLOR);
  assert.doesNotMatch("$('#refreshBtn')", HEX_COLOR);
  assert.doesNotMatch('&#39;', HEX_COLOR);
});

test('no file uses alert, confirm or prompt (the sandbox blocks them)', () => {
  for (const file of files) {
    assert.doesNotMatch(strip(readFileSync(file, 'utf8')).bare, /(^|[^\w$])(alert|confirm|prompt)\s*\(/, `${rel(file)} opens a native dialog`);
  }
});

/** Whether `index` in `bare` sits inside a `try { ... }` block. */
function insideTry(bare, index) {
  const stack = [];
  for (let i = 0; i < index; i += 1) {
    if (bare[i] === '{') stack.push(/\btry\s*$/.test(bare.slice(Math.max(0, i - 10), i)));
    else if (bare[i] === '}') stack.pop();
  }
  return stack.includes(true);
}

test('localStorage is only touched inside a try (partitioned frames and Safari can throw)', () => {
  for (const file of files) {
    const { bare } = strip(readFileSync(file, 'utf8'));
    for (const m of bare.matchAll(/\blocalStorage\b/g)) {
      assert.ok(insideTry(bare, m.index), `${rel(file)} touches localStorage outside a try`);
    }
  }
});

test('the try detector itself: catches a bare access, accepts a guarded one', () => {
  const bad = strip('const x = localStorage.getItem("k");').bare;
  const good = strip('let x; try { x = localStorage.getItem("k"); } catch { x = null; }').bare;
  assert.equal(insideTry(bad, bad.indexOf('localStorage')), false);
  assert.equal(insideTry(good, good.indexOf('localStorage')), true);
});
