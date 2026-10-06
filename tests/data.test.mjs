import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createData } from '../src/data/data.js';

const USER = {
  userProfile: { email: 'owner@example.test', timezone: 'America/New_York' },
  trueTrackingData: { OUTBOUND_CURRENCY: 'EUR', LEAD_ATTRIBUTION_TIMEFRAME: '7' },
  allowedAccounts: [{ accountId: 'agency-9', email: 'agency@example.test', companyName: 'Agency', status: 'APPROVED' }],
  accessibleAccounts: [],
};

/** A stand-in for mcp.js that records every call and pages ad accounts two at a time. */
function fakeMcp({ adAccountPages = 1 } = {}) {
  const calls = [];
  return {
    calls,
    callTool: async (name, args) => {
      calls.push({ name, args });
      if (name === 'hyros_get_user_info') return USER;
      throw new Error(`unexpected ${name}`);
    },
    callToolPagedInfo: async (name, args, opts) => {
      calls.push({ name, args, opts });
      if (name === 'hyros_get_ad_accounts') {
        const pages = Math.min(adAccountPages, opts.maxPages);
        const rows = Array.from({ length: pages * 2 }, (_, i) => ({ id: 9000 + i, name: `Acct ${i}`, type: 'FACEBOOK', extra: true }));
        return { rows, pages, truncated: adAccountPages > opts.maxPages };
      }
      if (name === 'hyros_get_sources') return { rows: [{ name: 's1' }, { name: 's2' }], pages: 1, truncated: false };
      throw new Error(`unexpected ${name}`);
    },
    callToolPaged: async (name, args, opts) => {
      calls.push({ name, args, opts });
      return [{ name: 'Lead' }];
    },
  };
}

test('account() calls hyros_get_user_info once however often it is asked', async () => {
  const mcp = fakeMcp();
  const data = createData({ mcp });
  const [a, b, c] = await Promise.all([data.account(), data.account(), data.account()]);
  assert.equal(a, b);
  assert.equal(b, c);
  assert.equal(mcp.calls.filter((x) => x.name === 'hyros_get_user_info').length, 1);
});

test('account() reads email, timezone, currency, attribution window and agency links', async () => {
  const data = createData({ mcp: fakeMcp() });
  const account = await data.account();
  assert.equal(account.email, 'owner@example.test');
  assert.equal(account.timezone, 'America/New_York');
  assert.equal(account.currency, 'EUR');
  assert.equal(account.attributionWindowDefault, 7);
  assert.deepEqual(account.managedBy, [{ accountId: 'agency-9', email: 'agency@example.test', company: 'Agency', status: 'APPROVED' }]);
  assert.deepEqual(account.clients, []);
  assert.equal(account.raw, USER);
});

test('adAccounts() pages with a cap of 4 and returns { rows, truncated }', async () => {
  const mcp = fakeMcp({ adAccountPages: 6 });
  const data = createData({ mcp });
  const out = await data.adAccounts();
  const call = mcp.calls.find((x) => x.name === 'hyros_get_ad_accounts');
  assert.equal(call.opts.maxPages, 4);
  assert.equal(out.rows.length, 8);
  assert.deepEqual(out.rows[0], { id: '9000', name: 'Acct 0', type: 'FACEBOOK' });
  assert.equal(out.truncated, true);

  const small = await createData({ mcp: fakeMcp({ adAccountPages: 1 }) }).adAccounts();
  assert.equal(small.truncated, false);
});

test('sources() asks for organic, not disregarded, up to 40 pages', async () => {
  const mcp = fakeMcp();
  const out = await createData({ mcp }).sources();
  const call = mcp.calls.find((x) => x.name === 'hyros_get_sources');
  assert.deepEqual(call.args, { request: { includeOrganic: true, includeDisregarded: false } });
  assert.equal(call.opts.maxPages, 40);
  assert.deepEqual(out, { rows: [{ name: 's1' }, { name: 's2' }], truncated: false });
});

test('invalidate(key) refetches only that getter; invalidate() refetches all', async () => {
  const mcp = fakeMcp();
  const data = createData({ mcp });
  const count = (name) => mcp.calls.filter((x) => x.name === name).length;
  await Promise.all([data.account(), data.adAccounts(), data.stages()]);

  data.invalidate('account');
  await Promise.all([data.account(), data.adAccounts(), data.stages()]);
  assert.equal(count('hyros_get_user_info'), 2);
  assert.equal(count('hyros_get_ad_accounts'), 1);
  assert.equal(count('hyros_get_stages'), 1);

  data.invalidate();
  await Promise.all([data.account(), data.adAccounts(), data.stages()]);
  assert.equal(count('hyros_get_user_info'), 3);
  assert.equal(count('hyros_get_ad_accounts'), 2);
  assert.equal(count('hyros_get_stages'), 2);
});

test('a failed getter is not cached', async () => {
  let fail = true;
  const mcp = fakeMcp();
  const original = mcp.callTool;
  mcp.callTool = async (name, args) => {
    if (fail) { fail = false; throw Object.assign(new Error('slow down'), { code: 'rate_limited' }); }
    return original(name, args);
  };
  const data = createData({ mcp });
  await assert.rejects(data.account(), (err) => err.code === 'rate_limited');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await data.account()).email, 'owner@example.test');
});
