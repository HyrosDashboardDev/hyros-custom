/**
 * The Performance Report's level model, copied from hyros-ai (api/_snapshot.js)
 * so the rows match the ones it rendered.
 *
 * The level model mirrors HYROS's own (SourceNamingUtils.ts). For Meta:
 *   AD_ACCOUNT      -> "Account"
 *   SOURCE_CATEGORY -> "Campaign"     <- NOT a Meta campaign object
 *   SOURCE_LINK     -> "Ad Set"       <- GET /attribution level facebook_adset
 *   SOURCE_LINK_AD  -> "Ad"           <- GET /attribution level facebook_ad
 *
 * GET /attribution has no campaign/traffic-source grouping over ad-account
 * ids, so those two levels are rolled up from the ad-set base table joined to
 * GET /sources, which carries `category` and `trafficSource` per source.
 */

import { ymdInTz, addDays } from '../core/dates.js';
import { CATALOG, derive, rollup } from './metrics.js';

// Request the whole catalog except switched-off metrics: the `fields` param
// drives computation (requested fields populate, unrequested are left out),
// which makes column-adding instant client-side instead of per-refresh.
export const REPORT_FIELDS = ['name', 'parent_name', ...CATALOG.filter((c) => !c.off).map((c) => c.f)];

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
 * The key GET /attribution publishes a catalog metric under. The API writes
 * its row property names through camelToSnakeCaseWithNumber (totalRevenue ->
 * total_revenue, newMRR -> new_m_r_r, ltv30Days -> ltv_30_days), except
 * contributionProfit, published as declared. `reported` is the
 * reportedResult property.
 */
const WIRE_KEY = { reported: 'reported_result', contributionProfit: 'contributionProfit' };
export const wireKey = (k) => WIRE_KEY[k] ?? k.replace(/([A-Z]|[0-9]+)/g, '_$1').toLowerCase();
const CATALOG_WIRE = CATALOG.map((entry) => [entry.k, wireKey(entry.k)]);

/** A metric as a number: `revenue` comes as a string ("997.00"); null, missing or unreadable stay null. */
function metric(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Read one GET /attribution row into the camelCase catalog keys. Keep every
 * catalog metric the API populated (null = not computed, dropped), guarantee
 * the core additive base exists so derived math is stable, then re-derive.
 * Null-stripping keeps the stored snapshot far smaller than the wire payload
 * even with the full catalog requested.
 */
const CORE_ZERO = ['cost', 'revenue', 'totalRevenue', 'sales', 'leads',
  'calls', 'clicks', 'impressions', 'reported'];

export function normalizeRow(raw) {
  const row = {
    id: String(raw.id ?? ''),
    name: raw.name || null,
    parentName: raw.parent_name || null,
    // Ad-level rows carry the parent source id: the handle that makes
    // ad-under-ad-set linkage exact.
    parentId: raw.parent_id != null ? String(raw.parent_id) : null,
  };
  for (const [k, wire] of CATALOG_WIRE) {
    const v = metric(raw[wire]);
    if (v !== null) row[k] = v;
  }
  for (const k of CORE_ZERO) row[k] = row[k] ?? 0;
  return derive(row);
}

/**
 * Report levels per ad-account type, as the `level` param of GET /attribution
 * names them (lowercase, matched exactly: api-docs.hyros.com). `adset` is the
 * SOURCE_LINK level and `ad` the SOURCE_LINK_AD level; an ad row's `parent_id`
 * is the id of its ad set, the id the `adset` level and GET /sources use.
 * Classic Google and LinkedIn are tracked at campaign level, so their ads hang
 * from the campaign. Snapchat calls its ad set an "ad squad" (snapchat_adsquad;
 * snapchat_adset is rejected). A type with `ad: null` would report at ad-set
 * level only. The API accepts more levels than each integration supports
 * (classic Google rejects google_adgroup), so the single-level rows stay. Types
 * missing here (REDDIT, APPLOVIN, WHOP_ADS, ...) have no attribution level and
 * are skipped.
 */
export const LEVELS_BY_TYPE = {
  FACEBOOK:  { adset: 'facebook_adset',    ad: 'facebook_ad' },
  GOOGLE:    { adset: 'google_campaign',   ad: 'google_ad' },
  GOOGLE_V2: { adset: 'google_v2_adgroup', ad: 'google_v2_ad' },
  TIKTOK:    { adset: 'tiktok_adgroup',    ad: 'tiktok_ad' },
  SNAPCHAT:  { adset: 'snapchat_adsquad',  ad: 'snapchat_ad' },
  PINTEREST: { adset: 'pinterest_adgroup', ad: 'pinterest_ad' },
  TWITTER:   { adset: 'twitter_adgroup',   ad: 'twitter_ad' },
  BING:      { adset: 'bing_adgroup',      ad: 'bing_ad' },
  LINKEDIN:  { adset: 'linkedin_campaign', ad: 'linkedin_ad' },
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
  // (GET /leads?tags=... is a server-side cohort query).
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
  // filter of GET /leads is OR semantics).
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
