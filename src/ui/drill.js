/**
 * The drill: the click-through behind a number (HYROS "deep mode"), shared by
 * the Report and the CRM. Rewritten from hyros-ai (api/drill.js and the
 * drawer in public/app.js) on top of `ctx.data`.
 *
 *   number -> the sales or calls credited to the row, or its leads
 *          -> one lead's journey and click history
 *
 * Under first and last click, a sale or call is credited to the source stored
 * on it as its first or last source, so the drill asks GET /sales or /calls
 * for exactly those (`firstSourceTags` or `lastSourceTags`, the report's
 * range), in batches of 50 tags, in sequence (one rate limit per account).
 * Leads are, under every model, the ones that joined in the range and
 * touched the row: the last source stored on a lead moves with its later
 * clicks, so it is not the source the cell credited the lead to.
 *
 * SCIENTIFIC credits the whole sale to its first source when it came within
 * SCIENTIFIC_DAYS of the first click, and to its last source otherwise, so
 * the drill asks for both and keeps each record by that rule.
 *
 * A model with no credited rule falls back to the leads that TOUCHED the
 * row's sources (GET /leads?tags=..., newest first, up to COHORT_MAX_PAGES
 * pages), then their sales or calls by lead id in batches of 50. That is not
 * the credited count in the cell, and the drawer says so, and says when older
 * leads were not queried.
 */
import { esc } from './dom.js';
import { TIMEOUTS, clampTimeout } from '../core/budget.js';
import { parseHyrosDate, offsetSuffix, ymdInTz, addDays, dayStart, dayEnd } from '../core/dates.js';

/** The `/leads` `tags` filter (OR) takes at most 50 tags; a drill sends the first 50 it is given. */
export const MAX_TAGS = 50;
/** The leadIds filter takes at most 50 ids. */
export const BATCH = 50;
/** Sales or calls per batch: 4 pages of 250 before the drawer says "newest shown". */
export const BATCH_MAX_PAGES = 4;
/**
 * Credited sales or calls per batch of tags: 40 pages of 250. The credited
 * list is the cell itself, so it reads further than a cohort batch, and under
 * Scientific its first-source filter also returns the later sales it drops;
 * the drill time limit still bounds it.
 */
export const CREDITED_MAX_PAGES = 40;
/**
 * Scientific range in days: a sale made within it of its first click goes to
 * its first source, any later one to its last. The Report never sends
 * `scientificDaysRange`, so HYROS computes its cells with this default.
 */
export const SCIENTIFIC_DAYS = 30;
/** Cohort leads: 8 pages of 250 (the newest 2,000) before the drawer says older leads were not read. */
export const COHORT_MAX_PAGES = 8;
/** A drill stops starting calls after this long and says what it did not query. */
export const DRILL_MS = 60000;
/** Click history window: bounded (the docs recommend a fromDate) but wide enough for a long journey. */
export const CLICKS_LOOKBACK_DAYS = 365;
/** Click history: 2 pages of 250 before the drawer says the list was cut short. */
export const CLICKS_MAX_PAGES = 2;

const LOADING = '<div class="empty"><img class="sven-load" src="./assets/brand/sven-lavender.svg" alt="">Loading…</div>';

/* ---------------- drawer ---------------- */

/**
 * Mount the drawer inside `root` (a view's root, so a tab switch takes it
 * away) and return its handles. One drawer per root: opening a second one
 * replaces the first. Escape, the scrim and the close button close it.
 */
