import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createData } from '../src/data/data.js';

const USER = {
  userProfile: { email: 'owner@example.test', timezone: 'America/New_York' },
  trueTrackingData: { OUTBOUND_CURRENCY: 'EUR', LEAD_ATTRIBUTION_TIMEFRAME: '7' },
  allowedAccounts: [{ accountId: 'agency-9', email: 'agency@example.test', companyName: 'Agency', status: 'APPROVED' }],
  accessibleAccounts: [],
};

/** A stand-in for api.js that records every call and pages ad accounts two at a time. */
function fakeApi({ adAccountPages = 1 } = {}) {
  const calls = [];
  return {
    calls,
    get: async (name, args) => {
      calls.push({ name, args });
      if (name === '/user-info') return { result: USER };
      throw new Error(`unexpected ${name}`);
    },
    getPagedInfo: async (name, args, opts) => {
      calls.push({ name, args, opts });
      if (name === '/ad-accounts') {
        const pages = Math.min(adAccountPages, opts.maxPages);
        const rows = Array.from({ length: pages * 2 }, (_, i) => ({ id: 9000 + i, name: `Acct ${i}`, type: 'FACEBOOK', extra: true }));
        return { rows, pages, truncated: adAccountPages > opts.maxPages };
      }
      if (name === '/sources') return { rows: [{ name: 's1' }, { name: 's2' }], pages: 1, truncated: false };
      throw new Error(`unexpected ${name}`);
    },
    getPaged: async (name, args, opts) => {
      calls.push({ name, args, opts });
      return [{ name: 'Lead' }];
    },
  };
}

test('account() calls /user-info once however often it is asked', async () => {
  const mcp = fakeApi();
  const data = createData({ api: mcp });
  const [a, b, c] = await Promise.all([data.account(), data.account(), data.account()]);
  assert.equal(a, b);
  assert.equal(b, c);
  assert.equal(mcp.calls.filter((x) => x.name === '/user-info').length, 1);
});

test('account() reads email, timezone, currency, attribution window and agency links', async () => {
  const data = createData({ api: fakeApi() });
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
  const mcp = fakeApi({ adAccountPages: 6 });
  const data = createData({ api: mcp });
  const out = await data.adAccounts();
  const call = mcp.calls.find((x) => x.name === '/ad-accounts');
  assert.equal(call.opts.maxPages, 4);
  assert.equal(out.rows.length, 8);
  assert.deepEqual(out.rows[0], { id: '9000', name: 'Acct 0', type: 'FACEBOOK' });
  assert.equal(out.truncated, true);

  const small = await createData({ api: fakeApi({ adAccountPages: 1 }) }).adAccounts();
  assert.equal(small.truncated, false);
});

test('sources() asks for organic, not disregarded, up to 40 pages', async () => {
  const mcp = fakeApi();
  const out = await createData({ api: mcp }).sources();
  const call = mcp.calls.find((x) => x.name === '/sources');
  assert.deepEqual(call.args, { includeOrganic: true, includeDisregarded: false });
  assert.equal(call.opts.maxPages, 40);
  assert.deepEqual(out, { rows: [{ name: 's1' }, { name: 's2' }], truncated: false });
});

test('invalidate(key) refetches only that getter; invalidate() refetches all', async () => {
  const mcp = fakeApi();
  const data = createData({ api: mcp });
  const count = (name) => mcp.calls.filter((x) => x.name === name).length;
  await Promise.all([data.account(), data.adAccounts(), data.stages()]);

  data.invalidate('account');
  await Promise.all([data.account(), data.adAccounts(), data.stages()]);
  assert.equal(count('/user-info'), 2);
  assert.equal(count('/ad-accounts'), 1);
  assert.equal(count('/stages'), 1);

  data.invalidate();
  await Promise.all([data.account(), data.adAccounts(), data.stages()]);
  assert.equal(count('/user-info'), 3);
  assert.equal(count('/ad-accounts'), 2);
  assert.equal(count('/stages'), 2);
});

test('a failed getter is not cached', async () => {
  let fail = true;
  const mcp = fakeApi();
  const original = mcp.get;
  mcp.get = async (name, args) => {
    if (fail) { fail = false; throw Object.assign(new Error('slow down'), { code: 'rate_limited' }); }
    return original(name, args);
  };
  const data = createData({ api: mcp });
  await assert.rejects(data.account(), (err) => err.code === 'rate_limited');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await data.account()).email, 'owner@example.test');
});

test('cached(key, loader) runs the loader once per key until invalidate()', async () => {
  const data = createData({ api: fakeApi() });
  let runs = 0;
  const loader = async () => { runs += 1; return { rows: [runs] }; };
  const [a, b] = await Promise.all([data.cached('report:x', loader), data.cached('report:x', loader)]);
  assert.equal(a, b);
  assert.equal(runs, 1);
  await data.cached('report:y', loader);
  assert.equal(runs, 2);

  data.invalidate();
  assert.deepEqual(await data.cached('report:x', loader), { rows: [3] });
});

test('cached() drops a rejected loader and never shadows a getter', async () => {
  const mcp = fakeApi();
  const data = createData({ api: mcp });
  let fail = true;
  const loader = async () => { if (fail) { fail = false; throw new Error('boom'); } return 'ok'; };
  await assert.rejects(data.cached('crm:leads', loader), /boom/);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(await data.cached('crm:leads', loader), 'ok');

  assert.equal(await data.cached('account', async () => 'mine'), 'mine');
  assert.equal((await data.account()).email, 'owner@example.test');
});

test('peek(key) reads a memo without loading or caching anything', async () => {
  const data = createData({ api: fakeApi() });
  assert.equal(data.peek('report:30d'), undefined);
  assert.equal(data.peek('account'), undefined);
  await data.cached('report:30d', async () => ({ rows: [1] }));
  assert.deepEqual(await data.peek('report:30d'), { rows: [1] });
  data.invalidate();
  assert.equal(data.peek('report:30d'), undefined);
});
