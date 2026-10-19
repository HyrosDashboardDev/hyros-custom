/**
 * Health: the four tracking checks and their tolerant reply readers.
 *
 * siteOf, siteTargets, hostOf, the readers and groupSites come from hyros-ai
 * (features/health), widened to the real script outcome enum
 * (TrackingScriptVerificationEvent). The orchestrator is rewritten on
 * ctx.data with its own deadline and a render counter.
 *
 * Every check records { status: 'ok' | 'empty' | 'skipped' | 'failed', reason?, ms? }
 * ('pending' while it has not run yet). A reply the code cannot read is a
 * failed check ("unexpected reply shape"), never an empty one.
 */
import { TIMEOUTS, clampTimeout } from '../../core/budget.js';
import { addDays } from '../../core/dates.js';

/** AssertScriptPresenceRequest.MAX_DOMAINS: the MCP refuses more URLs per call. */
export const MAX_URLS_PER_CALL = 3;
/** 4 batches at most; the deadline usually stops earlier. */
export const MAX_SITE_URLS = 12;
/** Parameter rows listed in the panel; the tile counts every row. */
export const MAX_PARAM_ROWS = 50;
/** A script batch is not started with less than this left before the deadline. */
export const SLOW_MIN_LEFT_MS = 8000;
export const MAX_CLICK_LEADS = 50;
export const VISIT_DAYS = 7;
export const MAX_CLICK_PAGES = 4;
export const GOOGLE_CHANNELS = ['SEARCH', 'PERFORMANCE_MAX'];
export const GOOGLE_TYPES = new Set(['GOOGLE', 'GOOGLE_V2']);

/** Outcomes that mean the script is on the page (SUCCESSFUL, SCRIPT_DETECTED; older spellings kept). */
export const SCRIPT_OK = new Set(['SUCCESSFUL', 'SCRIPT_DETECTED', 'SCRIPT_FOUND', 'FOUND', 'OK', 'PRESENT', 'INSTALLED']);
/** The only outcome that means the script is missing; TIMEOUT_ERROR, UNKNOWN_ERROR and DOMAIN_NOT_FOUND are inconclusive. */
export const SCRIPT_MISSING = new Set(['SCRIPT_NOT_FOUND']);

const isMap = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const upper = (v) => String(v ?? '').toUpperCase();
export const scriptFound = (st) => SCRIPT_OK.has(upper(st));
export const scriptMissing = (st) => SCRIPT_MISSING.has(upper(st));
const conclusive = (st) => scriptFound(st) || scriptMissing(st);

/* ---------------- status records ---------------- */
const ok = (ms) => ({ status: 'ok', ms });
const empty = (ms) => ({ status: 'empty', ms });
const skipped = (reason) => ({ status: 'skipped', reason });
const failed = (reason, ms) => (ms === undefined ? { status: 'failed', reason } : { status: 'failed', reason, ms });
export const PENDING = Object.freeze({ status: 'pending' });

const isTimeout = (err) => err?.code === 'timeout' || /timed out/i.test(err?.message || '');

/** A promise with a stopwatch: { value, ms } or { error, ms }; never throws. */
async function timed(run) {
  const started = Date.now();
  try { return { value: await run(), ms: Date.now() - started }; } catch (error) { return { error, ms: Date.now() - started }; }
}

/* ---------------- reply readers (tolerant) ---------------- */

/** hyros_get_domains: string[] | { result | domains: [string | { domain | name | url }] }; null when unreadable. */
export function readDomains(d) {
  const list = Array.isArray(d) ? d : (Array.isArray(d?.result) ? d.result : (Array.isArray(d?.domains) ? d.domains : null));
  if (!list) return null;
  return list.map((x) => (typeof x === 'string' ? x : x?.domain || x?.name || x?.url)).filter(Boolean).map(String);
}

/**
 * hyros_assert_script_presence_on_domain: { url: status } (possibly under
 * `result`), or [{ url | domain, status | result | present }]. Null when unreadable.
 */
export function readScripts(r) {
  const map = isMap(r?.result) ? r.result : r;
  if (isMap(map)) return Object.fromEntries(Object.entries(map).map(([k, v]) => [k, typeof v === 'string' ? v : (v?.status ?? v?.result ?? String(v))]));
  if (Array.isArray(map) && map.length && map.every(isMap)) {
    const entries = map.map((row) => [row.url || row.domain, row.status ?? row.result ?? (row.present === undefined ? undefined : (row.present ? 'SCRIPT_FOUND' : 'SCRIPT_NOT_FOUND'))])
      .filter(([k, v]) => k && v !== undefined);
    return entries.length ? Object.fromEntries(entries) : null;
  }
  return null;
}