export function openDrawer(root, { title = '', subtitle = '' } = {}) {
  root.querySelectorAll(':scope > .drawer-scrim, :scope > .drawer').forEach((el) => el.remove());

  const scrim = document.createElement('div');
  scrim.className = 'drawer-scrim';
  const drawer = document.createElement('aside');
  drawer.className = 'drawer';
  drawer.setAttribute('role', 'dialog');
  drawer.innerHTML = `
    <div class="drawer-head">
      <button type="button" data-drawer-back aria-label="Back" hidden>←</button>
      <div class="drawer-titles">
        <div class="drawer-title"></div>
        <div class="drawer-subtitle"></div>
      </div>
      <button type="button" data-drawer-close aria-label="Close">✕</button>
    </div>
    <div class="drawer-body">${LOADING}</div>`;
  root.append(scrim, drawer);

  const titleEl = drawer.querySelector('.drawer-title');
  const subEl = drawer.querySelector('.drawer-subtitle');
  const backEl = drawer.querySelector('[data-drawer-back]');
  const body = drawer.querySelector('.drawer-body');
  let onBack = null;

  const handle = {
    body,
    closed: false,
    /** Plain text, escaped here. */
    setTitle(text, sub) {
      titleEl.textContent = text ?? '';
      drawer.setAttribute('aria-label', text ?? '');
      if (sub !== undefined) subEl.textContent = sub ?? '';
    },
    /** HTML the caller already escaped (pills, money). */
    setSubtitleHtml(html) { subEl.innerHTML = html; },
    setBody(html) { body.innerHTML = html; body.scrollTop = 0; },
    loading() { body.innerHTML = LOADING; },
    /** Show Back and run `fn` on it; null hides it. */
    setBack(fn) { onBack = fn; backEl.hidden = !fn; },
    close() {
      if (handle.closed) return;
      handle.closed = true;
      scrim.remove();
      drawer.remove();
      document.removeEventListener('keydown', onKey);
    },
  };

  function onKey(e) {
    if (!drawer.isConnected) { document.removeEventListener('keydown', onKey); return; }
    if (e.key === 'Escape') handle.close();
  }
  document.addEventListener('keydown', onKey);
  scrim.addEventListener('click', () => handle.close());
  drawer.querySelector('[data-drawer-close]').addEventListener('click', () => handle.close());
  backEl.addEventListener('click', () => onBack?.());

  handle.setTitle(title, subtitle);
  return handle;
}

/* ---------------- rows ---------------- */

/**
 * Money on a sale or subscription as the API sends it.
 *
 * The documented `price` object is in the account currency (what the HYROS
 * UI shows), so it wins. The undocumented `usdPrice` is a USD conversion;
 * it is kept as `usdAmount` and used only when `price` is missing.
 * `refundedAmount` is the object's `refunded` (full or partial), only when > 0.
 * Returns { amount, currency, usdAmount?, refundedAmount? }.
 */
export function priceOf(x) {
  const usd = x?.usdPrice?.price != null ? Number(x.usdPrice.price) || 0 : null;
  const refunded = (p) => {
    const r = Number(p?.refunded) || 0;
    return r > 0 ? { refundedAmount: r } : {};
  };
  if (x?.price && typeof x.price === 'object' && x.price.price != null) {
    return { amount: Number(x.price.price) || 0, currency: x.price.currency || null, ...(usd !== null ? { usdAmount: usd } : {}), ...refunded(x.price) };
  }
  if (usd !== null) return { amount: usd, currency: x.usdPrice.currency || 'USD', ...refunded(x.usdPrice) };
  return { amount: Number(x?.price) || 0, currency: null };
}

/** What a sale adds to a total: its amount net of refunds, as HYROS revenue counts it. */
export const netAmount = (r) => (r.amount || 0) - (r.refundedAmount || 0);

/** ISO dates whatever form HYROS sent; legacy dates with an unknown zone take the account offset. */
const isoFor = (tz) => {
  const fallback = offsetSuffix(tz);
  return (v) => parseHyrosDate(v, fallback);
};

const flatSource = (s, iso) => (s ? {
  name: s.name || null,
  tag: s.tag || null,
  organic: Boolean(s.organic),
  ad: s.sourceLinkAd?.name || null,
  clickDate: iso(s.clickDate),
} : null);

export function compactLead(l, iso = isoFor(null)) {
  return {
    id: l.id ?? null,
    email: l.email || '',
    name: [l.firstName, l.lastName].filter(Boolean).join(' ').trim() || null,
    joined: iso(l.creationDate),
    stage: l.currentStage?.name || null,
    firstSource: flatSource(l.firstSource, iso),
    lastSource: flatSource(l.lastSource, iso),
    tags: (l.tags || []).slice(0, 12),
  };
}

const listOf = (body) => (Array.isArray(body) ? body : body?.result || []);

const chunk = (arr, n) => {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
};

/* ---------------- loads ---------------- */

/**
 * The cohort: the leads that touched any of `tags`, newest first, at most
 * COHORT_MAX_PAGES pages of 250 (`truncated` when more exist or `deadline`
 * came first). Only the first MAX_TAGS tags are sent, so callers put the most
 * relevant first; `tagsLeft` counts the ones left out. A tag holding a comma
 * is left out too: the API reads `tags` as one comma-separated value, so it
 * cannot be sent. `dates` ({ fromDate, toDate }) keeps only the leads that
 * joined in that range. Merged leads (`originLead`) are dropped. Returns
 * { leads, ids, truncated, tagsSent, tagsLeft, error? }.
 */
