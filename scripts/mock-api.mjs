/**
 * Mock HYROS customer API: answers the read paths of `/api/v1.0` with
 * synthetic payloads in the shapes the real API returns.
 *
 *   node scripts/mock-api.mjs            # listens on :4322, base url http://127.0.0.1:4322/api/v1.0
 *
 * Auth is `Authorization: Bearer <token>`, like the dashboard sends it. A
 * missing bearer or the token `dead-token` answers 401 with a plain-text
 * `Unauthorized`, the way the real API does.
 *
 * Every request is logged in `calls` as { path, params, token } so a test can
 * assert WHAT the client asked for and with which credential. `params` holds
 * the query string as sent; `list(params.x)` splits an array parameter.
 *
 * The exported `mock` control object lets a test bend the server the way the
 * real one misbehaves (api-docs.hyros.com): HTTP 429 with `Retry-After`,
 * HTTP 403 for a missing role, multi-page results, an expired cursor on
 * page 2, latency, a different ad-account list and a different user timezone.
 */
import { createServer } from 'node:http';

const PORT = Number(process.env.MOCK_API_PORT) || 4322;
const BASE = '/api/v1.0';
export const calls = [];

/** A 400 the way the API answers a request it rejects: `{ result: 'ERROR', message: [...] }`. */
class BadRequest extends Error {}

/** An array parameter: one value, comma-separated, as the API reads it. */
export const list = (value) => (value ? String(value).split(',') : []);

/**
 * Test controls. Everything resets with `mock.reset()`.
 *   mock.failNext({ path, status, body, retryAfter, times })  HTTP-level failure(s) for the next call(s)
 *   mock.pages(path, n, size)     serve n pages of `size` rows with nextPageId
 *   mock.expireCursorOn(path)     400 "pageId ... expired" as soon as a pageId is sent
 *   mock.latencyMs = 4000         delay every call (number) or per path ({ '/leads': ms })
 *   mock.adAccounts = []          replace the ad-account list
 *   mock.timezone = 'America/New_York'   userProfile.timezone
 *   mock.now = Date.parse('2026-09-14T12:00:00Z')   the mock's clock for the
 *       report's "cannot be in the future" check (null = the real clock);
 *       kept across reset() so a test sets it once next to its build `now`
 */
export const mock = {
  failures: [],
  paged: {},
  expiredCursors: new Set(),
  latencyMs: 0,
  adAccounts: null,
  timezone: null,
  now: null,
  failNext(spec) { this.failures.push({ times: 1, ...spec }); },
  pages(path, n, size = 250) { this.paged[path] = { n, size }; },
  expireCursorOn(path) { this.expiredCursors.add(path); },
  reset() {
    this.failures = []; this.paged = {}; this.expiredCursors = new Set();
    this.latencyMs = 0; this.adAccounts = null; this.timezone = null;
  },
};

// Ad accounts of every type the real API reports, plus one that is connected
// but broken (9007) so the pipeline's per-account isolation is exercised.
const AD_ACCOUNTS = [
  { id: '9001', name: 'Mock Meta', type: 'FACEBOOK' },
  { id: '9002', name: 'Mock Google', type: 'GOOGLE' },
  { id: '9003', name: 'Mock Snap', type: 'SNAPCHAT' },
  { id: '9004', name: 'Mock LinkedIn', type: 'LINKEDIN' },
  { id: '9005', name: 'Mock Google V2', type: 'GOOGLE_V2' },
  { id: '9006', name: 'Mock Reddit', type: 'REDDIT' },
  { id: '9007', name: 'Mock TikTok (broken)', type: 'TIKTOK' },
];
const adAccounts = () => mock.adAccounts ?? AD_ACCOUNTS;

// The `level` enum of GET /attribution (api-docs.hyros.com), per integration,
// matched exactly: the API takes its lowercase names only.
const LEVELS_FOR = {
  FACEBOOK: ['facebook_campaign', 'facebook_adset', 'facebook_ad'],
  GOOGLE: ['google_campaign', 'google_ad'],
  GOOGLE_V2: ['google_v2_adgroup', 'google_v2_ad', 'google_v2_keyword'],
  TIKTOK: ['tiktok_adgroup', 'tiktok_ad'],
  SNAPCHAT: ['snapchat_adsquad', 'snapchat_ad'],
  PINTEREST: ['pinterest_adgroup', 'pinterest_ad'],
  TWITTER: ['twitter_adgroup', 'twitter_ad'],
  BING: ['bing_adgroup', 'bing_ad'],
  LINKEDIN: ['linkedin_campaign', 'linkedin_ad'],
  REDDIT: [],
};

