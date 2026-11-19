/**
 * The add-database skill's fixed files, tested where they live (.claude/skills/add-database/files/) so a
 * dashboard without a database never carries them. What needs the postgres package (db.js, respond.js and
 * migrate() with a url) is not loaded here: the template has no dependencies.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { cp, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const FILES = join(ROOT, '.claude', 'skills', 'add-database', 'files');
const at = (path) => new URL(`../.claude/skills/add-database/files/${path}`, import.meta.url).href;

const { HttpError, toResponse, badRequest, notFound } = await import(at('api/_lib/errors.js'));
const { bearer, verifyWithHyros, requireDashboardUser, clearCache, CACHE_MS } = await import(at('api/_lib/auth.js'));
const { migrate, migrationFiles } = await import(at('supabase/migrate.mjs'));
// src/core/db.js imports ./api.js: install it next to the template's core, as the skill does in a dashboard.
const core = join(await mkdtemp(join(tmpdir(), 'core-')), 'src', 'core');
await cp(join(ROOT, 'src', 'core'), core, { recursive: true });
await cp(join(FILES, 'src', 'core', 'db.js'), join(core, 'db.js'));
const { db, request, DbError } = await import(pathToFileURL(join(core, 'db.js')).href);
const { configure, credential } = await import(pathToFileURL(join(core, 'api.js')).href);

const ACCOUNT = '3fbcb1563c51a0e0';
const ENV = { HYROS_API_URL: 'https://api.test/v1/api/v1.0/', DASHBOARD_ACCOUNT_ID: ACCOUNT };

function hyros(status, profile) {
  const seen = [];
  const fetchFn = async (url, init) => {
    seen.push({ url, authorization: init.headers.authorization });
    return { status, ok: status >= 200 && status < 300, json: async () => ({ result: { userProfile: profile } }) };
  };
  return { seen, fetchFn };
}

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(entries.map((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)])));
  return nested.flat();
}

beforeEach(() => clearCache());

test('every fixed file starts with the same add-database version line', async () => {
  const files = await walk(FILES);
  assert.ok(files.length >= 8, 'the skill ships its fixed files');
  const versions = new Set();
  for (const file of files) {
    const first = (await readFile(file, 'utf8')).split('\n')[0];
    const match = /add-database v(\d+)\./.exec(first);
    assert.ok(match, `${relative(FILES, file).split(sep).join('/')} starts with an add-database v<N> line`);
    versions.add(match[1]);
  }
  assert.equal(versions.size, 1, 'one version for all the fixed files, raised together');
});

test('the template carries no database file outside the skill', async () => {
  for (const path of ['api', 'supabase', 'src/core/db.js']) {
    assert.ok(!existsSync(join(ROOT, path)), `${path} exists only once the skill copied it`);
  }
});

test('a route error maps to its status and code', () => {
  assert.deepEqual(toResponse(badRequest('text is required')), { status: 400, code: 'bad_request', message: 'text is required' });
  assert.equal(toResponse(notFound()).status, 404);
  assert.equal(toResponse(new HttpError(403, 'forbidden', 'x')).code, 'forbidden');
  assert.deepEqual(toResponse({ code: '25006' }).status, 507, 'a full disk turns the database read only');
  assert.equal(toResponse({ code: 'ECONNREFUSED' }).code, 'unavailable');
  assert.deepEqual(toResponse(new Error('syntax error at or near "selec"')), { status: 500, code: 'internal', message: 'The dashboard database failed to answer' },
    'a database error never reaches the page');
});

test('the bearer token is read from the Authorization header only', () => {
  assert.equal(bearer({ headers: { authorization: 'Bearer abc.def' } }), 'abc.def');
  assert.equal(bearer({ headers: { authorization: 'Basic abc' } }), null);
  assert.equal(bearer({ headers: {} }), null);
});

test('a request without a token is refused before HYROS is asked', async () => {
  await assert.rejects(requireDashboardUser({ headers: {} }, { env: ENV, fetchFn: () => assert.fail('no call') }), { status: 401, code: 'auth' });
});

test('a token of the owning account is accepted, asked with HYROS once per cache window', async () => {
  const { seen, fetchFn } = hyros(200, { accountId: ACCOUNT, email: 'owner@example.com' });

  assert.deepEqual(await verifyWithHyros('tok-1', { env: ENV, fetchFn, now: 1000 }), { accountId: ACCOUNT, email: 'owner@example.com' });
  await verifyWithHyros('tok-1', { env: ENV, fetchFn, now: 1000 + CACHE_MS - 1 });
  assert.equal(seen.length, 1, 'the second call is served from the cache');
  assert.equal(seen[0].url, 'https://api.test/v1/api/v1.0/user-info');
  assert.equal(seen[0].authorization, 'Bearer tok-1');

  await verifyWithHyros('tok-1', { env: ENV, fetchFn, now: 1000 + CACHE_MS + 1 });
  assert.equal(seen.length, 2, 'an expired entry is asked again');
});

test('a token of another account is refused', async () => {
  const { fetchFn } = hyros(200, { accountId: 'someone-else' });
  await assert.rejects(verifyWithHyros('tok-1', { env: ENV, fetchFn }), { status: 403, code: 'forbidden' });
});

test('a token HYROS refuses is refused, and is not cached', async () => {
  const refused = hyros(401, null);
  await assert.rejects(verifyWithHyros('tok-1', { env: ENV, fetchFn: refused.fetchFn }), { status: 401, code: 'auth' });
  const accepted = hyros(200, { accountId: ACCOUNT });
  await verifyWithHyros('tok-1', { env: ENV, fetchFn: accepted.fetchFn });
  assert.equal(accepted.seen.length, 1);
});

test('without the variables or HYROS the route is unavailable, never open', async () => {
  await assert.rejects(verifyWithHyros('tok-1', { env: {}, fetchFn: () => assert.fail('no call') }), { status: 503, code: 'no_database' });
  await assert.rejects(verifyWithHyros('tok-1', { env: ENV, fetchFn: async () => { throw new Error('down'); } }), { status: 503, code: 'unavailable' });
  const noId = hyros(200, { email: 'owner@example.com' });
  await assert.rejects(verifyWithHyros('tok-1', { env: ENV, fetchFn: noId.fetchFn }), { status: 503 }, 'a profile without accountId is never accepted');
});

test('migrations run in name order and a badly named file fails the build', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'migrations-'));
  await writeFile(join(dir, '0002_add_stage.sql'), 'select 1;');
  await writeFile(join(dir, '0001_create_notes.sql'), 'select 1;');
  assert.deepEqual(await migrationFiles(dir), ['0001_create_notes.sql', '0002_add_stage.sql']);

  await writeFile(join(dir, 'notes.sql'), 'select 1;');
  await assert.rejects(migrationFiles(dir), /0001_create_notes\.sql/);
});

test('without a database url migrate does nothing', async () => {
  const lines = [];
  assert.deepEqual(await migrate({ url: '', log: (line) => lines.push(line) }), []);
  assert.match(lines[0], /nothing to migrate/);
});

test('the page calls its own routes with the HYROS token and retries once with a new one', async () => {
  let n = 0;
  const invalidated = [];
  configure({ url: 'https://api.test/v1/api/v1.0', getToken: async () => `tok-${++n}`, markInvalid: (t) => invalidated.push(t) });
  assert.ok(credential(), 'api.js lends its credential once configured');

  const seen = [];
  const fetchFn = async (href, init) => {
    seen.push({ href, method: init.method, authorization: init.headers.authorization, body: init.body });
    if (seen.length === 1) return { status: 401, ok: false, json: async () => ({ error: { code: 'auth', message: 'refused' } }) };
    return { status: 200, ok: true, json: async () => ({ id: 1 }) };
  };

  assert.deepEqual(await request('POST', 'notes', { body: { text: 'hi' }, fetchFn }), { id: 1 });
  assert.deepEqual(seen.map((s) => s.authorization), ['Bearer tok-1', 'Bearer tok-2']);
  assert.equal(seen[0].href, '/api/db/notes');
  assert.equal(seen[0].body, '{"text":"hi"}');
  assert.deepEqual(invalidated, ['tok-1']);
});

test('a route error reaches the view as a DbError with its code', async () => {
  configure({ url: 'https://api.test/v1/api/v1.0', getToken: async () => 'tok', markInvalid: () => {} });
  const fetchFn = async () => ({ status: 507, ok: false, json: async () => ({ error: { code: 'storage_full', message: 'The dashboard database is full.' } }) });

  await assert.rejects(request('GET', 'notes', { params: { stage: 'won' }, fetchFn }), (err) => err instanceof DbError && err.code === 'storage_full' && err.status === 507);
  await assert.rejects(request('GET', '../secrets', { fetchFn }), { code: 'bad_request' }, 'a route name never leaves /api/db/');
  assert.equal(typeof db.get, 'function');
});