export async function loadCohort(data, tags, { tz = null, deadline = null, dates = null } = {}) {
  const all = [...new Set((tags || []).filter(Boolean))];
  const list = all.filter((t) => !String(t).includes(',')).slice(0, MAX_TAGS);
  const page = await data.pagedInfo('/leads', { tags: list, ...(dates || {}) },
    { maxPages: COHORT_MAX_PAGES, pageSize: 250, deadline, timeoutMs: clampTimeout(TIMEOUTS.default, deadline) });
  const iso = isoFor(tz);
  const raw = page.rows.filter((l) => !l.originLead);
  return {
    leads: raw.map((l) => compactLead(l, iso)),
    ids: raw.map((l) => l.id).filter(Boolean),
    truncated: Boolean(page.truncated),
    tagsSent: list.length,
    tagsLeft: all.length - list.length,
    ...(page.error ? { error: page.error } : {}),
  };
}

/**
 * The source filter a drill sends for an attribution model: the source each
 * model credits is the one stored on the sale or call as its first or
 * last source. SCIENTIFIC uses both, see `creditedLegs`.
 */
export const CREDITED_FIELD = { LAST_CLICK: 'lastSourceTags', FIRST_CLICK: 'firstSourceTags' };

/** The models whose credited records the drill can list. */
export const CREDITED_MODELS = Object.freeze(['LAST_CLICK', 'FIRST_CLICK', 'SCIENTIFIC']);

/** Days from a record's first click to the record itself, or null when either date is missing. */
function daysToRecord(x, iso) {
  const made = Date.parse(iso(x.creationDate) || '');
  const clicked = Date.parse(iso(x.firstSource?.clickDate) || '');
  return Number.isFinite(made) && Number.isFinite(clicked) ? (made - clicked) / 86400000 : null;
}

/**
 * The queries a credited drill runs for `model`, each with the source its
 * rows name and the records it keeps. Under SCIENTIFIC a record whose first
 * source is a row tag counts when it came within SCIENTIFIC_DAYS of the first
 * click, and one whose last source is a row tag counts when it came later.
 */
function creditedLegs(model, iso) {
  if (model !== 'SCIENTIFIC') return [{ field: CREDITED_FIELD[model], source: CREDITED_FIELD[model] === 'firstSourceTags' ? 'first' : 'last', keep: () => true }];
  const within = (x) => {
    const days = daysToRecord(x, iso);
    return days === null ? null : days <= SCIENTIFIC_DAYS;
  };
  return [
    { field: 'firstSourceTags', source: 'first', keep: (x) => within(x) === true },
    { field: 'lastSourceTags', source: 'last', keep: (x) => within(x) === false },
  ];
}

/**
 * The sales or calls credited to `tags` under `model`, made in `dates`: the
 * tags go in batches of MAX_TAGS on the path's first or last source filter
 * (both under SCIENTIFIC, see `creditedLegs`), IN SERIES, at most
 * CREDITED_MAX_PAGES pages each. A record has one first and one last source,
 * so two batches of one filter never return the same one; across the two
 * SCIENTIFIC filters it is kept once, by id. A tag holding a comma cannot be
 * sent (the API reads the array as one comma-separated value), so it counts
 * in `tagsLeft`. Stops like loadRecords.
 * Returns { records, truncated, tagsSent, tagsLeft, error? }.
 */
export async function loadCredited(data, kind, tags, { model, tz = null, deadline = null, isCurrent = () => true, dates = null } = {}) {
  const path = kind === 'sales' ? '/sales' : '/calls';
  const iso = isoFor(tz);
  const all = [...new Set((tags || []).filter(Boolean))];
  const list = all.filter((t) => !String(t).includes(','));
  const records = [];
  const seen = new Set();
  let truncated = false;
  let stopped = false;
  let error;
  for (const leg of creditedLegs(model, iso)) {
    const raw = [];
    for (const batch of chunk(list, MAX_TAGS)) {
      if (!isCurrent()) { truncated = true; stopped = true; break; }
      if (deadline && Date.now() >= deadline) { truncated = true; stopped = true; error = 'time budget'; break; }
      const page = await data.pagedInfo(path, { [leg.field]: batch, ...(dates || {}) },
        { maxPages: CREDITED_MAX_PAGES, pageSize: 250, deadline, timeoutMs: clampTimeout(TIMEOUTS.default, deadline) });
      raw.push(...page.rows);
      if (page.truncated) truncated = true;
    }
    const kept = raw.filter((x) => leg.keep(x) && !(x.id != null && seen.has(x.id)));
    kept.forEach((x) => { if (x.id != null) seen.add(x.id); });
    records.push(...toRecords(kind, kept, iso, leg.source));
    if (stopped) break;
  }
  return {
    records, truncated,
    tagsSent: list.length, tagsLeft: all.length - list.length, ...(error ? { error } : {}),
  };
}