/** hyros_check_tracking_parameters_for_integrations: rows bare, under result | ads, or one row object; null when unreadable. */
export function readParamRows(r) {
  let rows = null;
  if (Array.isArray(r)) rows = r;
  else if (Array.isArray(r?.result)) rows = r.result;
  else if (Array.isArray(r?.ads)) rows = r.ads;
  else if (isMap(r) && ('valid' in r || 'campaignId' in r || 'adGroupId' in r)) rows = [r];
  return rows;
}

/** A parameter row HYROS flagged: the DTO's `valid: false`; older shapes by `missing` or `ok: false`. */
export function isFlagged(row) {
  if (!row) return false;
  if (typeof row.valid === 'boolean') return !row.valid;
  return Boolean(row.missing) || row.ok === false;
}

/** The list rows of a paged reply. */
const listOf = (v) => (Array.isArray(v) ? v : (Array.isArray(v?.result) ? v.result : []));

/* ---------------- sites ---------------- */

/**
 * The verified domains HYROS returns are the TRACKING domains: the CNAMEs a
 * customer points at HYROS (data.shop.com). The universal script lives on
 * the site itself (shop.com, www.shop.com), so that is what the presence
 * check must fetch. Strip the tracking label down to the registrable domain,
 * keeping a second-level public suffix such as co.uk / com.mx intact.
 */
const SECOND_LEVEL = new Set(['co', 'com', 'org', 'net', 'gov', 'edu', 'ac', 'gob']);
export function siteOf(trackingDomain) {
  const host = String(trackingDomain || '').replace(/^https?:\/\//, '').replace(/[/:].*$/, '').toLowerCase();
  const labels = host.split('.').filter(Boolean);
  if (labels.length <= 2) return host;
  const keep = labels.at(-1).length === 2 && SECOND_LEVEL.has(labels.at(-2)) ? 3 : 2;
  return labels.slice(-keep).join('.');
}

/** Site URLs to fetch for a list of tracking domains: apex and www per site, deduplicated, whole sites only, capped. */
export function siteTargets(domains, max = MAX_SITE_URLS) {
  const out = [];
  const seen = new Set();
  for (const d of domains) {
    const apex = siteOf(d);
    if (!apex) continue;
    const urls = [`https://${apex}/`, `https://www.${apex}/`].filter((u) => !seen.has(u));
    if (!urls.length) continue;
    // Apex and www of one site go in together: when the cap is hit a whole site is left out, never half of one.
    if (out.length + urls.length > max) break;
    for (const url of urls) { seen.add(url); out.push({ url, trackingDomain: d }); }
  }
  return out;
}

/** Hostname without www, lowercased; null for anything that is not a URL. */
export function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, '').toLowerCase(); } catch { return null; }
}

/**
 * One entry per tracking domain: its site variants with their status; found
 * when any variant has the script; visited when it has not but HYROS recorded
 * visits on the site (the check reads the raw page and misses injected
 * scripts); inconclusive when every checked variant timed out or errored.
 */
export function groupSites(sites, scripts, visitedHosts = []) {
  const visitedSet = new Set(visitedHosts);
  const byDomain = new Map();
  for (const s of sites) {
    const list = byDomain.get(s.trackingDomain) || [];
    byDomain.set(s.trackingDomain, [...list, { url: s.url, status: scripts[s.url] ?? null }]);
  }
  return [...byDomain.entries()].map(([trackingDomain, variants]) => {
    const checkedVariants = variants.filter((v) => v.status !== null);
    const foundOn = checkedVariants.filter((v) => scriptFound(v.status)).map((v) => v.url);
    const site = (variants[0]?.url || '').replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '');
    const found = foundOn.length > 0;
    const inconclusive = checkedVariants.length > 0 && checkedVariants.every((v) => !conclusive(v.status));
    const timedOut = inconclusive && checkedVariants.every((v) => /TIMEOUT/i.test(String(v.status)));
    const checked = checkedVariants.some((v) => conclusive(v.status));
    const host = site.toLowerCase();
    const visited = !found && checked && [...visitedSet].some((v) => v === host || v.endsWith(`.${host}`));
    return { trackingDomain, site, variants, checked, inconclusive, timedOut, found, visited, foundOn };
  });
}