const ADSETS = [
  { id: 'as-1', name: 'Prospecting Broad', tag: '@as-1', category: 'Prospecting', cost: 900, revenue: 3200, sales: 24, leads: 80, clicks: 1200 },
  { id: 'as-2', name: 'Powerset', tag: '@as-2', category: 'Retargeting', cost: 300, revenue: 1800, sales: 15, leads: 30, clicks: 400 },
  { id: 'as-3', name: 'Powerset', tag: '@as-3', category: 'Prospecting', cost: 250, revenue: 500, sales: 4, leads: 22, clicks: 350 },
];
const ADS = [
  { id: 'ad-1', name: 'UGC Hook', parentId: 'as-1', parentName: 'Prospecting Broad', cost: 600, revenue: 2400, sales: 18, leads: 55, clicks: 800 },
  { id: 'ad-2', name: 'Static Offer', parentId: 'as-1', parentName: 'Prospecting Broad', cost: 300, revenue: 800, sales: 6, leads: 25, clicks: 400 },
  { id: 'ad-3', name: 'Carousel', parentId: 'as-2', parentName: 'Powerset', cost: 300, revenue: 1800, sales: 15, leads: 30, clicks: 400 },
  { id: 'ad-4', name: 'Founder Story', parentId: 'as-3', parentName: 'Powerset', cost: 250, revenue: 500, sales: 4, leads: 22, clicks: 350 },
];

/** `camelToSnakeCaseWithNumber` of the attribution marshaller: parentName -> parent_name, ltv30Days -> ltv_30_days. */
const snake = (key) => key.replace(/([A-Z]|[0-9]+)/g, '_$1').toLowerCase();

/**
 * An attribution row as GET /attribution publishes it: snake_case keys,
 * `revenue` as a two-decimal string, contributionProfit under its declared name.
 */
const attributionRow = (row) => Object.fromEntries(Object.entries(row).map(([k, v]) => {
  if (k === 'revenue') return [k, Number(v).toFixed(2)];
  return [k === 'contributionProfit' ? k : snake(k), v];
}));

// GET /attribution matches these exactly (lowercase API names). The real API
// reads an unknown sourceConfiguration as ignore_organic without a word; the
// mock refuses it so a wrong spelling shows up in development.
const ATTRIBUTION_MODELS = ['first_click', 'last_click', 'scientific'];
const CURVE_PARAMS = ['id', 'level', 'startDate', 'endDate', 'ltvWindow', 'cacCeiling', 'attributionModel'];
const SOURCE_CONFIGURATIONS = ['all_sources', 'include_organic', 'only_organic', 'only_paid', 'prioritize_organic', 'ignore_organic', 'prioritize_paid'];

// Leads as GET /leads publishes them: dates in the account's timezone.
const lead = (i, joined, updated, stage = 'Lead') => ({
  id: `lead-${i}`, email: `lead${i}@example.test`, firstName: `Lead`, lastName: String(i),
  creationDate: joined, lastUpdatedDate: updated, tags: ['!site', '@as-1'],
  currentStage: { name: stage, date: updated }, adOptimizationConsent: 'GRANTED',
  firstSource: { name: 'Prospecting Broad', tag: '@as-1', organic: false, clickDate: joined },
  lastSource: { name: 'Prospecting Broad', tag: '@as-1', organic: false, clickDate: joined },
  phoneNumbers: [],
});

