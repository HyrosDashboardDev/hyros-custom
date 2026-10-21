/**
 * The drill: the click-through behind a number (HYROS "deep mode"), shared by
 * the Report and the CRM. Rewritten from hyros-ai (api/drill.js and the
 * drawer in public/app.js) on top of `ctx.data`.
 *
 *   number -> cohort (the leads that touched the row's sources)
 *          -> sales or calls of that cohort
 *          -> one lead's journey and click history
 *
 * Sales and calls have no tag filter, so those drills run two steps:
 * GET /leads?tags=... for the cohort ids, then GET /sales or /calls with
 * leadIds in batches of 50 (the filter's cap), in sequence (one rate limit
 * per account).
 *
 * The cohort is the leads that TOUCHED the source, which is not the
 * attribution-credited count in the cell (models reassign credit; a later
 * organic click can take it). The drawer says so.
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
 * The cohort: one page of the newest 250 leads that touched any of `tags`.
 * Only the first MAX_TAGS tags are sent, so callers put the most relevant
 * first; `tagsLeft` counts the ones left out. A tag holding a comma is left
 * out too: the API reads `tags` as one comma-separated value, so it cannot be
 * sent. Merged leads (`originLead`) are dropped. Returns
 * { leads, ids, truncated, tagsSent, tagsLeft }.
 */
export async function loadCohort(data, tags, { tz = null, deadline = null } = {}) {
  const all = [...new Set((tags || []).filter(Boolean))];
  const list = all.filter((t) => !String(t).includes(',')).slice(0, MAX_TAGS);
  const body = await data.call('/leads', { tags: list, pageSize: 250 },
    { timeoutMs: clampTimeout(TIMEOUTS.default, deadline) });
  const iso = isoFor(tz);
  const raw = listOf(body).filter((l) => !l.originLead);
  return {
    leads: raw.map((l) => compactLead(l, iso)),
    ids: raw.map((l) => l.id).filter(Boolean),
    truncated: Boolean(body?.nextPageId),
    tagsSent: list.length,
    tagsLeft: all.length - list.length,
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

  const records = kind === 'sales'
    ? raw.map((s) => ({
        date: iso(s.creationDate),
        email: s.lead?.email || '',
        name: s.product?.name || null,
        ...priceOf(s),
        state: s.refundDate ? 'REFUNDED' : (s.recurring ? 'RECURRING' : null),
        source: s.lastSource?.name || s.firstSource?.name || null,
      }))
    : raw.map((c) => ({
        date: iso(c.creationDate),
        email: c.lead?.email || '',
        name: c.name || c.tag || null,
        amount: null,
        state: c.state || (c.qualified ? 'QUALIFIED' : 'UNQUALIFIED'),
        source: c.firstSource?.name || c.lastSource?.name || null,
      }));
  return { records, truncated, ...(error ? { error } : {}) };
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

/** `{ subtitle, html }` for a cohort. `model = { leads, truncated, note?, tagsSent?, tagsLeft? }`. */
export function renderCohort(ctx, { leads = [], truncated = false, note = '', tagsSent = 0, tagsLeft = 0 }) {
  const { fmt } = ctx;
  const e = ctx.esc || esc;
  const subtitle = `${fmt.int(leads.length)}${truncated || tagsLeft > 0 ? '+' : ''} leads touched this source`
    + (truncated ? ', newest 250 shown' : '') + ` ${TOUCH_PILL}${tagsPill(fmt, tagsSent, tagsLeft)}${notePill(note, e)}`;
  if (!leads.length) {
    return { subtitle, html: tagsLeft > 0 ? notQueried(fmt, 'leads', tagsSent, tagsLeft) : '<div class="empty">No leads returned for this source.</div>' };
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
 * `model = { kind, records, cohortSize, truncated, note?, tagsSent?, tagsLeft?, inRange? }`;
 * `inRange` says the records were limited to the report's date range.
 */
export function renderRecords(ctx, { kind, records = [], cohortSize = 0, truncated = false, note = '', tagsSent = 0, tagsLeft = 0, inRange = false }) {
  const { fmt } = ctx;
  const e = ctx.esc || esc;
  const isSales = kind === 'sales';
  const inAccount = (r) => !r.currency || r.currency === fmt.currency;
  const total = isSales ? records.filter(inAccount).reduce((s, r) => s + netAmount(r), 0) : null;
  const foreign = isSales ? records.filter((r) => !inAccount(r)).length : 0;

  const subtitle = `${fmt.int(records.length)}${truncated || tagsLeft > 0 ? '+' : ''} ${e(kind)}${inRange ? ' in the range' : ''} from ${fmt.int(cohortSize)} touched leads`
    + (truncated ? ', newest shown' : '')
    + (isSales && total ? ` · <b class="good">${e(fmt.money(total))}</b>` : '')
    + (foreign ? ` · ${fmt.int(foreign)} sale${foreign === 1 ? '' : 's'} in other currencies not summed` : '')
    + ` ${TOUCH_PILL}${tagsPill(fmt, tagsSent, tagsLeft)}${notePill(note, e)}`;
  if (!records.length) {
    return { subtitle, html: tagsLeft > 0 ? notQueried(fmt, e(kind), tagsSent, tagsLeft) : `<div class="empty">No ${e(kind)} recorded for this cohort${inRange ? ' in the range' : ''}.</div>` };
  }

  const html = `<div class="cohort">${records.map((r) => `
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
  return { subtitle, html };
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
 * Open the drill behind a report number: the cohort for `metric` 'leads',
 * or its sales or calls. `tags` are the row's source tags, most relevant
 * first; `note` is shown as a pill (e.g. "ad set cohort: <name>" for an ad
 * row). `range` ({ start, end } as YYYY-MM-DD) limits the sales or calls to
 * the report's range; the cohort itself has no date filter (a source tag
 * only records the lead's first touch). Clicking a lead opens its journey;
 * Back returns to the list without calling HYROS again.
 */
export async function openCohortDrill(ctx, { title, tags, metric = 'leads', label = '', note = '', range = null }) {
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
    const cohort = await loadCohort(ctx.data, tags, { tz });
    if (!live()) return d;
    if (metric === 'leads') {
      view = renderCohort(ctx, { ...cohort, note });
    } else {
      const dates = range ? { fromDate: dayStart(range.start, tz), toDate: dayEnd(range.end, tz, ctx.data.now()) } : null;
      const out = await loadRecords(ctx.data, metric, cohort.ids, { tz, isCurrent: live, dates });
      if (!live()) return d;
      view = renderRecords(ctx, {
        kind: metric, records: out.records, cohortSize: cohort.ids.length,
        truncated: cohort.truncated || out.truncated, note,
        tagsSent: cohort.tagsSent, tagsLeft: cohort.tagsLeft, inRange: Boolean(dates),
      });
    }
    show();
  } catch (err) {
    if (live()) d.setBody(errNote(err, e));
  }
  return d;
}
