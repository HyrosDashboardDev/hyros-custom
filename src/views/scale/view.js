/**
 * Scale: marginal CAC curves per ad account (and per top ad set when the
 * Report already ranked them). The contract is in SPEC.md next to this file.
 *
 * ctx = { root, data, fmt, esc, kpis, now }
 */
import { ymdInTz, addDays } from '../../core/dates.js';
import { TIMEOUTS, VIEW_LOAD_MS, clampTimeout } from '../../core/budget.js';
import { buildRanges } from '../../data/report-levels.js';
import { normalizeCurve, curveSvg, curveVerdict, isThin, unjudgedReason, NOTE_WORD } from './curve.js';

export const TOP_ADSETS = 6;
export const DEFAULT_ACCOUNTS = 2;
export const STORE_KEY = 'hyros-custom.scale.accounts';
/** The `attributionModel` of every curve: last click, the cost of closing a customer. */
export const CURVE_MODEL = 'last_click';
const DEADLINE_MARGIN_MS = 15000;

const LEVEL_WORD = { ACCOUNT: 'Ad account', CAMPAIGN: 'Campaign', SOURCE_LINK: 'Ad set', AD: 'Ad' };
const BASIS_WORD = { CALLER_PROVIDED: 'caller provided', LTV_BREAKEVEN: 'LTV breakeven' };
const words = (s) => String(s || '').toLowerCase().replace(/_/g, ' ');

/** Bumped on every render: a loop of calls stops when a newer render started (control change, tab switch, Refresh). */
let renderSeq = 0;
/** What the user picked, kept across renders of this page. */
const state = { end: null, selected: null, endError: null };

/* ---------------- requests ---------------- */

/**
 * The GET /attribution/marginal-cac-curve query of one curve: 90 days ending on
 * `end` (ACCOUNT level caps history at 90 days). The endpoint answers 400 to
 * any other or repeated parameter, so nothing else is sent. `level` goes in the
 * API's lowercase spelling; the target keeps its uppercase one for the cards.
 */
export function curveRequest(target, end) {
  return { id: String(target.id), level: String(target.level).toLowerCase(), startDate: addDays(end, -89), endDate: end, attributionModel: CURVE_MODEL };
}

export const curveKey = (target, end) => `scale:${target.id}:${target.level}:${end}`;

/** The key the Report caches its 30-day, last-click, default-window ad set load under. */
export function reportKey(now, tz) {
  const r = buildRanges(now, tz)['30d'];
  return `report:LAST_CLICK:0:${r.start}:${r.end}:adset`;
}

/**
 * The Report's ad set rows, only when that load already finished in this page.
 * `peek` never loads; a promise still pending reads as `loading` instead of
 * being awaited (it could take the Report's whole budget).
 */
export async function reportAdsets(data, key) {
  const promise = typeof data.peek === 'function' ? data.peek(key) : undefined;
  if (!promise) return { status: 'absent', rows: [] };
  const pending = {};
  let out;
  try {
    out = await Promise.race([Promise.resolve(promise), new Promise((resolve) => setTimeout(() => resolve(pending), 0))]);
  } catch {
    return { status: 'failed', rows: [] };
  }
  if (out === pending) return { status: 'loading', rows: [] };
  return { status: 'ready', rows: Array.isArray(out?.adsetRows) ? out.adsetRows : [] };
}

/** The top ad sets by cost (spend only), as SOURCE_LINK targets. */
export function adsetTargets(rows, accountName = new Map(), top = TOP_ADSETS) {
  return (rows || [])
    .filter((r) => r && r.id && Number(r.cost) > 0)
    .sort((a, b) => (Number(b.cost) || 0) - (Number(a.cost) || 0))
    .slice(0, top)
    .map((r) => ({ id: String(r.id), name: r.name || null, level: 'SOURCE_LINK', account: accountName.get(String(r._account)) || null, cost: Number(r.cost) }));
}

/** The first ad accounts by 30-day cost when the Report's rows are there, else the first listed. */
export function defaultSelection(accounts, adsetRows = [], n = DEFAULT_ACCOUNTS) {
  const spend = new Map();
  for (const r of adsetRows || []) {
    if (r?._account == null) continue;
    const id = String(r._account);
    spend.set(id, (spend.get(id) || 0) + (Number(r.cost) || 0));
  }
  const ranked = accounts.filter((a) => (spend.get(String(a.id)) || 0) > 0)
    .sort((a, b) => spend.get(String(b.id)) - spend.get(String(a.id)));
  return (ranked.length ? ranked : accounts).slice(0, n).map((a) => String(a.id));
}

/* ---------------- the remembered selection ---------------- */