// Sales as GET /sales publishes them: `creationDate` in the legacy
// `EEE MMM dd HH:mm:ss zzz yyyy` format, a `price` object and a `usdPrice`
// one. s1 keeps an ISO date so both readers stay tested.
const SALES = [
  { id: 's1', lead: { email: 'lead1@example.test', firstName: 'Lead', lastName: '1' }, creationDate: '2026-09-05T12:00:00-05:00', usdPrice: { price: 160, currency: 'USD' }, price: { price: 149, currency: 'USD' }, product: { name: 'Bundle' }, firstSource: { name: 'Prospecting Broad' }, lastSource: { name: 'Prospecting Broad' } },
  { id: 's2', lead: { email: 'lead2@example.test', firstName: 'Lead', lastName: '2' }, creationDate: 'Thu Jul 02 01:10:33 ART 2026', price: { price: 89, currency: 'EUR' }, product: { name: 'Starter' }, firstSource: { name: 'Powerset' }, lastSource: { name: 'Powerset' } },
];

const aggregation = (groups) => ({ result: { groups, totalCount: groups.reduce((n, g) => n + g.count, 0), remainingCount: 0 } });

// Parameters the aggregations, the journey and the clicks accept (KNOWN_PARAMETERS
// of their request DTOs): anything else is a 400, the way the API answers it.
// The aggregations take no paging. The lists are strict on the API too; here they
// stay lenient so the client tests can send any parameter to them.
const LIST_PARAMS = ['ids', 'pageSize', 'pageId', 'fromDate', 'toDate'];
const LEAD_PARAMS = ['emails', 'tags', 'phones', 'stage', 'updatedFromDate', 'updatedToDate', 'tagFromDate', 'tagToDate'];
const CONVERSION_PARAMS = ['emails', 'leadIds', 'productTags', 'updatedFromDate', 'updatedToDate'];
const SALE_PARAMS = [...CONVERSION_PARAMS, 'isRecurringSale', 'saleRefundedState'];
const CALL_PARAMS = [...CONVERSION_PARAMS, 'qualified', 'qualificationStages'];
const AGG_PARAMS = ['ids', 'fromDate', 'toDate', 'attribute', 'groupsLimit'];
function strict(q, known) {
  const unknown = Object.keys(q).filter((k) => !known.includes(k));
  if (unknown.length) throw new BadRequest(`Unknown parameters: ${unknown.join(', ')}`);
}
/** An aggregation's `attribute`: required, one of `allowed`, case-insensitive. */
function attributeOf(q, allowed) {
  const attribute = String(q.attribute || '').trim().toUpperCase();
  if (!attribute) throw new BadRequest('attribute is required');
  if (!allowed.includes(attribute)) throw new BadRequest(`Invalid attribute: ${q.attribute}`);
  const limit = q.groupsLimit === undefined ? 250 : Number(q.groupsLimit);
  if (!(limit >= 1 && limit <= 1000)) throw new BadRequest('groupsLimit must be between 1 and 1000');
  return attribute;
}

