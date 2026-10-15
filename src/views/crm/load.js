/**
 * One CRM load: the aggregations of the active sub-tab, then its list, in
 * series, each kept in `data.cached` so coming back to the same sub-tab,
 * range and filters costs nothing until Refresh. No DOM.
 */
import { TIMEOUTS, clampTimeout } from '../../core/budget.js';
import { TAB_BY_KEY, aggregationCalls, listArgs, baseKey } from './filters.js';
import { shapeRows, readAggregation } from './rows.js';

/** 8 pages of 250: the newest 2,000 rows. */
export const LIST_MAX_PAGES = 8;
export const PAGE_SIZE = 250;

/**
 * A list cut by the time budget or an expired cursor is shown once and then
 * retired: its key gets a new generation so the next render loads it again
 * instead of keeping the partial rows until Refresh.
 */
const generations = new Map();
export function keyOf(base, part) {
  const id = `${base}:${part}`;
  const gen = generations.get(id) || 0;
  return gen ? `${id}:r${gen}` : id;
}
function retire(base, part) {
  const id = `${base}:${part}`;
  generations.set(id, (generations.get(id) || 0) + 1);
}

/** What each loaded list counted, by its cache key, for the sub-tab chips. */
const known = new Map();

const message = (err) => String(err?.message || err || 'HYROS did not answer.');

/** The figure a sub-tab's chip shows: the aggregation total, else the rows loaded. */
export function headline(model) {
  if (!model) return null;
  const total = model.aggs.stage?.total ?? model.aggs.firstSource?.total ?? model.aggs.qualification?.total ?? null;
  if (total !== null && total !== undefined) return { count: total, plus: false };
  if (!model.list) return null;
  return { count: model.list.rows.length, plus: Boolean(model.list.truncated) };
}

/**
 * The chip count of a sub-tab that is not the active one: only when its list
 * is still in the cache (Refresh empties it), never a call.
 */
export function knownCount(data, tab, range, filters, search) {
  const key = keyOf(baseKey(tab, range, filters, search), 'list');
  if (!data.peek?.(key)) return null;
  return known.get(key) || null;
}

/**
 * Load `tab` for `range`. Calls run one at a time; before each one the load
 * stops when `isLive()` says a newer render started (`stopped: 'stale'`) or
 * the deadline passed (`stopped: 'time budget'`). A failed aggregation goes
 * to `aggErrors` and the list still loads; a failed list is `listError`.
 * `onStep(model)` runs after each aggregation so tiles can paint early.
 */
export async function loadTab(data, {
  tab, range, tz = null, now, filters, search = '', deadline = null,
  isLive = () => true, onStep = () => {},
}) {
  const base = baseKey(tab, range, filters, search);
  const model = { tab, aggs: {}, aggErrors: [], list: null, listError: null, stopped: null };
  const timeoutMs = () => clampTimeout(TIMEOUTS.default, deadline);
  const canCall = () => {
    if (!isLive()) { model.stopped = 'stale'; return false; }
    if (deadline && Date.now() >= deadline) { model.stopped = 'time budget'; return false; }
    return true;
  };

  for (const agg of aggregationCalls(tab, range, tz, now, filters, search)) {
    if (!canCall()) {
      if (model.stopped === 'time budget') model.aggErrors.push({ name: agg.name, message: 'skipped: time budget' });
      continue;
    }
    try {
      model.aggs[agg.name] = await data.cached(keyOf(base, `agg:${agg.name}`),
        async () => readAggregation(await data.call(agg.tool, agg.args, { timeoutMs: timeoutMs() })));
    } catch (err) {
      model.aggErrors.push({ name: agg.name, message: message(err) });
    }
    if (isLive()) onStep(model);
  }
  if (model.stopped === 'stale' || !canCall()) {
    if (model.stopped === 'time budget') model.listError = 'skipped: time budget';
    return model;
  }

  const key = keyOf(base, 'list');
  try {
    const list = await data.cached(key, async () => {
      const page = await data.pagedInfo(TAB_BY_KEY[tab].tool, listArgs(tab, range, tz, now, filters, search),
        { maxPages: LIST_MAX_PAGES, pageSize: PAGE_SIZE, deadline, timeoutMs: timeoutMs() });
      return { rows: shapeRows(tab, page.rows, tz), truncated: Boolean(page.truncated), error: page.error || null };
    });
    if (list.error) retire(base, 'list');
    model.list = list;
    const head = headline(model);
    if (head) known.set(key, head);
  } catch (err) {
    model.listError = message(err);
  }
  return model;
}
