/**
 * The Performance Report's loads: ranges, the attribution calls per ad
 * account, the source join by id, and the cache keys the Scale tab reads.
 * No DOM, so tests/report.test.mjs runs it in node with a fake ctx.data.
 * Behavior ported from hyros-ai api/_snapshot.js (fetchLevel and the
 * per-account loop), rewritten on ctx.data.
 */
import { REPORT_FIELDS, LEVELS_BY_TYPE, normalizeRow, buildRanges } from '../../data/report-levels.js';
import { TIMEOUTS, VIEW_LOAD_MS, clampTimeout } from '../../core/budget.js';
import { dayStart, dayEnd, ymdInTz } from '../../core/dates.js';

/** 8 pages of 250, newest first: at most 2,000 rows per ad account and level. */
export const MAX_PAGES = 8;
export const PAGE_SIZE = 250;
/** `adSourceIds` takes at most 50 ids. */
export const JOIN_BATCH = 50;
/** A render stops starting calls this long before the shell's limit, so it can still paint. */
export const DEADLINE_MARGIN_MS = 15000;
export const MAX_WINDOW = 365;

export const MODELS = [
  { key: 'LAST_CLICK', label: 'Last click' },
  { key: 'FIRST_CLICK', label: 'First click' },
  { key: 'SCIENTIFIC', label: 'Scientific' },
];

export const renderDeadline = (start) => start + VIEW_LOAD_MS - DEADLINE_MARGIN_MS;

const authError = (err) => err?.code === 'SIGN_IN' || err?.code === 'auth' || err?.code === 'NO_TOKEN';

/* ---------------- keys ---------------- */

/** The window actually sent: LAST_CLICK only, 1..365; anything else is 0 (not sent, the account default). */
export function sentWindow(model, window) {
  const w = Math.trunc(Number(window));
  return model === 'LAST_CLICK' && Number.isFinite(w) && w > 0 && w <= MAX_WINDOW ? w : 0;
}

/** `report:<model>:<window>:<start>:<end>:<adset|ad>`: the whole load, every supported ad account. Scale reads the adset one. */
export function cacheKey({ model, window, start, end, kind }) {
  return `report:${model}:${sentWindow(model, window)}:${start}:${end}:${kind}`;
}

/** One ad account's load under a whole-load key. */
export const accountKey = (base, adAccountId) => `${base}:acct:${adAccountId}`;

/* ---------------- ranges ---------------- */

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;
const validYmd = (s) => YMD_RE.test(s || '') && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;

/** Why a custom range cannot load, or null. `today` is YYYY-MM-DD in the account zone. */
export function validateCustom(start, end, today) {
  if (!validYmd(start) || !validYmd(end)) return 'Pick a start and an end date.';
  if (end > today) return `The end date cannot be after today (${today} in the account timezone).`;
  if (start > end) return 'The start date must be on or before the end date.';
  return null;
}

