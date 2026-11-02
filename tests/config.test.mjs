import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG, directUrls, resolveApiUrl, resolveAuthServer, resolveEnv, resolveMcpUrl, resolveRedirectUri } from '../src/core/config.js';

test('the baked hyros-mcp-url meta wins over ?mcp=', () => {
  assert.equal(resolveMcpUrl({ search: '?mcp=qa', metaUrl: 'https://localhost:8046/mcp' }), 'https://localhost:8046/mcp');
});

test('without the meta, ?mcp=qa selects QA', () => {
  assert.equal(resolveMcpUrl({ search: '?mcp=qa', metaUrl: '' }), CONFIG.mcp.qa);
});

test('without the meta or ?mcp=, the url is prod', () => {
  assert.equal(resolveMcpUrl({ search: '', metaUrl: undefined }), CONFIG.mcp.prod);
});

test('an unknown ?mcp= value is prod', () => {
  assert.equal(resolveMcpUrl({ search: '?mcp=nonsense' }), CONFIG.mcp.prod);
});

test('the OAuth server is the origin of the MCP url', () => {
  assert.equal(resolveAuthServer(CONFIG.mcp.prod), 'https://mcp.hyros.com');
  assert.equal(resolveAuthServer('https://localhost:8046/mcp'), 'https://localhost:8046');
});

test('the redirect uri is this page, keeping only ?mcp= from the query', () => {
  assert.equal(resolveRedirectUri({ origin: 'https://dash.example', pathname: '/', search: '' }), 'https://dash.example/');
  assert.equal(resolveRedirectUri({ origin: 'http://localhost:4321', pathname: '/', search: '?utm_source=x&mcp=qa' }), 'http://localhost:4321/?mcp=qa');
  assert.equal(resolveRedirectUri({ origin: 'https://dash.example', pathname: '/index.html', search: '?code=abc&state=s' }), 'https://dash.example/index.html');
});

test('the API is the one of the environment of the MCP url', () => {
  assert.equal(resolveApiUrl(CONFIG.mcp.prod, { metaUrl: undefined }), 'https://api.hyros.com/v1/api/v1.0');
  assert.equal(resolveApiUrl(CONFIG.mcp.qa, { metaUrl: undefined }), 'https://api-staging.hyros.com/v1/api/v1.0');
});

test('the baked hyros-api-url meta wins, and an unknown MCP url has no API without it', () => {
  assert.equal(resolveApiUrl('https://localhost:8046/mcp', { metaUrl: 'https://localhost:8443/v1/api/v1.0' }), 'https://localhost:8443/v1/api/v1.0');
  assert.equal(resolveApiUrl('https://localhost:8046/mcp', { metaUrl: '' }), null);
});

const PROD_CDN = 'https://d1dan6xu9gc9j7.cloudfront.net';
const QA_CDN = 'https://d1uwky5nlh5sj8.cloudfront.net';

test('resolveEnv reads the direct hosts of each environment', () => {
  assert.equal(resolveEnv(CONFIG.mcp.prod, CONFIG.api.prod), 'prod');
  assert.equal(resolveEnv(CONFIG.mcp.qa, CONFIG.api.qa), 'qa');
  assert.equal(resolveEnv(CONFIG.mcp.qa, null), 'qa', 'without an API url the MCP url decides');
});

test('resolveEnv reads the CDN hosts in either url', () => {
  assert.equal(resolveEnv(`${PROD_CDN}/mcp`, `${PROD_CDN}/v1/api/v1.0`), 'prod');
  assert.equal(resolveEnv(CONFIG.mcp.prod, `${PROD_CDN}/v1/api/v1.0`), 'prod');
  assert.equal(resolveEnv(`${QA_CDN}/mcp`, CONFIG.api.qa), 'qa');
});

test('resolveEnv is null for an unknown host, a mix of environments or a malformed url', () => {
  assert.equal(resolveEnv('https://localhost:8046/mcp', 'https://localhost:8443/v1/api/v1.0'), null);
  assert.equal(resolveEnv('https://localhost:8046/mcp', CONFIG.api.qa), null);
  assert.equal(resolveEnv(CONFIG.mcp.prod, 'https://localhost:8443/v1/api/v1.0'), null);
  assert.equal(resolveEnv(CONFIG.mcp.prod, `${QA_CDN}/v1/api/v1.0`), null);
  assert.equal(resolveEnv('https://mcp.hyros.com.evil.example/mcp', null), null);
  assert.equal(resolveEnv('not a url', null), null);
});

test('directUrls are the direct API and OAuth server of an environment', () => {
  assert.deepEqual(directUrls('prod'), { api: 'https://api.hyros.com/v1/api/v1.0', auth: 'https://mcp.hyros.com' });
  assert.deepEqual(directUrls('qa'), { api: 'https://api-staging.hyros.com/v1/api/v1.0', auth: 'https://mcp-qa.hyros.com' });
  assert.equal(directUrls('staging'), null);
  assert.equal(directUrls('toString'), null);
});
