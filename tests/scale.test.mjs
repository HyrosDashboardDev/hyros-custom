import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  curveRequest, curveKey, reportKey, reportAdsets, adsetTargets, defaultSelection,
  readSelection, writeSelection, validEnd, loadCurves, STORE_KEY, view,
} from '../src/views/scale/view.js';
import { normalizeCurve, curveSvg, curveVerdict, isThin, unjudgedReason } from '../src/views/scale/curve.js';
import { fmt } from '../src/ui/fmt.js';
import { esc } from '../src/ui/dom.js';

/** A stand-in for ctx.data: records calls, how many ran at once, and memoises `cached` like data.js. */
function fakeData({ answer = () => ({ curve: [] }), peeked } = {}) {
  const calls = [];
  const memo = new Map();
  let running = 0;
  let maxRunning = 0;
  return {
    calls,
    memo,
    get maxRunning() { return maxRunning; },
    now: () => new Date('2026-09-15T12:00:00Z'),
    account: async () => ({ timezone: '-05:00' }),
    adAccounts: async () => ({ rows: [{ id: '1', name: 'A', type: 'FACEBOOK' }, { id: '2', name: 'B', type: 'GOOGLE' }, { id: '3', name: 'C', type: 'TIKTOK' }], truncated: false }),
    call: async (path, params, opts) => {
      calls.push({ path, params, opts });
      running += 1;
      maxRunning = Math.max(maxRunning, running);
      await new Promise((resolve) => setImmediate(resolve));
      running -= 1;
      return answer(params);
    },
    cached: (key, loader) => {
      if (!memo.has(key)) {
        const p = loader();
        memo.set(key, p);
        p.catch(() => memo.delete(key));
      }
      return memo.get(key);
    },
    peek: (key) => peeked?.(key),
  };
}

/** A curve as the endpoint answers it: inside the `{ request_id, result }` envelope. */
const curve = (n, extra = {}) => ({ request_id: 'r-1', result: bare(n, extra) });
const bare = (n, extra = {}) => ({
  curve: Array.from({ length: n }, (_, i) => ({ spendPerDay: 100 * (i + 1), days: 10, newCustomers: 5 + i, avgCac: 20 + i, marginalCac: i ? 25 + i : null })),
  notes: [],
  ...extra,
});

test('curveRequest is the exact flat query: 90 days, last_click, lowercase level, no ceiling or LTV window', () => {
  const req = curveRequest({ id: 123, level: 'ACCOUNT' }, '2026-09-15');
  assert.deepEqual(req, { id: '123', level: 'account', startDate: '2026-06-18', endDate: '2026-09-15', attributionModel: 'last_click' });
  assert.equal(curveRequest({ id: 's', level: 'SOURCE_LINK' }, '2026-09-15').level, 'source_link');
  assert.equal(curveKey({ id: 'x', level: 'SOURCE_LINK' }, '2026-09-15'), 'scale:x:SOURCE_LINK:2026-09-15');
});

test('reportKey is the Report key for last 30 days, last click, default window, ad set level', () => {
  assert.equal(reportKey(new Date('2026-09-15T03:00:00Z'), '-05:00'), 'report:LAST_CLICK:0:2026-08-16:2026-09-14:adset');
});

test('loadCurves runs in series, one call per target, with the slow timeout clamped by the deadline', async () => {
  const data = fakeData({ answer: () => curve(5) });
  const targets = [{ id: '1', name: 'A', level: 'ACCOUNT' }, { id: '2', name: 'B', level: 'ACCOUNT' }, { id: 's1', name: 'S', level: 'SOURCE_LINK' }];
  const deadline = Date.now() + 20000;
  const seen = [];
  const out = await loadCurves(data, targets, { end: '2026-09-15', deadline, onCurve: (c) => seen.push(c.filter((x) => !x.pending).length) });
  assert.equal(data.maxRunning, 1);
  assert.deepEqual(data.calls.map((c) => [c.path, c.params.id, c.params.level]), [
    ['/attribution/marginal-cac-curve', '1', 'account'], ['/attribution/marginal-cac-curve', '2', 'account'], ['/attribution/marginal-cac-curve', 's1', 'source_link'],
  ]);
  for (const c of data.calls) {
    assert.ok(c.opts.timeoutMs <= 20000 && c.opts.timeoutMs > 15000, `timeout ${c.opts.timeoutMs} is slow and clamped`);
    assert.equal(c.params.attributionModel, 'last_click');
  }
  assert.deepEqual(seen, [1, 2, 3]);
  assert.equal(out.curves.length, 3);
  assert.equal(out.curves[0].points.length, 5);

  // Far deadline: the full slow lane.
  const roomy = fakeData({ answer: () => curve(5) });
  await loadCurves(roomy, targets.slice(0, 1), { end: '2026-09-15', deadline: Date.now() + 100000 });
  assert.equal(roomy.calls[0].opts.timeoutMs, 45000);
});