/** `{ key, label, start, end }`, or `{ key, error }` for an invalid custom range. */
export function resolveRange(choice, custom, now, tz) {
  if (choice === 'custom') {
    const error = validateCustom(custom?.start, custom?.end, ymdInTz(now, tz));
    if (error) return { key: 'custom', error };
    return { key: 'custom', label: 'Custom', start: custom.start, end: custom.end };
  }
  const ranges = buildRanges(now, tz);
  const key = ranges[choice] ? choice : '30d';
  return { key, ...ranges[key] };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dayLabel = (ymd) => `${MONTHS[Number(ymd.slice(5, 7)) - 1]} ${Number(ymd.slice(8, 10))}, ${ymd.slice(0, 4)}`;

/** "Sep 1, 2026 to Sep 30, 2026", or one day. */
export function rangeLabel({ start, end }) {
  return start === end ? dayLabel(start) : `${dayLabel(start)} to ${dayLabel(end)}`;
}

/* ---------------- ad accounts ---------------- */

/**
 * Ad accounts by what the report can do with them: `adset` (every type with a
 * level), `ad` (types with an ad level), `unsupported` (no level at all) and
 * `noAdLevel` (an ad-set level but no ad level).
 */
export function partitionAccounts(rows = []) {
  const out = { adset: [], ad: [], unsupported: [], noAdLevel: [] };
  for (const a of rows) {
    const levels = LEVELS_BY_TYPE[a.type];
    if (!levels) { out.unsupported.push(a); continue; }
    out.adset.push(a);
    if (levels.ad) out.ad.push(a);
    else out.noAdLevel.push(a);
  }
  return out;
}

/* ---------------- calls ---------------- */

/** The attribution report request for one ad account and level. */
export function reportRequest({ model, window, start, end, tz, now, level, adAccountId }) {
  const w = sentWindow(model, window);
  return {
    attributionModel: model,
    startDate: dayStart(start, tz),
    // Today ends now: the report rejects a bound in the future.
    endDate: dayEnd(end, tz, now),
    level,
    ids: [String(adAccountId)],
    isAdAccountId: true,
    timeGroupingOption: 'SOURCE_LINK',
    newestFirst: true,
    sourceConfiguration: 'ALL_SOURCES',
    reportSourceVisibility: true,
    fields: REPORT_FIELDS,
    ...(w ? { windowAttributionDaysRange: w } : {}),
  };
}

/** A load cut short (time budget, expired cursor): never cached, its rows still shown. */
export class PartialLoad extends Error {
  constructor(rows, reason) {
    super(reason);
    this.name = 'PartialLoad';
    this.rows = rows;
    this.reason = reason;
  }
}

/**
 * One call at a time across renders: a new render's first call waits for the
 * older render's call in flight, so the same report is never asked twice at
 * once ("Already processing") and the account's rate limit sees one caller.
 */
export function createSerial() {
  let last = Promise.resolve();
  return {
    run(fn) {
      const next = last.catch(() => {}).then(fn);
      last = next;
      return next;
    },
  };
}

/** One ad account at one level. Rows are normalised and stamped with the account of the call. */
export async function fetchAccount(data, { account, kind, model, window, range, tz, now, deadline }) {
  const level = LEVELS_BY_TYPE[account.type]?.[kind];
  const request = reportRequest({ model, window, start: range.start, end: range.end, tz, now, level, adAccountId: account.id });
  const page = await data.pagedInfo('hyros_get_attribution_report', { request }, {
    maxPages: MAX_PAGES, pageSize: PAGE_SIZE, deadline, timeoutMs: clampTimeout(TIMEOUTS.default, deadline),
  });
  const rows = (page.rows || []).map((raw) => ({ ...normalizeRow(raw), _account: String(account.id) }));
  if (page.error) throw new PartialLoad(rows, page.error);
  return { rows, capped: Boolean(page.truncated) };
}

/** Promises this module saw resolve: a whole load is stored only over settled, successful account loads. */
const settled = new WeakSet();

/**
 * The selected ad accounts of one level, in sequence. Each account is its own
 * cache entry, so a later render only calls what is missing.
 * Returns { rows, loaded, capped, failed, cut, skipped, stale }.
 */
export async function loadAccounts(data, {
  accounts, kind, model, window, range, tz, now, deadline, isCurrent = () => true, serial = createSerial(), clock = Date.now,
}) {
  const base = cacheKey({ model, window, start: range.start, end: range.end, kind });
  const out = { rows: [], loaded: [], capped: [], failed: [], cut: [], skipped: [], stale: false };
  for (const account of accounts) {
    if (!isCurrent()) { out.stale = true; return out; }
    const key = accountKey(base, account.id);
    let promise = data.peek(key);
    if (!promise) {
      if (clock() >= deadline) { out.skipped.push(account); continue; }
      promise = data.cached(key, () => serial.run(() => fetchAccount(data, { account, kind, model, window, range, tz, now, deadline })));
    }
    try {
      const got = await promise;
      settled.add(promise);
      out.rows.push(...got.rows);
      out.loaded.push(account);
      if (got.capped) out.capped.push({ account, count: got.rows.length });
    } catch (err) {
      if (authError(err)) throw err;
      if (err instanceof PartialLoad) {
        out.rows.push(...err.rows);
        if (err.rows.length) out.cut.push({ account, count: err.rows.length, reason: err.reason });
        else out.skipped.push(account);
      } else if (err?.code === 'timeout' && clock() >= deadline - 1000) {
        out.skipped.push(account);
      } else {
        out.failed.push({ account, message: err?.message || 'HYROS did not answer.' });
      }
    }
  }
  return out;
}

/**
 * Store the whole load under `report:...:<kind>` once every supported ad
 * account has a settled, successful entry (from this render or earlier ones).
 * Returns the stored value, or null when something is still missing.
 */
export async function storeWhole(data, { base, kind, supported }) {
  const promises = supported.map((a) => data.peek(accountKey(base, a.id)));
  if (!promises.every((p) => p && settled.has(p))) return null;
  const parts = await Promise.all(promises);
  const value = {
    [kind === 'ad' ? 'adRows' : 'adsetRows']: parts.flatMap((p) => p.rows),
    accounts: supported.map((a) => String(a.id)),
    capped: supported.filter((a, i) => parts[i].capped).map((a) => String(a.id)),
  };
  return data.cached(base, async () => value);
}

/* ---------------- source join ---------------- */

/** The memo entry of a hyros_get_sources row. */
export function sourceEntry(s) {
  return {
    name: s?.name || null,
    tag: s?.tag || null,
    category: s?.category?.name || null,
    trafficSource: s?.trafficSource?.name || null,
    adAccountId: s?.adSource?.adAccountId != null ? String(s.adSource.adAccountId) : null,
  };
}

/**
 * Join ids to their sources, 50 per call, in sequence, skipping ids already
 * in `memo`. An id asked for in a complete answer and not returned is memoised
 * as null; a failed or cut batch memoises nothing it did not get.
 * Returns { asked, failed: [{ count, message }], skipped, stale }.
 */
export async function joinSources(data, ids, memo, {
  deadline, isCurrent = () => true, serial = createSerial(), clock = Date.now,
} = {}) {
  const missing = [...new Set(ids.filter((id) => id !== null && id !== undefined && id !== '').map(String))].filter((id) => !memo.has(id));
  const out = { asked: 0, failed: [], skipped: 0, stale: false };
  for (let i = 0; i < missing.length; i += JOIN_BATCH) {
    const batch = missing.slice(i, i + JOIN_BATCH);
    if (!isCurrent()) { out.stale = true; return out; }
    if (deadline && clock() >= deadline) { out.skipped += missing.length - i; break; }
    out.asked += 1;
    try {
      const page = await serial.run(() => data.pagedInfo('hyros_get_sources', {
        request: { adSourceIds: batch, includeOrganic: true, includeDisregarded: true },
      }, { maxPages: 2, pageSize: PAGE_SIZE, deadline, timeoutMs: clampTimeout(TIMEOUTS.default, deadline) }));
      for (const s of page.rows || []) {
        const key = String(s?.adSource?.adSourceId ?? '');
        if (key) memo.set(key, sourceEntry(s));
      }
      if (!page.error && !page.truncated) {
        for (const id of batch) if (!memo.has(id)) memo.set(id, null);
      } else {
        const left = batch.filter((id) => !memo.has(id)).length;
        if (page.error === 'time budget') out.skipped += left;
        else if (left) out.failed.push({ count: left, message: page.error || 'source list cut short' });
      }
    } catch (err) {
      if (authError(err)) throw err;
      out.failed.push({ count: batch.length, message: err?.message || 'HYROS did not answer.' });
    }
  }
  return out;
}

/* ---------------- one render ---------------- */

/**
 * Everything one render loads for one level: the whole load from the cache
 * when present, else the selected accounts one by one, then the source join.
 * `selected` and `supported` are ad-account rows for this kind.
 */
export async function loadReport(data, {
  kind, model, window, range, tz, now, selected, supported, memo, deadline,
  isCurrent = () => true, serial = createSerial(), clock = Date.now,
}) {
  const base = cacheKey({ model, window, start: range.start, end: range.end, kind });
  const rowsKey = kind === 'ad' ? 'adRows' : 'adsetRows';
  let load = null;

  const whole = data.peek(base);
  if (whole) {
    try {
      const value = await whole;
      const byId = new Map(supported.map((a) => [String(a.id), a]));
      load = {
        rows: value[rowsKey], loaded: supported, failed: [], cut: [], skipped: [], stale: false, fromCache: true,
        capped: (value.capped || []).map((id) => ({ account: byId.get(id) || { id, name: id }, count: value[rowsKey].filter((r) => r._account === id).length })),
      };
    } catch { load = null; }
  }
  if (!load) {
    load = await loadAccounts(data, { accounts: selected, kind, model, window, range, tz, now, deadline, isCurrent, serial, clock });
    if (load.stale) return { stale: true };
    await storeWhole(data, { base, kind, supported });
  }
  if (!isCurrent()) return { stale: true };

  const ids = load.rows.map((r) => (kind === 'ad' ? r.parentId : r.id));
  const join = await joinSources(data, ids, memo, { deadline, isCurrent, serial, clock });
  if (join.stale) return { stale: true };
  const unjoined = ids.filter((id) => id && !memo.has(String(id))).length;
  return { ...load, kind, key: base, join: { ...join, unjoined } };
}