/**
 * The sales or calls of a cohort: `leadIds` in batches of 50, IN SERIES, at
 * most 4 pages each. `dates` ({ fromDate, toDate }) keeps only the records
 * made in that range. Stops before the next batch when `deadline` passes or
 * `isCurrent()` says a newer drill replaced this one; both read as truncated.
 * Returns { records, truncated, error? }.
 */
export async function loadRecords(data, kind, leadIds, { tz = null, deadline = null, isCurrent = () => true, dates = null } = {}) {
  const path = kind === 'sales' ? '/sales' : '/calls';
  const iso = isoFor(tz);
  const raw = [];
  let truncated = false;
  let error;
  for (const batch of chunk(leadIds || [], BATCH)) {
    if (!isCurrent()) { truncated = true; break; }
    if (deadline && Date.now() >= deadline) { truncated = true; error = 'time budget'; break; }
    const page = await data.pagedInfo(path, { leadIds: batch, ...(dates || {}) },
      { maxPages: BATCH_MAX_PAGES, pageSize: 250, deadline, timeoutMs: clampTimeout(TIMEOUTS.default, deadline) });
    raw.push(...page.rows);
    if (page.truncated) truncated = true;
  }
  return { records: toRecords(kind, raw, iso), truncated, ...(error ? { error } : {}) };
}

/**
 * Sales or calls as the drawer lists them. `source` picks which source a row
 * names: 'first' or 'last' (the one a credited drill matched on); by default
 * a sale names its last and a call its first, falling back to the other.
 */
function toRecords(kind, raw, iso, source = null) {
  const sourceName = (x, fallbackFirst) => {
    if (source === 'first') return x.firstSource?.name || null;
    if (source === 'last') return x.lastSource?.name || null;
    return fallbackFirst ? (x.firstSource?.name || x.lastSource?.name || null) : (x.lastSource?.name || x.firstSource?.name || null);
  };
  return kind === 'sales'
    ? raw.map((s) => ({
        date: iso(s.creationDate),
        email: s.lead?.email || '',
        name: s.product?.name || null,
        ...priceOf(s),
        state: s.refundDate ? 'REFUNDED' : (s.recurring ? 'RECURRING' : null),
        source: sourceName(s, false),
      }))
    : raw.map((c) => ({
        date: iso(c.creationDate),
        email: c.lead?.email || '',
        name: c.name || c.tag || null,
        amount: null,
        state: c.state || (c.qualified ? 'QUALIFIED' : 'UNQUALIFIED'),
        source: sourceName(c, true),
      }));
}

/**
 * One lead: its journey and, best effort, its click history of the last
 * year (at most CLICKS_MAX_PAGES pages; `clicksTruncated` when more exist).
 * A failed clicks call becomes `clicksError`; a failed journey throws.
 * Returns { journey: { lead, sales, calls, journey }, clicks, clicksTruncated,
 * clicksError } or null when HYROS has no lead with that email.
 */
export async function loadJourney(data, email, { tz = null, deadline = null } = {}) {
  const fromDate = dayStart(addDays(ymdInTz(data.now(), tz), -CLICKS_LOOKBACK_DAYS), tz);
  const timeoutMs = clampTimeout(TIMEOUTS.default, deadline);
  // Two independent reads, side by side. /leads/clicks takes exactly one lead
  // selector: `emails` alone (a second one, or the deprecated `email`, is a 400).
  const [journeyRes, clicksRes] = await Promise.allSettled([
    data.call('/leads/journey', { emails: [email], includeEvents: true }, { timeoutMs }),
    data.pagedInfo('/leads/clicks', { emails: [email], fromDate },
      { maxPages: CLICKS_MAX_PAGES, pageSize: 250, deadline, timeoutMs }),
  ]);
  if (journeyRes.status === 'rejected') throw journeyRes.reason;

  const list = listOf(journeyRes.value);
  const j = Array.isArray(list) ? list[0] : null;
  if (!j) return null;

  const iso = isoFor(tz);
  const clicksError = clicksRes.status === 'rejected' ? String(clicksRes.reason?.message || clicksRes.reason) : null;
  return {
    journey: {
      lead: compactLead(j.lead || {}, iso),
      sales: (j.sales || []).map((s) => ({
        date: iso(s.creationDate),
        ...priceOf(s),
        product: s.product?.name || null,
        firstSource: s.firstSource?.name || null,
        lastSource: s.lastSource?.name || null,
        ad: s.firstSource?.sourceLinkAd?.name || null,
      })),
      calls: (j.calls || []).map((c) => ({
        date: iso(c.creationDate),
        name: c.tag || null,
        qualified: Boolean(c.qualified),
      })),
      journey: (j.journey || []).map((e) => ({
        type: e.type, date: iso(e.date), name: e.name || e.tag || '',
        keyword: e.keyword || '', extra: e.extra || null,
        subNames: e.subNames || null,
      })),
    },
    clicks: clicksRes.status === 'fulfilled'
      ? (clicksRes.value?.rows || []).map((c) => ({
          date: iso(c.date),
          page: c.page || c.trackedUrl || null,
          previousUrl: c.previousUrl || null,
          source: c.sourceLinkName || null,
          platform: c.adspendType === 'NONE' ? null : c.adspendType || null,
        }))
      : [],
    clicksTruncated: clicksRes.status === 'fulfilled' && Boolean(clicksRes.value?.truncated),
    clicksError,
  };
}