test('loadCurves: one failing target stays on its own card, the rest load', async () => {
  const data = fakeData({ answer: (req) => { if (req.id === '2') throw new Error('HTTP 404'); return curve(4); } });
  const targets = [{ id: '1', level: 'ACCOUNT' }, { id: '2', level: 'ACCOUNT' }, { id: '3', level: 'ACCOUNT' }];
  const { curves } = await loadCurves(data, targets, { end: '2026-09-15', deadline: Date.now() + 60000 });
  assert.equal(curves[1].error, 'HTTP 404');
  assert.equal(curves[0].points.length, 4);
  assert.equal(curves[2].points.length, 4);
  assert.equal(data.memo.has('scale:2:ACCOUNT:2026-09-15'), false, 'a failed curve is not memoised');
  assert.equal(data.memo.has('scale:1:ACCOUNT:2026-09-15'), true);
});

test('loadCurves: past the deadline no call starts and the targets read skipped; a newer render stops the loop', async () => {
  const late = fakeData();
  const out = await loadCurves(late, [{ id: '1', level: 'ACCOUNT' }, { id: '2', level: 'ACCOUNT' }], { end: '2026-09-15', deadline: Date.now() - 1 });
  assert.equal(late.calls.length, 0);
  assert.deepEqual(out.curves.map((c) => c.skipped), ['time budget', 'time budget']);

  let current = true;
  const data = fakeData({ answer: () => { current = false; return curve(3); } });
  const stopped = await loadCurves(data, [{ id: '1', level: 'ACCOUNT' }, { id: '2', level: 'ACCOUNT' }], { end: '2026-09-15', deadline: Date.now() + 60000, isCurrent: () => current });
  assert.equal(data.calls.length, 1);
  assert.equal(stopped.stopped, true);
});

test('loadCurves reuses a memoised curve instead of calling again', async () => {
  const data = fakeData({ answer: () => curve(4) });
  const t = [{ id: '1', level: 'ACCOUNT' }];
  await loadCurves(data, t, { end: '2026-09-15', deadline: Date.now() + 60000 });
  await loadCurves(data, t, { end: '2026-09-15', deadline: Date.now() + 60000 });
  assert.equal(data.calls.length, 1);
});

test('normalizeCurve reads the documented reply and a { result } envelope', () => {
  const raw = { result: { name: 'Main', daysSampled: 80, cacCeiling: 50, ceilingBasis: 'LTV_BREAKEVEN', ltvWindow: 'NINETY_DAYS',
    curve: [{ spendPerDay: 200, newCustomers: 4, avgCac: 50 }, { spendPerDay: 100, newCustomers: 3, avgCac: 33 }],
    saturationPoint: { efficientSpendPerDay: 100, saturatedSpendPerDay: 200, reason: 'MARGINAL_CAC_ABOVE_CEILING' }, notes: ['LTV_CEILING_UNAVAILABLE'] } };
  const c = normalizeCurve(raw, { id: '9', level: 'SOURCE_LINK' });
  assert.deepEqual(c.points.map((p) => p.spend), [100, 200]);
  assert.equal(c.saturationSpend, 200);
  assert.equal(c.efficientSpend, 100);
  assert.equal(c.ceiling, 50);
  assert.equal(c.name, 'Main');
  assert.deepEqual(c.notes, ['LTV_CEILING_UNAVAILABLE']);
});

