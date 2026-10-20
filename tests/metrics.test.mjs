/**
 * The metric engine against REAL numbers read off a live HYROS Performance
 * Report screen (2026-08-13..19, Traffic source level, Last Click), ported
 * from hyros-ai's selftest. If HYROS changes a definition, these fail loudly.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CATALOG, ADDITIVE, DEFAULT_KEYS, derive, aggregate, rollup } from '../src/data/metrics.js';

const approx = (a, b, tol = 0.01) => Math.abs(a - b) <= tol;

/** The selftest's check, on node:assert: numbers within `tol`, anything else strictly equal. */
function check(name, actual, expected, tol) {
  if (typeof expected === 'number') assert.ok(approx(actual, expected, tol), `${name} (got ${actual}, want ${expected})`);
  else assert.equal(actual, expected, name);
}

test('HYROS UI parity: Total row (from the real report screen)', () => {
  const total = derive({
    cost: 4129.58, revenue: 560291.77, reported: 900.00,
    clicks: 3054, impressions: 0, sales: 732, leads: 0, calls: 0,
  });
  check('Profit             = 556,162.19', total.profit, 556162.19);
  check('Reported Vs Rev    = 559,391.77', total.reportedVsRevenue, 559391.77);
  check('ROI                = 13,467.77%', total.roi, 13467.77, 0.02);
  check('ROAS               = 135.68', total.roas, 135.68, 0.005);
});

test('API docs parity: ROAS counts recurring revenue (GET /attribution/roas example)', () => {
  const row = derive({ cost: 2792.40, revenue: 8200, recurringRevenue: 1350, totalRevenue: 9550 });
  check('ROAS = total_revenue / cost = 3.42', row.roas, 3.42, 0.005);
  check('Profit = total_revenue - cost = 6,757.60', row.profit, 6757.60);
  check('ROI = (total_revenue - cost) / cost', row.roi, (9550 - 2792.40) / 2792.40 * 100, 0.01);
  check('tiles close: profit = total - cost and roas = total / cost', approx(row.profit + row.cost, row.roas * row.cost), true);
  const legacy = derive({ cost: 100, revenue: 300 });
  check('ROAS falls back to revenue when totalRevenue is absent', legacy.roas, 3);
  const zeroed = derive({ cost: 100, revenue: 300, totalRevenue: 0 });
  check('ROAS falls back to revenue when totalRevenue is zeroed', zeroed.roas, 3);
  check('the fallback total is written to the row (tile = profit + cost)', legacy.totalRevenue, 300);
  const lower = derive({ cost: 100, revenue: 300, totalRevenue: 250 });
  check('a HYROS total lower than revenue is kept, not overridden', lower.roas, 2.5);
  const mixed = aggregate([derive({ cost: 100, revenue: 300, totalRevenue: 0 }), derive({ cost: 100, revenue: 100, totalRevenue: 500 })]);
  check('rollup of a missing-total child and a full child: total 800, profit 600', mixed.totalRevenue === 800 && mixed.profit === 600, true);
});

test('HYROS UI parity: "meta" row (zero attributed revenue)', () => {
  const meta = derive({ cost: 4129.58, revenue: 0, reported: 0, clicks: 2378, impressions: 0 });
  check('Profit             = -4,129.58', meta.profit, -4129.58);
  check('ROI                = -100.00%', meta.roi, -100);
  check('ROAS               = 0', meta.roas, 0);
});

test('Divide-by-zero safety', () => {
  const zero = derive({ cost: 0, revenue: 0, impressions: 0, clicks: 0, leads: 0, sales: 0 });
  check('ROAS null when cost 0', zero.roas, null);
  check('ROI  null when cost 0', zero.roi, null);
  check('CTR  null when imps 0', zero.ctr, null);
  check('CPL  null when leads 0', zero.cpl, null);
  check('Profit still computes', zero.profit, 0);
});

test('Rollup: derived metrics are RE-derived, never averaged', () => {
  const children = [
    derive({ cost: 100, revenue: 300, impressions: 1000, clicks: 10 }),
    derive({ cost: 300, revenue: 300, impressions: 1000, clicks: 90 }),
  ];
  const parent = aggregate(children);
  check('cost sums            = 400', parent.cost, 400);
  check('revenue sums         = 600', parent.revenue, 600);
  // Averaging the children's ROAS (3.0, 1.0) would give 2.0: the wrong answer.
  check('ROAS re-derived      = 1.5', parent.roas, 1.5);
  check('CTR  re-derived      = 5.00%', parent.ctr, 5);
});

test('LTV fields switched off while HYROS returns 0 for them (HMCP-359)', () => {
  const ltv = CATALOG.filter((c) => /^ltv/.test(c.k));
  check('all 10 LTV fields carry an off reason naming HMCP-359', ltv.length === 10 && ltv.every((c) => /HMCP-359/.test(c.off || '')), true);
  check('no other metric is switched off', CATALOG.filter((c) => c.off).length, 10);
  check('no LTV field is a default column', DEFAULT_KEYS.some((k) => ltv.some((c) => c.k === k)), false);
});

test('Column catalog', () => {
  const keys = CATALOG.map((c) => c.k);
  check('no duplicate keys', new Set(keys).size, keys.length);
  const fields = CATALOG.map((c) => c.f);
  check('no duplicate API fields', new Set(fields).size, fields.length);
  check('every default key exists in catalog', DEFAULT_KEYS.every((k) => keys.includes(k)), true);
  check('additive list matches catalog flags', ADDITIVE.length, CATALOG.filter((c) => c.a === 's').length);

  // Rollups: derived metrics compute, non-aggregatable stay absent
  const children = [
    derive({ cost: 100, revenue: 500, sales: 2, clicks: 40, newVisits: 10 }),
    derive({ cost: 100, revenue: 100, sales: 2, clicks: 10, newVisits: 10 }),
  ];
  const parent = aggregate(children);
  check('AOV re-derived at rollup   = 150', parent.averageOrderValue, 150);
  check('CVR re-derived at rollup   = 8%', parent.cvr, 8);
  check('Cost/New Visit re-derived  = 10', parent.costPerNewVisit, 10);
  check('LTV absent at rollup (non-agg)', parent.ltv90Days === undefined, true);
  check('native value survives derive', derive({ cost: 10, leads: 2, costPerLead: 99 }).costPerLead, 99);
});