/* ---------------- markup ---------------- */

const TOUCH_PILL = '<span class="pill" title="Cohort from the leads with this source tag: leads that CLICKED this source. Attribution models can credit some conversions to a different source, so this can differ from the table cell.">touched ≠ credited</span>';

/** What a credited drill matched on, and what it does not reproduce of the report. */
const creditedPill = (attribution, kind) => {
  const one = kind.replace(/s$/, '');
  if (attribution === 'SCIENTIFIC') {
    const title = `Matched like Scientific: the first source stored on each ${one} when it came within ${SCIENTIFIC_DAYS} days of the first click, the last source otherwise.`;
    return `<span class="pill" title="${title}">credited · scientific</span>`;
  }
  const which = attribution === 'FIRST_CLICK' ? 'first' : 'last';
  const title = `Matched on the ${which} source stored on each ${one}, the one ${which} click credits. `
    + 'The report\'s attribution window is not applied here.';
  return `<span class="pill" title="${title}">credited · ${which} click</span>`;
};

/** The subtitle part of a drill that hit its time limit (DRILL_MS). */
const stoppedNote = (error) => (error === 'time budget' ? ', stopped at the time limit, the rest was not queried' : '');

const notePill = (note, esc) => (note ? ` <span class="pill">${esc(note)}</span>` : '');

/** The pill of a drill that sent only part of its tags: the list is incomplete, never a true 0. */
const tagsPill = (fmt, sent, left) => (left > 0
  ? ` <span class="pill warn" title="A drill queries at most ${MAX_TAGS} sources, the ones with the most in the clicked column first. The other ${left} were not queried.">first ${fmt.int(sent)} of ${fmt.int(sent + left)} sources</span>`
  : '');

/** The empty state of a drill that left tags out. */
const notQueried = (fmt, what, sent, left) =>
  `<div class="empty">No ${what} from the first ${fmt.int(sent)} of ${fmt.int(sent + left)} sources. The other ${fmt.int(left)} were not queried.</div>`;

/** The income of a lead: its sales in the account currency, net of refunds (other currencies are not summed). */
export function leadIncome(sales, accountCurrency) {
  return (sales || [])
    .filter((s) => !s.currency || s.currency === accountCurrency)
    .reduce((sum, s) => sum + netAmount(s), 0);
}

/**
 * `{ subtitle, html }` for a cohort. `model = { leads, truncated, error?, note?, tagsSent?, tagsLeft?, inRange? }`:
 * `inRange` says the leads joined in the report's range. A `truncated`
 * cohort says that older leads were not read, never shows a bare 0.
 */