test('a thin curve warns even without notes; a healthy one does not', () => {
  assert.equal(isThin(normalizeCurve(curve(3), {})), true, '3 spend levels');
  const zero = curve(6); zero.result.curve[0].newCustomers = 0;
  assert.equal(isThin(normalizeCurve(zero, {})), true, 'a level with no customers');
  assert.equal(isThin(normalizeCurve(curve(6, { notes: ['INSUFFICIENT_DATA'] }), {})), true);
  assert.equal(isThin(normalizeCurve(curve(6), {})), false);
  assert.equal(isThin(normalizeCurve({ curve: [] }, {})), false, 'no points is "not enough data", not thin');
});

test('curveVerdict: fewer than 2 points, notes, error, skipped', () => {
  assert.equal(curveVerdict(normalizeCurve(curve(1), {}), fmt).text, 'Not enough data yet');
  assert.equal(curveVerdict(normalizeCurve({ curve: [], notes: ['NO_SPEND_DATA'] }, {}), fmt).text, 'No spend history in the window');
  assert.equal(curveVerdict({ error: 'x' }, fmt).cls, 'bad');
  assert.equal(curveVerdict({ skipped: 'time budget' }, fmt).text, 'Skipped: time budget');
  assert.match(curveVerdict(normalizeCurve(curve(4, { cacCeiling: 50 }), {}), fmt).text, /^Still efficient/);
});

test('curveVerdict: no saturation point is "Not judged" when HYROS could not judge it', () => {
  const v = (extra, meta = {}) => curveVerdict(normalizeCurve(curve(4, extra), meta), fmt);
  assert.deepEqual(v({ cacCeiling: 50, notes: ['NO_CUSTOMERS'] }), { cls: '', text: 'Not judged: no customers in the window' });
  assert.deepEqual(v({ cacCeiling: 50, notes: ['INSUFFICIENT_DATA'] }), { cls: '', text: 'Not judged: too little data' });
  assert.deepEqual(v({ notes: ['LTV_CEILING_UNAVAILABLE'] }, { level: 'ACCOUNT' }), { cls: '', text: 'Not judged: no CAC ceiling at this level' });
  assert.deepEqual(v({}, { level: 'SOURCE_LINK' }), { cls: '', text: 'Not judged: no CAC ceiling' });
  // Spend that buys no extra customers is found without a ceiling: that is a real verdict.
  assert.match(v({ saturationPoint: { efficientSpendPerDay: 200, saturatedSpendPerDay: 300, reason: 'NO_INCREMENTAL_CUSTOMERS' } }, { level: 'ACCOUNT' }).text, /^Past saturation/);
});

test('unjudgedReason is null for a saturated curve and for a judged one', () => {
  assert.equal(unjudgedReason(normalizeCurve(curve(4, { saturationPoint: { saturatedSpendPerDay: 300 } }), { level: 'ACCOUNT' })), null);
  assert.equal(unjudgedReason(normalizeCurve(curve(4, { cacCeiling: 50 }), {})), null);
});

