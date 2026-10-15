/**
 * Raw HYROS rows into the CRM's rows, and the aggregation answers into
 * tile numbers. Pure. Shapes ported from hyros-ai `api/_snapshot.js`
 * (`flattenSource`, `buildCrm`), without the per-lead income join.
 */
import { parseHyrosDate, offsetSuffix } from '../../core/dates.js';
import { priceOf } from '../../ui/drill.js';

/** ISO for any HYROS date; a legacy date with an unknown zone takes the account offset. */
export function isoFor(tz) {
  const fallback = offsetSuffix(tz);
  return (v) => parseHyrosDate(v, fallback);
}

const ms = (iso) => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? t : null;
};

const personName = (p) => [p?.firstName, p?.lastName].filter(Boolean).join(' ').trim() || null;

export function flattenSource(src, iso) {
  if (!src) return null;
  return {
    name: src.name || null,
    tag: src.tag || null,
    organic: Boolean(src.organic),
    trafficSource: src.trafficSource?.name || null,
    category: src.category?.name || null,
    clickDate: iso(src.clickDate),
  };
}

export function leadRow(l, iso) {
  const first = flattenSource(l.firstSource, iso);
  const last = flattenSource(l.lastSource, iso);
  const joined = iso(l.creationDate);
  const tags = Array.isArray(l.tags) ? l.tags.map(String) : [];
  return {
    id: l.id ?? null,
    email: l.email || '',
    name: personName(l),
    joined,
    joinedMs: ms(joined),
    stage: l.currentStage?.name || null,
    consent: l.adOptimizationConsent && l.adOptimizationConsent !== 'UNSPECIFIED' ? String(l.adOptimizationConsent) : null,
    tags,
    tagList: tags.join(', ') || null,
    firstSource: first,
    lastSource: last,
    firstSourceName: first?.name || null,
    lastSourceName: last?.name || null,
    lastSourceDate: last?.clickDate || null,
    lastSourceMs: ms(last?.clickDate),
    hasAttribution: Boolean(first || last),
  };
}

export function saleRow(s, iso) {
  const date = iso(s.creationDate);
  return {
    id: s.id ?? null,
    email: s.lead?.email || '',
    leadName: personName(s.lead),
    date,
    dateMs: ms(date),
    ...priceOf(s),
    product: s.product?.name || null,
    recurring: Boolean(s.recurring),
    refunded: Boolean(s.refundDate),
    refundDate: iso(s.refundDate),
    firstSource: s.firstSource?.name || null,
    lastSource: s.lastSource?.name || null,
  };
}

export function callRow(c, iso) {
  const date = iso(c.creationDate);
  return {
    id: c.id ?? null,
    email: c.lead?.email || '',
    leadName: personName(c.lead),
    date,
    dateMs: ms(date),
    name: c.name || c.tag || null,
    state: c.state || (c.qualified ? 'QUALIFIED' : 'UNQUALIFIED'),
    qualified: Boolean(c.qualified),
    firstSource: c.firstSource?.name || null,
    ad: c.firstSource?.sourceLinkAd?.name || c.lastSource?.sourceLinkAd?.name || null,
    lastSource: c.lastSource?.name || null,
  };
}

export function subscriptionRow(x, iso) {
  const date = iso(x.startDate || x.creationDate);
  const price = priceOf(x);
  const provider = x.provider?.integration?.name || (typeof x.provider === 'string' ? x.provider : null);
  return {
    id: x.id || x.subscriptionId || null,
    email: x.lead?.email || x.email || '',
    leadName: personName(x.lead),
    date,
    dateMs: ms(date),
    endDate: iso(x.endDate),
    name: x.name || x.planId || null,
    price: price.amount,
    currency: price.currency,
    periodicity: x.periodicity || null,
    status: x.status || null,
    provider,
  };
}

/** The rows of `tab` from the raw list. Leads merged into another (`originLead`) are dropped. */
export function shapeRows(tab, raw, tz) {
  const iso = isoFor(tz);
  const list = Array.isArray(raw) ? raw : [];
  if (tab === 'leads') return list.filter((l) => l && !l.originLead).map((l) => leadRow(l, iso));
  if (tab === 'sales') return list.filter(Boolean).map((s) => saleRow(s, iso));
  if (tab === 'calls') return list.filter(Boolean).map((c) => callRow(c, iso));
  return list.filter(Boolean).map((x) => subscriptionRow(x, iso));
}

const num = (v) => {
  const n = Number(v);
  return v !== null && v !== undefined && v !== '' && Number.isFinite(n) ? n : null;
};

/**
 * An aggregation answer `{ groups: [{ key, count, details? }], remainingCount, totalCount }`
 * read tolerantly. `grouped` is the sum of the returned groups; it is NOT a
 * total (a row without the attribute is in no group). `revenueUsd` sums
 * `details.revenue.amount` (sales only; null when no group carries it).
 */
export function readAggregation(body) {
  const b = body && !Array.isArray(body) && body.result && !body.groups ? body.result : body;
  const groups = (Array.isArray(b?.groups) ? b.groups : []).map((g) => ({
    key: g?.key == null ? '' : String(g.key),
    count: num(g?.count) || 0,
    revenue: num(g?.details?.revenue?.amount),
  }));
  const withRevenue = groups.filter((g) => g.revenue !== null);
  return {
    total: num(b?.totalCount),
    remaining: num(b?.remainingCount) || 0,
    grouped: groups.reduce((s, g) => s + g.count, 0),
    groups: groups.map(({ key, count }) => ({ key, count })),
    revenueUsd: withRevenue.length ? withRevenue.reduce((s, g) => s + g.revenue, 0) : null,
  };
}

/** Rows that sit in some group: the groups plus the ones past `groupsLimit`. Only for attributes with one value per row. */
export const inSomeGroup = (agg) => (agg ? agg.grouped + agg.remaining : null);

/** The count of one group, matched without case; 0 when the group is absent. */
export function groupCount(agg, key) {
  if (!agg) return null;
  const k = String(key).toLowerCase();
  return agg.groups.filter((g) => g.key.toLowerCase() === k).reduce((s, g) => s + g.count, 0);
}