export function renderCohort(ctx, { leads = [], truncated = false, error = null, note = '', tagsSent = 0, tagsLeft = 0, inRange = false }) {
  const { fmt } = ctx;
  const e = ctx.esc || esc;
  const what = inRange ? 'leads joined in the range and touched this source' : 'leads touched this source';
  const subtitle = `${fmt.int(leads.length)}${truncated || tagsLeft > 0 ? '+' : ''} ${what}`
    + (truncated ? `, newest ${fmt.int(leads.length)} shown, older ones not read` : '')
    + stoppedNote(error)
    + ` ${TOUCH_PILL}${tagsPill(fmt, tagsSent, tagsLeft)}${notePill(note, e)}`;
  if (!leads.length) {
    if (tagsLeft > 0) return { subtitle, html: notQueried(fmt, 'leads', tagsSent, tagsLeft) };
    if (truncated) {
      return { subtitle, html: '<div class="empty">No leads among the ones read. Older leads were not read.</div>' };
    }
    return { subtitle, html: '<div class="empty">No leads returned for this source.</div>' };
  }

  const html = `<div class="cohort">${leads.map((l) => `
    <button type="button" class="cohort-row" data-email="${e(l.email)}">
      <div class="cohort-main">
        <span class="cohort-email">${e(l.email)}</span>
        ${l.stage ? `<span class="pill stage">${e(l.stage)}</span>` : ''}
      </div>
      <div class="cohort-sub">
        ${e(fmt.date(l.joined))}
        ${l.firstSource?.ad ? ` · ad: ${e(l.firstSource.ad)}` : ''}
        ${l.lastSource && l.lastSource.tag !== l.firstSource?.tag
          ? ` · last: ${e(l.lastSource.name)}${l.lastSource.organic ? ' (organic)' : ''}` : ''}
      </div>
    </button>`).join('')}</div>`;
  return { subtitle, html };
}

/**
 * `{ subtitle, html }` for the sales or calls of a cohort.
 * `model = { kind, records, cohortSize, truncated, cohortCut?, error?, note?, tagsSent?, tagsLeft?, inRange? }`;
 * `inRange` says the records were limited to the report's date range,
 * `truncated` that a lead batch had more pages than were read, `cohortCut`
 * that the cohort itself stopped before its oldest leads, and `error` 'time
 * budget' that the drill hit its time limit. Any of them reads as "N+" with
 * what was left out, never as a bare 0.
 */
export function renderRecords(ctx, { kind, records = [], cohortSize = 0, truncated = false, cohortCut = false, error = null, note = '', tagsSent = 0, tagsLeft = 0, inRange = false }) {
  const { fmt } = ctx;
  const e = ctx.esc || esc;
  const isSales = kind === 'sales';
  const inAccount = (r) => !r.currency || r.currency === fmt.currency;
  const total = isSales ? records.filter(inAccount).reduce((s, r) => s + netAmount(r), 0) : null;
  const foreign = isSales ? records.filter((r) => !inAccount(r)).length : 0;

  const stopped = error === 'time budget';
  const subtitle = `${fmt.int(records.length)}${truncated || cohortCut || tagsLeft > 0 ? '+' : ''} ${e(kind)}${inRange ? ' in the range' : ''} from ${fmt.int(cohortSize)} touched leads`
    + (cohortCut ? ', the newest that touched it; older leads were not queried' : '')
    + (truncated && !stopped ? ', newest shown' : '')
    + stoppedNote(error)
    + (isSales && total ? ` · <b class="good">${e(fmt.money(total))}</b>` : '')
    + (foreign ? ` · ${fmt.int(foreign)} sale${foreign === 1 ? '' : 's'} in other currencies not summed` : '')
    + ` ${TOUCH_PILL}${tagsPill(fmt, tagsSent, tagsLeft)}${notePill(note, e)}`;
  if (!records.length) {
    if (tagsLeft > 0) return { subtitle, html: notQueried(fmt, e(kind), tagsSent, tagsLeft) };
    if (cohortCut || stopped) {
      const left = [cohortCut ? 'Older leads were not queried.' : '', stopped ? 'The drill stopped at its time limit before querying every lead.' : ''].filter(Boolean).join(' ');
      return { subtitle, html: `<div class="empty">No ${e(kind)}${inRange ? ' in the range' : ''} from the ${fmt.int(cohortSize)} touched leads queried. ${left}</div>` };
    }
    return { subtitle, html: `<div class="empty">No ${e(kind)} recorded for this cohort${inRange ? ' in the range' : ''}.</div>` };
  }

  return { subtitle, html: recordRows(fmt, e, isSales, records) };
}

/** The list markup of sales or calls, one button per record (opens the lead's journey). */
function recordRows(fmt, e, isSales, records) {
  return `<div class="cohort">${records.map((r) => `
    <button type="button" class="cohort-row" data-email="${e(r.email)}">
      <div class="cohort-main">
        <span class="cohort-email">${e(r.email)}</span>
        ${isSales && r.amount ? `<span class="tl-extra">${e(fmt.moneyIn(r.amount, r.currency))}</span>` : ''}
        ${r.state ? `<span class="pill ${r.state === 'QUALIFIED' ? 'stage' : r.state === 'REFUNDED' ? 'warn' : ''}">${e(r.state)}</span>` : ''}
      </div>
      <div class="cohort-sub">
        ${e(fmt.datetime(r.date))}${r.name ? ` · ${e(r.name)}` : ''}${r.source ? ` · src: ${e(r.source)}` : ''}
      </div>
    </button>`).join('')}</div>`;
}

