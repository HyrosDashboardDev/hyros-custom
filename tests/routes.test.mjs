import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG, directUrls, resolveEnv } from '../src/core/config.js';
import { createRoutes } from '../src/core/routes.js';

const PROD_CDN = 'https://d1dan6xu9gc9j7.cloudfront.net';
const QA_CDN = 'https://d1uwky5nlh5sj8.cloudfront.net';

test('the built-in fallback hosts are https urls', () => {
  for (const env of Object.keys(CONFIG.fallback)) {
    for (const channel of ['api', 'auth']) {
      for (const url of CONFIG.fallback[env][channel]) {
        assert.equal(new URL(url).protocol, 'https:', url);
      }
    }
  }
});

test('each environment tries its direct host, then its CloudFront host, on both channels', () => {
  const cdn = { prod: PROD_CDN, qa: QA_CDN };
  for (const env of ['prod', 'qa']) {
    const direct = directUrls(env);
    const routes = createRoutes({ env, direct });
    assert.deepEqual(routes.bases('api'), [direct.api, `${cdn[env]}/v1/api/v1.0`], env);
    assert.deepEqual(routes.bases('auth'), [direct.auth, cdn[env]], env);
  }
});

test('an environment without fallback hosts has only its direct host', () => {
  const routes = createRoutes({ env: 'local', direct: { api: 'https://localhost:8443/v1/api/v1.0/', auth: 'https://localhost:8046' } });
  assert.deepEqual(routes.bases('api'), ['https://localhost:8443/v1/api/v1.0']);
  assert.deepEqual(routes.bases('auth'), ['https://localhost:8046']);
});

test('bases always start with the direct host, even when the build named the CDN', () => {
  const env = resolveEnv(`${PROD_CDN}/mcp`, `${PROD_CDN}/v1/api/v1.0`);
  assert.equal(env, 'prod');
  const routes = createRoutes({ env, direct: directUrls(env) });
  assert.deepEqual(routes.bases('api'), ['https://api.hyros.com/v1/api/v1.0', `${PROD_CDN}/v1/api/v1.0`]);
  assert.deepEqual(routes.bases('auth'), ['https://mcp.hyros.com', PROD_CDN]);
  assert.deepEqual(routes.active('api'), { base: 'https://api.hyros.com/v1/api/v1.0', viaFallback: false });
});

test('a direct host listed in the fallbacks is not tried twice, and trailing slashes and repeats are dropped', async () => {
  const fallbacks = {
    api: ['https://api-staging.hyros.com/v1/api/v1.0/', `${QA_CDN}/v1/api/v1.0`, `${QA_CDN}/v1/api/v1.0/`],
    auth: [],
  };
  const routes = createRoutes({ env: 'qa', direct: directUrls('qa'), fallbacks });
  const { tried, run } = hosts({ [`${QA_CDN}/v1/api/v1.0`]: 200 });
  await routes.withFallback('api', run);
  assert.deepEqual(tried, ['https://api-staging.hyros.com/v1/api/v1.0', `${QA_CDN}/v1/api/v1.0`]);
  assert.deepEqual(routes.bases('api'), ['https://api-staging.hyros.com/v1/api/v1.0', `${QA_CDN}/v1/api/v1.0`]);
  assert.deepEqual(routes.bases('auth'), ['https://mcp-qa.hyros.com']);
});

/** A run(base) that answers per host: 'down' (or an unlisted host) rejects like a blocked fetch, a number is an HTTP status. */
function hosts(table) {
  const tried = [];
  const run = async (base) => {
    tried.push(base);
    const outcome = table[base];
    if (outcome === 'down' || outcome === undefined) throw new TypeError('Failed to fetch');
    if (outcome === 'abort') throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    if (outcome >= 400) throw Object.assign(new Error(`HTTP ${outcome}`), { status: outcome });
    return { base, status: outcome };
  };
  return { tried, run };
}