/** The page's localStorage, or null where the frame blocks it. */
function browserStorage() {
  try { return globalThis.localStorage ?? null; } catch { return null; }
}

/** The saved selection, filtered to the ad accounts that still exist; null when there is none (or storage throws). */
export function readSelection(storage, validIds) {
  try {
    const list = JSON.parse(storage?.getItem(STORE_KEY) || 'null');
    if (!Array.isArray(list)) return null;
    const ids = list.map(String).filter((id) => validIds.has(id));
    return ids.length ? ids : null;
  } catch {
    return null;
  }
}

/** Save the selection; false when storage is missing or throws (partitioned frame, Safari). */
export function writeSelection(storage, ids) {
  try {
    if (!storage) return false;
    storage.setItem(STORE_KEY, JSON.stringify(ids));
    return true;
  } catch {
    return false;
  }
}

/** A typed end date is a real YYYY-MM-DD no later than today in the account zone. */
export function validEnd(value, today) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return 'Pick a date.';
  if (Number.isNaN(new Date(`${value}T00:00:00Z`).getTime()) || addDays(value, 0) !== value) return 'Pick a real date.';
  if (value > today) return 'The end date cannot be in the future.';
  return null;
}

/* ---------------- the load ---------------- */

/**
 * One curve per target, in series. A failure stays on its own curve; the
 * deadline marks the targets not started as skipped; a newer render stops the loop.
 * `onCurve(curves)` runs after each target settles.
 */
export async function loadCurves(data, targets, { end, deadline, isCurrent = () => true, onCurve = () => {} }) {
  const curves = targets.map((t) => ({ ...t, points: [], notes: [], pending: true }));
  for (let i = 0; i < targets.length; i += 1) {
    const t = targets[i];
    if (!isCurrent()) return { curves, stopped: true };
    if (Date.now() >= deadline) {
      curves[i] = { ...t, points: [], notes: [], skipped: 'time budget' };
      onCurve(curves);
      continue;
    }
    try {
      const raw = await data.cached(curveKey(t, end), () => data.call('/attribution/marginal-cac-curve',
        curveRequest(t, end),
        { timeoutMs: clampTimeout(TIMEOUTS.slow, deadline) }));
      curves[i] = normalizeCurve(raw, t);
    } catch (err) {
      curves[i] = { ...t, points: [], notes: [], error: err?.message || 'HYROS did not answer.' };
    }
    if (!isCurrent()) return { curves, stopped: true };
    onCurve(curves);
  }
  return { curves, stopped: false };
}

/* ---------------- cards ---------------- */

/** One card for the "HYROS did not answer" case (every curve failed). */
function unavailableCard(curves, esc) {
  const messages = [...new Set(curves.map((c) => String(c.error || '').trim()).filter(Boolean))];
  return `<div class="fpanel scale-card"><h3>Curves unavailable</h3>
    <div class="note err"><b>HYROS did not answer the marginal CAC curve</b> (${esc(messages[0] || 'no reply')}).
      Ask HYROS support whether the marginal CAC curve is enabled for this account.
      ${messages.length > 1 ? `<br><span class="sub">Other replies: ${esc(messages.slice(1).join(' · '))}</span>` : ''}</div>
    <div class="sub">${esc(String(curves.length))} entities were requested (<code>GET /attribution/marginal-cac-curve</code>); every call failed.</div>
  </div>`;
}