/**
 * `{ subtitle, html }` for the sales or calls credited to a row.
 * `model = { kind, records, truncated, attribution, note?, tagsSent?, tagsLeft? }`, `attribution`
 * being the report's model. Refunded sales are listed but not counted or
 * summed: the report's Sales and Revenue leave them out too.
 */
export function renderCredited(ctx, { kind, records = [], truncated = false, error = null, attribution, note = '', tagsSent = 0, tagsLeft = 0 }) {
  const { fmt } = ctx;
  const e = ctx.esc || esc;
  const isSales = kind === 'sales';
  const counted = isSales ? records.filter((r) => r.state !== 'REFUNDED') : records;
  const refunded = records.length - counted.length;
  const inAccount = (r) => !r.currency || r.currency === fmt.currency;
  const total = isSales ? counted.filter(inAccount).reduce((s, r) => s + (r.amount || 0), 0) : null;
  const foreign = isSales ? counted.filter((r) => !inAccount(r)).length : 0;

  const subtitle = `${fmt.int(counted.length)}${truncated || tagsLeft > 0 ? '+' : ''} ${e(kind)} credited in the range`
    + (truncated && error !== 'time budget' ? ', newest shown' : '')
    + stoppedNote(error)
    + (isSales && total ? ` · <b class="good">${e(fmt.money(total))}</b>` : '')
    + (refunded ? ` · ${fmt.int(refunded)} refunded, listed but not counted` : '')
    + (foreign ? ` · ${fmt.int(foreign)} sale${foreign === 1 ? '' : 's'} in other currencies not summed` : '')
    + ` ${creditedPill(attribution, kind)}${tagsPill(fmt, tagsSent, tagsLeft)}${notePill(note, e)}`;
  if (!records.length) {
    return { subtitle, html: tagsLeft > 0 ? notQueried(fmt, e(kind), tagsSent, tagsLeft) : `<div class="empty">No ${e(kind)} credited to this row in the range.</div>` };
  }
  return { subtitle, html: recordRows(fmt, e, isSales, records) };
}

const JOURNEY_ICONS = {
  sale: '💰', call: '📞', 'lead-stage': '🏁', 'opt-in': '✉️', sl: '🖱️', action: '⚡',
};