const ROUTES = {
  '/user-info': () => ({ result: {
    userProfile: { email: 'mock@hyros.test', timezone: mock.timezone || '-05:00' },
    trueTrackingData: { OUTBOUND_CURRENCY: 'USD', LEAD_ATTRIBUTION_TIMEFRAME: '7' },
    allowedAccounts: [{ accountId: 'agency-9', email: 'agency@example.test', companyName: 'Agency', status: 'APPROVED' }],
    accessibleAccounts: [],
  } }),
  '/ad-accounts': () => ({ result: adAccounts() }),
  '/sources': (q) => {
    const rows = [
      ...ADSETS.map((a) => ({
        name: a.name, tag: a.tag, category: { name: a.category }, trafficSource: { name: 'facebook' },
        adSource: { adSourceId: a.id, adAccountId: '9001', platform: 'FACEBOOK' }, creationDate: 1756800000000,
      })),
      // The real source list covers every connected platform, one per source link.
      ...adAccounts().filter((acct) => acct.id !== '9001').map((acct) => ({
        name: `${acct.name} row`, tag: `@${acct.id}-1`, category: { name: 'Prospecting' }, trafficSource: { name: acct.type.toLowerCase() },
        adSource: { adSourceId: `${acct.id}-1`, adAccountId: acct.id, platform: acct.type }, creationDate: 1756800000000,
      })),
    ];
    const ids = list(q.adSourceIds);
    if (ids.length > 50) throw new BadRequest('adSourceIds accepts at most 50 values');
    return { result: ids.length ? rows.filter((s) => ids.includes(s.adSource.adSourceId)) : rows };
  },
  '/attribution': (q) => {
    if (!q.startDate || !q.endDate) throw new BadRequest('startDate and endDate are required');
    // Only values that were sent are checked, so a bare probe still reaches the per-account answers below.
    if (q.attributionModel !== undefined && !ATTRIBUTION_MODELS.includes(q.attributionModel)) {
      throw new BadRequest(`Invalid attributionModel: ${q.attributionModel}`);
    }
    if (q.sourceConfiguration !== undefined && !SOURCE_CONFIGURATIONS.includes(q.sourceConfiguration)) {
      throw new BadRequest(`Invalid sourceConfiguration: ${q.sourceConfiguration}`);
    }
    // The live report rejects any bound after the current time (observed 2026-09-17).
    const clock = mock.now ?? Date.now();
    for (const bound of [q.startDate, q.endDate]) {
      const t = Date.parse(/[+-]\d\d:\d\d$|Z$/.test(bound) ? bound : `${bound}Z`);
      if (Number.isFinite(t) && t > clock) throw new BadRequest('startDate or endDate cannot be in the future.');
    }
    const acct = adAccounts().find((a) => a.id === list(q.ids)[0]);
    if (!acct) return { result: [] };
    const level = String(q.level || '');
    if (!(LEVELS_FOR[acct.type] || []).includes(level)) {
      throw new BadRequest(`Unsupported level type ${level} for user integration: ${acct.type}. Product ID: 1`);
    }
    if (acct.id === '9007') return { message: ['Ad account integration is disconnected'] };
    if (acct.id !== '9001') {
      // One row per non-Meta account so the pipeline can be seen to carry it.
      const row = { id: `${acct.id}-1`, name: `${acct.name} row`, cost: 100, revenue: 300, sales: 2, leads: 5, clicks: 50 };
      return { result: [attributionRow(/_ad$/.test(level) ? { ...row, id: `${acct.id}-ad-1`, parentId: row.id, parentName: row.name } : row)] };
    }
    const rows = /_ad$/.test(level) ? ADS : ADSETS;
    return { result: rows.map((r) => attributionRow({ ...r, impressions: r.clicks * 40, totalRevenue: r.revenue, reportedResult: r.revenue * 0.7, contributionProfit: r.revenue - r.cost })) };
  },
  '/stages': () => ({ result: [{ name: 'Lead', amount: 120 }, { name: 'Customer', amount: 40 }] }),
  '/leads': (q) => {
    if (q.updatedFromDate) {
      // Incremental pull: one changed lead (stage moved), one brand-new lead,
      // and one that was merged into lead-1 (the API marks it with originLead).
      return { result: [
        lead(1, '2026-09-02T10:00:00-05:00', '2026-09-13T09:00:00-05:00', 'Customer'),
        lead(9, '2026-09-13T08:00:00-05:00', '2026-09-13T08:00:00-05:00'),
        { ...lead(2, '2026-09-02T10:00:00-05:00', '2026-09-13T09:30:00-05:00'), originLead: { id: 'lead-1', email: 'lead1@example.test', isOriginLead: true } },
      ] };
    }
    if (q.tags) return { result: [lead(1, '2026-09-02T10:00:00-05:00', '2026-09-02T10:00:00-05:00')] };
    return { result: [1, 2, 3].map((i) => lead(i, `2026-09-0${i}T10:00:00-05:00`, `2026-09-0${i}T10:00:00-05:00`)) };
  },
  '/leads/aggregation': (q) => {
    strict(q, [...AGG_PARAMS, ...LEAD_PARAMS]);
    return attributeOf(q, ['TAG', 'STAGE', 'FIRST_SOURCE_TAG', 'LAST_SOURCE_TAG']) === 'STAGE'
      ? aggregation([{ key: 'Lead', count: 2 }, { key: 'Customer', count: 1 }])
      : aggregation([{ key: '@as-1', count: 3 }]);
  },
  '/sales': (q) => {
    // Incremental pull: s1 was refunded since, s3 is a new sale (lead-9).
    if (q.updatedFromDate) return { result: [
      { ...SALES[0], refundDate: '2026-09-13T09:00:00-05:00' },
      { id: 's3', lead: { email: 'lead9@example.test', firstName: 'Lead', lastName: '9' }, creationDate: '2026-09-13T08:30:00-05:00', price: { price: 50, currency: 'USD' }, product: { name: 'Starter' }, firstSource: { name: 'Powerset' }, lastSource: { name: 'Powerset' } },
    ] };
    return { result: SALES };
  },
  '/sales/aggregation': (q) => {
    strict(q, [...AGG_PARAMS, ...SALE_PARAMS]);
    attributeOf(q, ['FIRST_SOURCE_TAG', 'LAST_SOURCE_TAG']);
    return aggregation([{ key: '@as-1', count: 2, details: { revenue: { amount: 249 } } }]);
  },
  '/calls': (q) => (q.updatedFromDate
    ? { result: [{ id: 'call-9', lead: { email: 'lead9@example.test', firstName: 'Lead', lastName: '9' }, creationDate: 'Sun Sep 13 11:00:00 EST 2026', state: 'QUALIFIED', qualified: true }] }
    : { result: [] }),
  '/calls/aggregation': (q) => {
    strict(q, [...AGG_PARAMS, ...CALL_PARAMS]);
    attributeOf(q, ['FIRST_SOURCE_TAG', 'LAST_SOURCE_TAG', 'CALL_QUALIFICATION']);
    return aggregation([]);
  },
  '/subscriptions': () => ({ result: [] }),
  '/leads/journey': (q) => {
    strict(q, ['ids', 'emails', 'includeEvents', 'fields']);
    if (!q.emails && !q.ids) throw new BadRequest('emails or ids is required');
    if (list(q.ids).some((id) => !/^[0-9a-f]{64}$/i.test(id))) throw new BadRequest('Invalid id format: ids must be valid SHA-256 hashes');
    return { result: list(q.emails).map((email) => ({
      lead: lead(1, '2026-09-02T10:00:00-05:00', '2026-09-02T10:00:00-05:00'),
      sales: SALES.filter((s) => s.lead.email === email), calls: [], journey: [{ type: 'click', date: '2026-09-02T10:00:00-05:00', name: 'Prospecting Broad' }],
    })) };
  },
  '/leads/clicks': (q) => {
    strict(q, [...LIST_PARAMS, 'leadId', 'email', 'leadIds', 'emails']);
    const selectors = ['leadId', 'email', 'leadIds', 'emails'].filter((name) => q[name]);
    if (selectors.length !== 1) throw new BadRequest('Exactly one of leadId, email, leadIds or emails is required');
    return { result: [{ date: 'Thu Sep 02 10:00:00 EST 2026', page: 'https://mock.example.test/', sourceLinkName: 'Prospecting Broad', adspendType: 'FACEBOOK' }] };
  },
  // Documented shape (/attribution/marginal-cac-curve): spend levels in
  // ascending order, marginalCac null on the first bucket, saturationPoint as
  // efficient/saturated levels. Account level has no LTV: ceiling = caller's or none.
  '/attribution/marginal-cac-curve': (q) => {
    // Strict like the real endpoint: any other parameter is a 400.
    const unknown = Object.keys(q).filter((name) => !CURVE_PARAMS.includes(name));
    if (unknown.length) throw new BadRequest(`Unknown parameter: ${unknown.join(', ')}`);
    if (q.attributionModel !== undefined && !['first_click', 'last_click'].includes(String(q.attributionModel).toLowerCase())) {
      throw new BadRequest(`Invalid attributionModel: ${q.attributionModel}`);
    }
    const account = String(q.level).toLowerCase() === 'account';
    const caller = q.cacCeiling !== undefined;
    const cacCeiling = caller ? Number(q.cacCeiling) : (account ? null : 95);
    const levels = [20, 45, 70, 95, 120];
    return { result: {
      id: q.id, level: q.level, name: account ? null : `Mock ${q.level} ${q.id}`,
      startDate: q.startDate, endDate: q.endDate,
      attributionModel: 'FIRST_CLICK', daysSampled: 42, cacCeiling,
      ceilingBasis: caller ? 'CALLER_PROVIDED' : (account ? null : 'LTV_BREAKEVEN'),
      ltvWindow: !caller && !account ? '90_days' : null,
      curve: levels.map((spend, i) => ({ spendPerDay: spend, days: 8, newCustomers: Math.round((spend * 8) / (40 + spend * 0.3)), avgCac: 40 + spend * 0.3, marginalCac: i ? 40 + spend * 0.8 : null })),
      saturationPoint: cacCeiling === null ? null : { efficientSpendPerDay: 45, saturatedSpendPerDay: 70, reason: 'MARGINAL_CAC_ABOVE_CEILING' },
      notes: cacCeiling === null ? ['LTV_CEILING_UNAVAILABLE'] : [],
    } };
  },
};

