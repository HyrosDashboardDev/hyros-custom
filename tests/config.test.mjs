import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG, resolveApiUrl, resolveAuthServer, resolveMcpUrl, resolveRedirectUri } from '../src/core/config.js';

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