function curveCard(c, fmt, esc) {
  const v = curveVerdict(c, fmt);
  const points = c.points || [];
  const last = points[points.length - 1];
  const basis = BASIS_WORD[c.ceilingBasis] || words(c.ceilingBasis);
  const ceilingSub = [basis, c.ltvWindow ? words(c.ltvWindow) : ''].filter(Boolean).join(' · ') || '-';
  const sat = c.saturationSpend ?? null;
  const thin = isThin(c);
  const notes = (c.notes || []).map((n) => NOTE_WORD[n] || words(n));
  const meta = [c.account, c.daysSampled ? `${fmt.int(c.daysSampled)} days sampled` : ''].filter(Boolean).join(' · ');
  let body;
  if (c.error) body = `<div class="note err">${esc(c.error)}</div>`;
  else if (c.pending) body = '<div class="sub">Loading curve, it can take up to 45 s.</div>';
  else if (points.length >= 2) {
    body = `<div class="scale-body">
      <div>${curveSvg(c, fmt)}</div>
      <div class="scale-stats">
        <div class="scale-stat"><div class="kpi-label">CAC ceiling</div><b>${c.ceiling !== null && c.ceiling !== undefined ? fmt.money(c.ceiling) : '-'}</b>
          <div class="sub">${esc(ceilingSub)}</div></div>
        <div class="scale-stat"><div class="kpi-label">Saturation spend</div><b>${sat !== null ? `${fmt.money(sat)}/day` : '-'}</b>
          ${c.efficientSpend !== null && c.efficientSpend !== undefined ? `<div class="sub">efficient up to ${fmt.money(c.efficientSpend)}/day</div>` : ''}
          ${c.saturationReason ? `<div class="sub">${esc(words(c.saturationReason))}</div>` : ''}</div>
        <div class="scale-stat"><div class="kpi-label">Marginal CAC at top of range</div><b>${last?.marginalCac !== null && last?.marginalCac !== undefined ? fmt.money(last.marginalCac) : '-'}</b>
          <div class="sub">at ${fmt.money(last?.spend)}/day</div></div>
      </div>
    </div>${notes.length ? `<div class="sub scale-notes">${esc(notes.join(' · '))}</div>` : ''}`;
  } else {
    body = `<div class="sub">${esc(c.skipped ? `skipped: ${c.skipped}` : notes.join(', ') || 'Not enough data yet.')}</div>`;
  }
  return `<div class="fpanel scale-card">
    <div class="scale-head">
      <span class="pill">${esc(LEVEL_WORD[c.level] || c.level)}</span>
      <b>${esc(c.name || c.id)}</b>
      <span class="sub">${esc(meta)}</span>
      ${thin ? '<span class="pill warn" title="3 spend levels or fewer, or a level with no customers: too thin to act on">thin curve</span>' : ''}
      <span class="scale-verdict ${v.cls}">${esc(v.text)}</span>
    </div>
    ${body}
  </div>`;
}

const REPORT_LINE = {
  absent: 'Open Report, last 30 days, Last click, to rank ad sets.',
  failed: 'Open Report, last 30 days, Last click, to rank ad sets.',
  loading: 'The Report is still loading its last 30 days. Come back to Scale once it finishes to rank ad sets.',
};

/* ---------------- render ---------------- */

function html(ctx, { accounts, end, today, curves, report }) {
  const { fmt, esc, kpis } = ctx;
  const selected = new Set(state.selected);
  const done = curves.filter((c) => !c.pending);
  const analyzed = done.filter((c) => !c.skipped);
  const withData = analyzed.filter((c) => (c.points || []).length >= 2);
  const saturated = withData.filter((c) => c.saturationSpend !== null && c.saturationSpend !== undefined);
  const unjudged = withData.filter((c) => unjudgedReason(c));
  const skipped = done.length - analyzed.length;
  const loading = curves.length - done.length;
  const allFailed = curves.length > 0 && curves.every((c) => c.error);

  const chips = accounts.map((a) => `<button type="button" class="chip${selected.has(a.id) ? ' active' : ''}" data-scale-acct="${esc(a.id)}" title="${esc(`${a.type || ''} ${a.id}`.trim())}">${esc(a.name || a.id)}</button>`).join('');
  const controls = `<div class="controls">
      <div class="chipset scale-accounts" role="group" aria-label="Ad accounts">${chips}</div>
      <label class="scale-end"><span class="kpi-label">End date</span><input type="date" data-scale-end value="${esc(end)}" max="${esc(today)}"></label>
    </div>${state.endError ? `<div class="note err">${esc(state.endError)}</div>` : ''}`;

  const accountCurves = curves.filter((c) => c.level === 'ACCOUNT');
  const adsetCurves = curves.filter((c) => c.level === 'SOURCE_LINK');
  const tiles = allFailed || !curves.length ? '' : kpis([
    { label: 'Entities analyzed', value: fmt.int(analyzed.length), sub: [loading ? `${fmt.int(loading)} loading` : '', skipped ? `${fmt.int(skipped)} skipped (time budget)` : ''].filter(Boolean).join(', ') || 'ad accounts + top ad sets by spend' },
    { label: 'With spend history', value: fmt.int(withData.length) },
    { label: 'Saturation found', value: fmt.int(saturated.length), sub: 'a budget ceiling exists' },
    { label: 'Room to scale', value: fmt.int(withData.length - saturated.length - unjudged.length), cls: 'good', sub: 'below the CAC ceiling in range' },
    { label: 'Not judged', value: fmt.int(unjudged.length), sub: 'no customers, too little data or no CAC ceiling' },
  ]);

  const accountBlock = allFailed ? unavailableCard(curves, esc)
    : accountCurves.length ? accountCurves.map((c) => curveCard(c, fmt, esc)).join('')
      : '<div class="empty">Pick at least one ad account.</div>';
  let adsetBlock;
  if (allFailed) adsetBlock = '';
  else if (report.status !== 'ready') adsetBlock = `<div class="note">${esc(REPORT_LINE[report.status])}</div>`;
  else if (!adsetCurves.length) adsetBlock = '<div class="empty">No ad set spend in the Report\'s last 30 days.</div>';
  else adsetBlock = adsetCurves.map((c) => curveCard(c, fmt, esc)).join('');

  return `
    <div class="note"><b>Scale.</b> How the cost of the <i>next</i> customer changes as daily spend rises,
      computed by HYROS from this account's own spend history (<code>GET /attribution/marginal-cac-curve</code>,
      last-click credit: the cost of closing a customer). The saturation point is where the next unit of
      spend costs more than the CAC ceiling. Window ${esc(addDays(end, -89))} to ${esc(end)}.</div>
    ${controls}
    ${tiles}
    <h2 class="section">Ad accounts <span class="rowcount">${fmt.int(accountCurves.length)} of ${fmt.int(accounts.length)}</span></h2>
    ${accountBlock}
    ${allFailed ? '' : `<h2 class="section">Ad sets <span class="rowcount">top ${fmt.int(TOP_ADSETS)} by 30-day cost</span></h2>${adsetBlock}`}`;
}