/**
 * Pagination the way the documented list endpoints do it: `pageId` from the
 * previous `nextPageId`, absent on the last page, a 400 for a cursor the
 * server no longer knows. Rows are the route's first row cloned with unique ids.
 */
function paginate(path, q, body) {
  const spec = mock.paged[path];
  if (q.pageId && mock.expiredCursors.has(path)) throw new BadRequest('pageId is invalid or has expired');
  if (!spec || !Array.isArray(body?.result)) return body;
  const page = q.pageId ? Number(String(q.pageId).split(':')[1]) : 0;
  const base = body.result[0] || {};
  const rows = Array.from({ length: spec.size }, (_, i) => {
    const n = page * spec.size + i;
    return { ...base, id: `${base.id || path}-${n}`, ...(base.email ? { email: `p${n}-${base.email}` } : {}) };
  });
  return { result: rows, ...(page + 1 < spec.n ? { nextPageId: `${path}:${page + 1}` } : {}) };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const latencyFor = (path) => (typeof mock.latencyMs === 'number' ? mock.latencyMs : (mock.latencyMs?.[path] || 0));

/** An injected HTTP-level failure for this call, consumed from the queue. */
function takeFailure(path) {
  const i = mock.failures.findIndex((f) => !f.path || f.path === path);
  if (i < 0) return null;
  const f = mock.failures[i];
  if (f.times <= 1) mock.failures.splice(i, 1); else f.times -= 1;
  return f;
}

const bearerOf = (req) => {
  const raw = String(req.headers.authorization || '');
  return raw.startsWith('Bearer ') ? raw.slice(7) : null;
};

const json = (res, status, body, headers = {}) => {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
};

export function startMock(port = PORT) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://mock');
    const path = url.pathname.startsWith(BASE) ? url.pathname.slice(BASE.length) : null;
    const token = bearerOf(req);
    if (!token || token === 'dead-token' || req.headers['api-key']) {
      res.writeHead(401, { 'content-type': 'text/plain' });
      return res.end('Unauthorized');
    }
    if (req.method !== 'GET') return json(res, 403, { result: 'ERROR', message: ['This credential can only read.'] });
    const fn = path && ROUTES[path];
    if (!fn) return json(res, 404, { result: 'ERROR', message: [`No route ${url.pathname}`] });

    const q = {};
    for (const name of new Set(url.searchParams.keys())) {
      // The strict endpoints answer 400 to a repeated parameter; the others keep the first. Be strict everywhere.
      if (url.searchParams.getAll(name).length > 1) return json(res, 400, { result: 'ERROR', message: [`Parameter ${name} is repeated`] });
      q[name] = url.searchParams.get(name);
    }
    calls.push({ path, params: q, token });

    const failure = takeFailure(path);
    if (failure) {
      const headers = failure.retryAfter != null ? { 'retry-after': String(failure.retryAfter) } : {};
      const status = failure.status || 500;
      if (typeof failure.body === 'string') {
        res.writeHead(status, { 'content-type': 'text/plain', ...headers });
        return res.end(failure.body);
      }
      return json(res, status, failure.body ?? { result: 'ERROR', message: [`injected HTTP ${status}`] }, headers);
    }
    const latency = latencyFor(path);
    if (latency) await sleep(latency);
    try {
      return json(res, 200, paginate(path, q, fn(q)));
    } catch (err) {
      if (err instanceof BadRequest) return json(res, 400, { result: 'ERROR', message: [err.message] });
      throw err;
    }
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startMock().then(() => console.log(`mock HYROS API on http://127.0.0.1:${PORT}${BASE}`));
}
