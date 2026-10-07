import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG, resolveMcpUrl } from '../src/core/config.js';

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