/** The Script present tile's numbers. */
export function siteSummary(groups) {
  return {
    checked: groups.filter((g) => g.checked).length,
    ok: groups.filter((g) => g.found || g.visited).length,
    missing: groups.filter((g) => g.checked && !g.found && !g.visited).length,
    unsure: groups.filter((g) => g.visited || (g.inconclusive && !g.checked)).length,
    inconclusive: groups.filter((g) => g.inconclusive && !g.checked).length,
  };
}

/* ---------------- the checks ---------------- */

/** The overall params status from its channels: any rows -> ok; ran but nothing -> empty; else failed before skipped. */
export function paramsStatus(results) {
  const statuses = results.map((c) => c.status);
  if (statuses.includes('ok')) return { status: 'ok' };
  if (statuses.includes('empty')) return { status: 'empty' };
  if (statuses.includes('failed')) return { status: 'failed', reason: results.filter((c) => c.error).map((c) => `${c.type}: ${c.error}`).join(' · ') };
  return { status: 'skipped', reason: 'time budget' };
}

const scriptFailure = (err, timeoutMs) => (isTimeout(err)
  ? `HYROS did not answer within ${Math.round(timeoutMs / 1000)}s (the check fetches every page live)`
  : err?.message || 'HYROS did not answer');

/**
 * Run the four checks in series and report after each step.
 * `onUpdate(h)` runs after every step (and every script batch) with the
 * current block; the returned block is the final one, with `stopped: true`
 * when a newer render took over.
 */