function wire(ctx) {
  const rerender = () => view.render(ctx).catch((err) => {
    ctx.root.insertAdjacentHTML('afterbegin', `<div class="note err">${ctx.esc(err?.message || 'Scale could not load.')}</div>`);
  });
  for (const chip of ctx.root.querySelectorAll('[data-scale-acct]')) {
    chip.addEventListener('click', () => {
      const id = chip.dataset.scaleAcct;
      const set = new Set(state.selected);
      if (set.has(id)) set.delete(id); else set.add(id);
      state.selected = [...set];
      writeSelection(browserStorage(), state.selected);
      rerender();
    });
  }
  const input = ctx.root.querySelector('[data-scale-end]');
  input?.addEventListener('change', () => {
    const today = input.max;
    const problem = validEnd(input.value, today);
    state.endError = problem;
    if (!problem) state.end = input.value;
    rerender();
  });
}

export const view = {
  id: 'scale',
  title: 'Scale',
  version: '0.1.1',
  description: 'How far each ad account (and the top ad sets) can scale daily spend before the next customer costs more than the CAC ceiling.',
  style: true,
  tools: ['/user-info', '/leads', '/ad-accounts', '/attribution/marginal-cac-curve'],
  author: 'HYROS',

  async render(ctx) {
    const seq = ++renderSeq;
    const isCurrent = () => seq === renderSeq;
    const deadline = Date.now() + VIEW_LOAD_MS - DEADLINE_MARGIN_MS;
    const { root, data, esc } = ctx;

    const account = await data.account();
    const adAccounts = await data.adAccounts();
    if (!isCurrent()) return;
    const tz = account?.timezone;
    const now = data.now();
    const today = ymdInTz(now, tz);
    if (!state.end || state.end > today) state.end = today;
    const end = state.end;

    const accounts = adAccounts.rows.map((a) => ({ ...a, id: String(a.id) }));
    if (!accounts.length) {
      root.innerHTML = '<div class="empty">No ad accounts connected, so there is nothing to scale.</div>';
      return;
    }

    const report = await reportAdsets(data, reportKey(now, tz));
    const validIds = new Set(accounts.map((a) => a.id));
    if (!state.selected) state.selected = readSelection(browserStorage(), validIds) || defaultSelection(accounts, report.rows);
    state.selected = state.selected.filter((id) => validIds.has(id));
    const selected = new Set(state.selected);
    const accountName = new Map(accounts.map((a) => [a.id, a.name]));

    const targets = [
      ...accounts.filter((a) => selected.has(a.id)).map((a) => ({ id: a.id, name: a.name, level: 'ACCOUNT' })),
      ...(report.status === 'ready' ? adsetTargets(report.rows, accountName) : []),
    ];

    const paint = (curves) => {
      if (!isCurrent()) return;
      root.innerHTML = html(ctx, { accounts, end, today, curves, report });
      wire(ctx);
    };
    paint(targets.map((t) => ({ ...t, points: [], notes: [], pending: true })));
    if (!targets.length) return;

    // Resolve once the first curve is in; the rest fill in while the user reads.
    let firstIn;
    const first = new Promise((resolve) => { firstIn = resolve; });
    loadCurves(data, targets, { end, deadline, isCurrent, onCurve: (curves) => { paint(curves); firstIn(); } })
      .catch((err) => {
        if (isCurrent()) root.insertAdjacentHTML('afterbegin', `<div class="note err">${esc(err?.message || 'The curves could not load.')}</div>`);
      })
      .finally(() => firstIn());
    await first;
  },
};