/** `{ subtitle, html }` for one lead. `model` is what loadJourney answered. */
export function renderJourney(ctx, { journey: j, clicks = [], clicksTruncated = false, clicksError = null }) {
  const { fmt } = ctx;
  const e = ctx.esc || esc;
  const l = j.lead || {};
  const income = leadIncome(j.sales, fmt.currency);

  const subtitle = `${l.stage ? `<span class="pill stage">${e(l.stage)}</span> ` : ''}`
    + `joined ${e(fmt.date(l.joined))}`
    + (income ? ` · income <b class="good">${e(fmt.money(income))}</b>` : '');

  const timeline = (j.journey || []).map((ev) => `
    <div class="tl-item tl-${e(ev.type)}">
      <div class="tl-icon">${JOURNEY_ICONS[ev.type] || '•'}</div>
      <div class="tl-body">
        <div class="tl-head">
          <b>${e(ev.keyword)}</b> ${e(ev.name)}
          ${ev.extra ? `<span class="tl-extra">${e(ev.extra)}</span>` : ''}
        </div>
        ${ev.subNames?.length ? `<div class="tl-sub">${e(ev.subNames.join(', '))}</div>` : ''}
        <div class="tl-date">${e(fmt.datetime(ev.date))}</div>
      </div>
    </div>`).join('');

  const clicksNote = clicksError
    ? `<div class="drawer-section">Click history</div><div class="note err">Click history could not be fetched: ${e(clicksError)}</div>`
    : '';
  const clickRows = clicks.length ? `
    <div class="drawer-section">Click history · ${fmt.int(clicks.length)}${clicksTruncated ? '+' : ''} tracked clicks${clicksTruncated ? ', list cut short' : ''}</div>
    <div class="clicks">${clicks.map((c) => `
      <div class="click-row">
        <div class="click-page">${e((c.page || '').replace(/^https?:\/\//, ''))}
          ${c.source ? `<span class="pill">${e(c.source)}</span>` : ''}
          ${c.platform ? `<span class="pill fb">${e(c.platform)}</span>` : ''}
        </div>
        <div class="click-sub">
          ${c.previousUrl ? `from ${e(c.previousUrl.replace(/^https?:\/\//, ''))} · ` : ''}${e(fmt.datetime(c.date))}
        </div>
      </div>`).join('')}</div>` : '';

  const html = `
    <div class="drawer-section">Journey</div>
    <div class="timeline">${timeline || '<div class="empty">No journey events.</div>'}</div>
    ${clicksNote}${clickRows}`;
  return { subtitle, html };
}

/* ---------------- flows ---------------- */

const errNote = (err, e) => `<div class="note err">${e(err?.message || String(err))}</div>`;

/**
 * Open one lead's journey. With `drawer` it reuses an open drawer (and `back`
 * returns to what was there); without, it opens a new one.
 */
export async function openLeadJourney(ctx, email, { drawer = null, back = null } = {}) {
  const e = ctx.esc || esc;
  const d = drawer || openDrawer(ctx.root, { title: email, subtitle: 'Lead journey' });
  d.setTitle(email, 'Lead journey');
  d.setBack(back);
  d.loading();
  const token = (d.token = (d.token || 0) + 1);
  const live = () => !d.closed && d.token === token;
  try {
    const { timezone: tz } = await ctx.data.account();
    const model = await loadJourney(ctx.data, email, { tz });
    if (!live()) return;
    if (!model) { d.setBody(`<div class="empty">No lead found for ${e(email)}.</div>`); return; }
    const { subtitle, html } = renderJourney(ctx, model);
    d.setSubtitleHtml(subtitle);
    d.setBody(html);
  } catch (err) {
    if (live()) d.setBody(errNote(err, e));
  }
}

/**
 * Open the drill behind a report number: the leads for `metric` 'leads', or
 * the sales or calls. `tags` are the row's source tags, most relevant first;
 * `note` is shown as a pill (e.g. "ad set cohort: <name>" for an ad row).
 * `range` ({ start, end } as YYYY-MM-DD) is the report's range and
 * `attribution` its model: under the CREDITED_MODELS the sales and calls are
 * the ones that model credits to the tags; any other model lists the sales or
 * calls of the leads that touched them. Leads are the ones that joined in the
 * range and touched the tags, under every model.
 * Clicking a lead opens its journey; Back returns to the list without calling
 * HYROS again.
 */
export async function openCohortDrill(ctx, { title, tags, metric = 'leads', label = '', note = '', range = null, attribution = null }) {
  const e = ctx.esc || esc;
  const d = openDrawer(ctx.root, { title, subtitle: label });
  if (!tags?.length) {
    d.setBody('<div class="empty">This row has no source tag to drill into.</div>');
    return d;
  }
  const token = (d.token = (d.token || 0) + 1);
  const live = () => !d.closed && d.token === token;

  let view = null;
  const show = () => {
    d.token = token;
    d.setTitle(title, label);
    d.setBack(null);
    d.setSubtitleHtml(view.subtitle);
    d.setBody(view.html);
    d.body.querySelectorAll('.cohort-row[data-email]').forEach((el) => {
      el.addEventListener('click', () => openLeadJourney(ctx, el.dataset.email, { drawer: d, back: show }));
    });
  };

  try {
    const { timezone: tz } = await ctx.data.account();
    const dates = range ? { fromDate: dayStart(range.start, tz), toDate: dayEnd(range.end, tz, ctx.data.now()) } : null;
    const credited = CREDITED_MODELS.includes(attribution) ? attribution : null;
    const deadline = Date.now() + DRILL_MS;
    if (metric === 'leads') {
      const cohort = await loadCohort(ctx.data, tags, { tz, dates, deadline });
      if (!live()) return d;
      view = renderCohort(ctx, { ...cohort, note, inRange: Boolean(dates) });
    } else if (credited) {
      const out = await loadCredited(ctx.data, metric, tags, { model: credited, tz, isCurrent: live, dates, deadline });
      if (!live()) return d;
      view = renderCredited(ctx, { kind: metric, ...out, attribution: credited, note });
    } else {
      const cohort = await loadCohort(ctx.data, tags, { tz, deadline });
      if (!live()) return d;
      const out = await loadRecords(ctx.data, metric, cohort.ids, { tz, isCurrent: live, dates, deadline });
      if (!live()) return d;
      view = renderRecords(ctx, {
        kind: metric, records: out.records, cohortSize: cohort.ids.length,
        truncated: out.truncated, cohortCut: cohort.truncated, error: cohort.error || out.error, note,
        tagsSent: cohort.tagsSent, tagsLeft: cohort.tagsLeft, inRange: Boolean(dates),
      });
    }
    show();
  } catch (err) {
    if (live()) d.setBody(errNote(err, e));
  }
  return d;
}