export async function runChecks(data, { hasGoogle, today, deadline, isCurrent = () => true, onUpdate = () => {} }) {
  const h = {
    domains: [], sites: [], scripts: {}, visitedHosts: [], trackingParams: [],
    checks: { domains: PENDING, params: hasGoogle ? PENDING : skipped('no Google ad accounts connected'), script: PENDING, visits: PENDING },
  };
  const outOfTime = () => Date.now() >= deadline;
  const timeoutMs = () => clampTimeout(TIMEOUTS.default, deadline);
  const stop = () => ({ ...h, stopped: true });

  // 1. Domains.
  if (!isCurrent()) return stop();
  if (outOfTime()) {
    h.checks.domains = skipped('time budget');
  } else {
    const r = await timed(() => data.cached('health:domains', () => data.call('hyros_get_domains', {}, { timeoutMs: timeoutMs() })));
    if (r.error) h.checks.domains = failed(r.error.message || 'HYROS did not answer', r.ms);
    else {
      const domains = readDomains(r.value);
      if (!domains) h.checks.domains = failed('unexpected reply shape', r.ms);
      else { h.domains = domains; h.checks.domains = domains.length ? ok(r.ms) : empty(r.ms); }
    }
  }
  onUpdate(h);

  // 2. Google tracking parameters, one channel at a time.
  if (hasGoogle) {
    const results = [];
    for (const type of GOOGLE_CHANNELS) {
      if (!isCurrent()) return stop();
      if (outOfTime()) { results.push({ type, status: 'skipped', ms: 0 }); continue; }
      const r = await timed(() => data.cached(`health:params:${type}`, () => data.call('hyros_check_tracking_parameters_for_integrations', { request: { type } }, { timeoutMs: timeoutMs() })));
      if (r.error) { results.push({ type, status: 'failed', error: r.error.message || 'HYROS did not answer', ms: r.ms }); continue; }
      const rows = readParamRows(r.value);
      if (!rows) results.push({ type, status: 'failed', error: 'unexpected reply shape', ms: r.ms });
      else results.push({ type, rows, status: rows.length ? 'ok' : 'empty', ms: r.ms });
    }
    h.trackingParams = results.filter((c) => c.rows).map(({ type, rows }) => ({ type, rows }));
    h.checks.params = { ...paramsStatus(results), ms: results.reduce((sum, c) => sum + (c.ms || 0), 0), channels: Object.fromEntries(results.map((c) => [c.type, c.status])) };
    onUpdate(h);
  }

  // 3. Script presence, batches of 3 URLs in series, last of the three checks.
  if (!isCurrent()) return stop();
  if (h.checks.domains.status === 'failed') h.checks.script = skipped('domains check failed');
  else if (!h.domains.length) h.checks.script = skipped(h.checks.domains.status === 'skipped' ? 'time budget' : 'no verified domains');
  else if (!siteTargets(h.domains).length) h.checks.script = skipped('no verified domains');
  else {
    h.sites = siteTargets(h.domains);
    let checked = 0;
    let ms = 0;
    let why = null;
    for (let i = 0; i < h.sites.length; i += MAX_URLS_PER_CALL) {
      if (!isCurrent()) return stop();
      if (deadline - Date.now() < SLOW_MIN_LEFT_MS) { why = 'time budget'; break; }
      const urls = h.sites.slice(i, i + MAX_URLS_PER_CALL).map((x) => x.url);
      const slow = clampTimeout(TIMEOUTS.slow, deadline);
      const r = await timed(() => data.cached(`health:script:${urls.join(',')}`, () => data.call('hyros_assert_script_presence_on_domain', { request: { domains: urls } }, { timeoutMs: slow })));
      ms += r.ms || 0;
      if (r.error) { why = scriptFailure(r.error, slow); break; }
      const got = readScripts(r.value);
      if (!got) { why = 'unexpected reply shape'; break; }
      h.scripts = { ...h.scripts, ...got };
      checked += urls.length;
      if (checked < h.sites.length) { h.checks.script = { ...PENDING, ms, reason: `checked ${checked} of ${h.sites.length} URLs` }; onUpdate(h); }
    }
    const unchecked = h.sites.slice(checked).map((x) => x.url);
    const capped = siteTargets(h.domains, Infinity).length - h.sites.length;
    const capNote = capped > 0 ? `; ${capped} more URLs over the ${MAX_SITE_URLS}-URL cap` : '';
    if (!checked) h.checks.script = why && why !== 'time budget' ? failed(why, ms) : { ...skipped(why || 'time budget'), unchecked };
    else {
      const base = Object.keys(h.scripts).length ? ok(ms) : empty(ms);
      h.checks.script = checked < h.sites.length
        ? { ...base, reason: `checked ${checked} of ${h.sites.length} URLs; the rest: ${why || 'time budget'}${capNote}`, unchecked }
        : (capNote ? { ...base, reason: capNote.slice(2) } : base);
    }
  }
  onUpdate(h);

  // 4. Visits, only when some URL did not answer with the script.
  if (!isCurrent()) return stop();
  const misses = Object.values(h.scripts).filter((st) => !scriptFound(st));
  if (!misses.length) h.checks.visits = skipped(Object.keys(h.scripts).length ? 'every checked URL has the script' : 'no script results to confirm');
  else if (outOfTime()) h.checks.visits = skipped('time budget');
  else {
    const leads = await timed(() => data.cached('health:leads', () => data.call('hyros_get_leads', { request: { pageSize: MAX_CLICK_LEADS } }, { timeoutMs: timeoutMs() })));
    const leadIds = leads.error ? [] : listOf(leads.value).filter((l) => l?.id && !l.originLead).map((l) => String(l.id)).slice(0, MAX_CLICK_LEADS);
    if (leads.error) h.checks.visits = failed(leads.error.message || 'HYROS did not answer', leads.ms);
    else if (!leadIds.length) h.checks.visits = skipped('no recent leads to read visits from');
    else if (!isCurrent()) return stop();
    else if (outOfTime()) h.checks.visits = skipped('time budget');
    else {
      const fromDate = addDays(today, -VISIT_DAYS);
      const r = await timed(() => data.cached(`health:clicks:${fromDate}`, () => data.pagedInfo('hyros_get_lead_clicks',
        { request: { leadIds, fromDate } },
        { maxPages: MAX_CLICK_PAGES, pageSize: 250, deadline, timeoutMs: timeoutMs() })));
      const ms = leads.ms + r.ms;
      if (r.error) h.checks.visits = failed(r.error.message || 'HYROS did not answer', ms);
      else {
        const hosts = new Set();
        for (const c of r.value?.rows || []) { const host = hostOf(c?.page || c?.trackedUrl || c?.url); if (host) hosts.add(host); }
        h.visitedHosts = [...hosts].sort();
        const cut = r.value?.truncated ? `newest ${r.value.rows.length} clicks read` : null;
        h.checks.visits = { ...(h.visitedHosts.length ? ok(ms) : empty(ms)), ...(cut ? { reason: cut } : {}) };
      }
    }
  }
  onUpdate(h);
  return h;
}

export const hasGoogleAccount = (adAccounts) => (adAccounts || []).some((a) => GOOGLE_TYPES.has(String(a?.type || '').toUpperCase()));
