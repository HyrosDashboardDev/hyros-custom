/**
 * The Performance Report's level model, copied from hyros-ai (api/_snapshot.js)
 * so the rows match the ones it rendered.
 *
 * The level model mirrors HYROS's own (SourceNamingUtils.ts). For Meta:
 *   AD_ACCOUNT      -> "Account"
 *   SOURCE_CATEGORY -> "Campaign"     <- NOT a Meta campaign object
 *   SOURCE_LINK     -> "Ad Set"       <- the MCP's FACEBOOK_ADSET level
 *   SOURCE_LINK_AD  -> "Ad"           <- the MCP's FACEBOOK_AD level
 *
 * The MCP exposes no campaign/traffic-source grouping, so those two levels are
 * rolled up from the ad-set base table joined to `hyros_get_sources`, which
 * carries `category` and `trafficSource` per source.
 */

import { ymdInTz, addDays } from '../core/dates.js';
import { CATALOG, derive, rollup } from './metrics.js';

// Request the whole catalog except switched-off metrics: the `fields` param
// drives computation (requested fields populate, unrequested come back null),
// which makes column-adding instant client-side instead of per-refresh.
export const REPORT_FIELDS = ['NAME', 'PARENT_NAME', ...CATALOG.filter((c) => !c.off).map((c) => c.f)];

/* ---------------- date helpers (account timezone) ---------------- */

/** Ranges are YYYY-MM-DD in the account timezone ("-05:00", "UTC", "America/New_York", ...: see src/core/dates.js). */
export function buildRanges(now, tz) {
  const today = ymdInTz(now, tz);
  return {
    today:     { label: 'Today',        start: today,             end: today },
    yesterday: { label: 'Yesterday',    start: addDays(today, -1), end: addDays(today, -1) },
    '7d':      { label: 'Last 7 days',  start: addDays(today, -6), end: today },
    '30d':     { label: 'Last 30 days', start: addDays(today, -29), end: today },
  };
}

/* ---------------- normalisation ---------------- */

/**
 * Keep every catalog metric the API populated (null = not computed, dropped),
 * guarantee the core additive base exists so derived math is stable, then
 * re-derive. Null-stripping keeps the stored snapshot far smaller than the
 * wire payload even with the full catalog requested.
 */
const CORE_ZERO = ['cost', 'revenue', 'totalRevenue', 'sales', 'leads',
  'calls', 'clicks', 'impressions', 'reported'];

export function normalizeRow(raw) {
  const row = {
    id: String(raw.id ?? ''),
    name: raw.name || null,
    parentName: raw.parentName || null,
    // Ad-level rows carry the parent source id since the Sept 2026 MCP
    // upgrade: the handle that makes ad-under-ad-set linkage exact.
    parentId: raw.parentId != null ? String(raw.parentId) : null,
  };
  for (const entry of CATALOG) {
    const v = entry.k === 'reported' ? raw.reportedResult : raw[entry.k];
    if (v !== null && v !== undefined) row[entry.k] = v;
  }
  for (const k of CORE_ZERO) row[k] = row[k] ?? 0;
  return derive(row);
}

/**
 * Report levels per ad-account type, named as the MCP's `level` enum names
 * them (api-docs.hyros.com, GET /attribution). `adset` is the SOURCE_LINK
 * level every platform has; `ad` exists only where the platform exposes one.
 * Classic Google and LinkedIn are tracked at campaign level, Google V2 stops
 * at ad group, Snapchat calls its ad set an "ad squad". Types missing here
 * (REDDIT, APPLOVIN, WHOP_ADS, ...) have no attribution level and are skipped.
 */
export const LEVELS_BY_TYPE = {
  FACEBOOK:  { adset: 'FACEBOOK_ADSET',    ad: 'FACEBOOK_AD' },
  GOOGLE:    { adset: 'GOOGLE_CAMPAIGN',   ad: 'GOOGLE_AD' },
  GOOGLE_V2: { adset: 'GOOGLE_V2_ADGROUP', ad: null },
  TIKTOK:    { adset: 'TIKTOK_ADGROUP',    ad: 'TIKTOK_AD' },
  // The live MCP (mcp.hyros.com) names this level SNAPCHAT_ADSET; the REST docs say snapchat_adsquad. Its accepted list (from the error text, 2026-09-21): GOOGLE_CAMPAIGN, GOOGLE_ADGROUP, GOOGLE_AD, GOOGLE_KEYWORD, FACEBOOK_ADSET, FACEBOOK_CAMPAIGN, TIKTOK_ADGROUP, SNAPCHAT_ADSET, PINTEREST_ADGROUP, TWITTER_ADGROUP, BING_ADGROUP, FACEBOOK_AD, TIKTOK_AD, SNAPCHAT_AD, PINTEREST_AD, TWITTER_AD, BING_AD, LINKEDIN_CAMPAIGN, LINKEDIN_AD, GOOGLE_V2_KEYWORD, GOOGLE_V2_ADGROUP, GOOGLE_V2_AD, GOOGLE_V2_CAMPAIGN. Accepted is not the same as supported per integration (classic GOOGLE rejects GOOGLE_ADGROUP), so the single-level rows stay.
  SNAPCHAT:  { adset: 'SNAPCHAT_ADSET',     ad: 'SNAPCHAT_AD' },
  PINTEREST: { adset: 'PINTEREST_ADGROUP', ad: 'PINTEREST_AD' },
  TWITTER:   { adset: 'TWITTER_ADGROUP',   ad: null },
  BING:      { adset: 'BING_ADGROUP',      ad: 'BING_AD' },
  LINKEDIN:  { adset: 'LINKEDIN_CAMPAIGN', ad: null },
};

export const REPORT_MODELS = ['LAST_CLICK', 'FIRST_CLICK', 'SCIENTIFIC'];

/* ---------------- level assembly ---------------- */

/**
 * Build all five report levels for one range from the ad-set + ad base tables.
 * `sourceById` maps an ad-set (source-link) id to its source metadata.
 */
export function buildLevels({ adsetRows, adRows, sourceById, adAccountName }) {
  // Ad-set rows sometimes come back with a null name; resolve from the source
  // table, and carry the source TAG: it's the handle the lead-drill uses
  // (get_leads({tags:[...]}) is a server-side cohort query).
  const adsets = adsetRows.map((r) => ({
    ...r,
    name: r.name || sourceById.get(r.id)?.name || r.id,
    tag: sourceById.get(r.id)?.tag || null,
    _category: sourceById.get(r.id)?.category || 'Uncategorised',
    _traffic: sourceById.get(r.id)?.trafficSource || 'unknown',
    // The view stamps `_account` from the call; the source join is the fallback.
    _account: r._account || sourceById.get(r.id)?.adAccountId || null,
  }));

  const ads = adRows.map((r) => ({ ...r, name: r.name || r.id }));

  // Rolled-up rows drill with the union of their members' tags (the tags
  // filter on get_leads is OR semantics).
  const withTags = (rows, keyOf) => rows.map((row) => ({
    ...row,
    tags: [...new Set(adsets.filter((a) => keyOf(a) === row.id && a.tag).map((a) => a.tag))].slice(0, 40),
  }));

  return {
    traffic:  withTags(rollup(adsets, (r) => r._traffic, (id) => id), (a) => a._traffic),
    account:  withTags(rollup(adsets, (r) => r._account, (id) => adAccountName.get(id) || id || 'Unknown'), (a) => a._account),
    campaign: withTags(rollup(adsets, (r) => r._category, (id) => id), (a) => a._category),
    adset:    adsets,
    ad:       ads,
  };
}