const prodRoutes = (fallbacks) => createRoutes({ env: 'prod', direct: directUrls('prod'), fallbacks });
const API = 'https://api.hyros.com/v1/api/v1.0';
const CDN_API = `${PROD_CDN}/v1/api/v1.0`;

test('withFallback moves on only on a network failure, and the fallback sticks', async () => {
  const routes = prodRoutes();
  const { tried, run } = hosts({ [API]: 'down', [CDN_API]: 200 });
  assert.deepEqual(await routes.withFallback('api', run), { base: CDN_API, status: 200 });
  assert.deepEqual(routes.active('api'), { base: CDN_API, viaFallback: true });
  await routes.withFallback('api', run);
  assert.deepEqual(tried, [API, CDN_API, CDN_API], 'later calls go straight to the fallback');
  assert.deepEqual(routes.active('auth'), { base: 'https://mcp.hyros.com', viaFallback: false }, 'auth keeps its own host');
});

test('an HTTP answer never switches, whatever the status', async () => {
  for (const status of [401, 403, 429, 500, 502]) {
    const routes = prodRoutes();
    const { tried, run } = hosts({ [API]: status, [CDN_API]: 200 });
    await assert.rejects(routes.withFallback('api', run), (err) => err.status === status);
    assert.deepEqual(tried, [API]);
    assert.equal(routes.active('api').viaFallback, false);
  }
});

test('a timeout (AbortError) is not a network failure', async () => {
  const routes = prodRoutes();
  const { tried, run } = hosts({ [API]: 'abort', [CDN_API]: 200 });
  await assert.rejects(routes.withFallback('api', run), (err) => err.name === 'AbortError');
  assert.deepEqual(tried, [API]);
});

test('every host down throws the first network error, after trying each once', async () => {
  const routes = prodRoutes();
  const errors = [];
  const run = async (base) => {
    const err = new TypeError(`Failed to fetch ${base}`);
    errors.push(err);
    throw err;
  };
  const thrown = await routes.withFallback('api', run).catch((err) => err);
  assert.equal(errors.length, 2);
  assert.equal(thrown, errors[0]);
});

test('the active fallback going down wraps around to the direct host', async () => {
  const routes = prodRoutes();
  const table = { [API]: 'down', [CDN_API]: 200 };
  const { tried, run } = hosts(table);
  await routes.withFallback('api', run);
  table[CDN_API] = 'down';
  table[API] = 200;
  await routes.withFallback('api', run);
  assert.deepEqual(tried, [API, CDN_API, CDN_API, API]);
  assert.equal(routes.active('api').viaFallback, false);
});

test('an empty fallback list means no fallback', async () => {
  const routes = prodRoutes({ api: [], auth: [] });
  const { tried, run } = hosts({ [API]: 'down' });
  await assert.rejects(routes.withFallback('api', run), TypeError);
  assert.deepEqual(tried, [API]);
});

test('with a probe, a network failure moves on only when the probe fails at network level too', async () => {
  const routes = prodRoutes();
  const { tried, run } = hosts({ [API]: 'down', [CDN_API]: 200 });
  const probed = [];
  const reachable = async (base) => { probed.push(base); return { status: 404 }; };
  const err = await routes.withFallback('api', run, { probe: reachable }).catch((e) => e);
  assert.ok(err instanceof TypeError, 'the original error, not the probe answer');
  assert.deepEqual(tried, [API]);
  assert.deepEqual(probed, [API]);
  assert.equal(routes.active('api').viaFallback, false);

  const blocked = async (base) => { probed.push(base); throw new TypeError('Failed to fetch'); };
  assert.deepEqual(await routes.withFallback('api', run, { probe: blocked }), { base: CDN_API, status: 200 });
  assert.deepEqual(tried, [API, API, CDN_API]);
  assert.equal(routes.active('api').viaFallback, true);
});

test('the probe never runs when the host answers', async () => {
  const routes = prodRoutes();
  const { run } = hosts({ [API]: 500 });
  let probed = 0;
  await assert.rejects(routes.withFallback('api', run, { probe: async () => { probed += 1; } }));
  assert.equal(probed, 0);
});