test('curveSvg has no color in its markup: classes only', () => {
  const svg = curveSvg(normalizeCurve(curve(5, { cacCeiling: 30, saturationPoint: { saturatedSpendPerDay: 300 } }), {}), fmt);
  assert.match(svg, /class="scale-avg"/);
  assert.match(svg, /class="scale-ceil"/);
  assert.match(svg, /class="scale-sat"/);
  assert.doesNotMatch(svg, /stroke=|fill=|style=|#[0-9a-f]{3,6}\b/i);
});

test('adsetTargets: top 6 by cost with spend, as SOURCE_LINK, account name joined', () => {
  const rows = Array.from({ length: 9 }, (_, i) => ({ id: `s${i}`, name: `S${i}`, cost: i, _account: '1' }));
  const t = adsetTargets(rows, new Map([['1', 'A']]));
  assert.deepEqual(t.map((x) => x.id), ['s8', 's7', 's6', 's5', 's4', 's3']);
  assert.ok(t.every((x) => x.level === 'SOURCE_LINK' && x.account === 'A'));
  assert.equal(adsetTargets([{ id: 'z', cost: 0 }]).length, 0);
});

test('reportAdsets: absent, still loading, failed and ready', async () => {
  assert.equal((await reportAdsets(fakeData(), 'k')).status, 'absent');
  assert.equal((await reportAdsets(fakeData({ peeked: () => new Promise(() => {}) }), 'k')).status, 'loading');
  const failing = Promise.reject(new Error('x')); failing.catch(() => {});
  assert.equal((await reportAdsets(fakeData({ peeked: () => failing }), 'k')).status, 'failed');
  const ready = await reportAdsets(fakeData({ peeked: (k) => (k === 'k' ? Promise.resolve({ adsetRows: [{ id: 'a', cost: 1 }] }) : undefined) }), 'k');
  assert.equal(ready.status, 'ready');
  assert.equal(ready.rows.length, 1);
});

test('defaultSelection: the 2 accounts with most 30-day cost, else the first 2', () => {
  const accounts = [{ id: '1' }, { id: '2' }, { id: '3' }];
  assert.deepEqual(defaultSelection(accounts, [{ _account: '3', cost: 50 }, { _account: '2', cost: 10 }, { _account: '3', cost: 1 }]), ['3', '2']);
  assert.deepEqual(defaultSelection(accounts, []), ['1', '2']);
});

test('the selection is persisted inside try: a throwing storage never throws', () => {
  const box = new Map();
  const storage = { getItem: (k) => box.get(k) ?? null, setItem: (k, v) => box.set(k, v) };
  assert.equal(writeSelection(storage, ['2', '9']), true);
  assert.equal(box.get(STORE_KEY), '["2","9"]');
  assert.deepEqual(readSelection(storage, new Set(['1', '2'])), ['2'], 'ids that no longer exist are dropped');
  const blocked = { getItem: () => { throw new Error('SecurityError'); }, setItem: () => { throw new Error('SecurityError'); } };
  assert.equal(readSelection(blocked, new Set(['1'])), null);
  assert.equal(writeSelection(blocked, ['1']), false);
  assert.equal(writeSelection(null, ['1']), false);
  assert.equal(readSelection({ getItem: () => 'not json' }, new Set()), null);
});

test('validEnd refuses the future and malformed dates', () => {
  assert.equal(validEnd('2026-09-15', '2026-09-15'), null);
  assert.ok(validEnd('2026-09-16', '2026-09-15'));
  assert.ok(validEnd('2026-02-30', '2026-09-15'));
  assert.ok(validEnd('', '2026-09-15'));
});

test('render: account curves first, escaped names, ad sets wait for the Report', async () => {
  const data = fakeData({ answer: () => curve(4) });
  data.adAccounts = async () => ({ rows: [{ id: '1', name: '<b>A</b>', type: 'FACEBOOK' }, { id: '2', name: 'B', type: 'GOOGLE' }], truncated: false });
  const root = { innerHTML: '', querySelectorAll: () => [], querySelector: () => null, insertAdjacentHTML() {} };
  const ctx = { root, data, fmt, esc, kpis: (items) => items.map((i) => i.value).join('|') };
  await view.render(ctx);
  // Let the background loop finish the second curve.
  for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(data.calls.map((c) => c.params.level), ['account', 'account']);
  assert.match(root.innerHTML, /&lt;b&gt;A&lt;\/b&gt;/);
  assert.doesNotMatch(root.innerHTML, /<b>A<\/b>/);
  assert.match(root.innerHTML, /Open Report, last 30 days, Last click, to rank ad sets/);
});

test('render: Room to scale counts only judged curves, the rest go to Not judged', async () => {
  // The first 2 ad accounts are selected by default: one without a ceiling (as every account curve), one with.
  const replies = { 1: bare(5, { notes: ['LTV_CEILING_UNAVAILABLE'] }), 2: bare(5, { cacCeiling: 80 }) };
  const data = fakeData({ answer: (p) => ({ request_id: 'r', result: replies[p.id] }) });
  const root = { innerHTML: '', querySelectorAll: () => [], querySelector: () => null, insertAdjacentHTML() {} };
  const ctx = { root, data, fmt, esc, kpis: (items) => items.map((i) => `${i.label}=${i.value}`).join('|') };
  await view.render(ctx);
  for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.match(root.innerHTML, /Saturation found=0\|Room to scale=1\|Not judged=1/);
  assert.equal((root.innerHTML.match(/Still efficient/g) || []).length, 1);
  assert.match(root.innerHTML, /Not judged: no CAC ceiling at this level/);
});
