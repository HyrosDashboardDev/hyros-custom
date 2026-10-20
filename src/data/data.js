/**
 * The data API views see as `ctx.data`. It is the only way a view reaches
 * HYROS: views never import the API client, the auth module or call fetch.
 *
 * Getters cache their promise for the life of the page, so three views asking
 * for the account cost one call. A failed promise is dropped from the cache
 * so the next ask tries again. Nothing is stored outside memory.
 *
 *   account()     GET /user-info, normalized
 *   adAccounts()  { rows: [{ id, name, type }], truncated }
 *   sources()     { rows, truncated } with the raw source rows
 *   stages()      raw stage rows
 *   call / paged / pagedInfo   passthrough to the API client for any other read path:
 *                 call(path, params) is the body as sent, paged/pagedInfo walk `pageId`
 *   cached(key, loader)        a view's own memo: `loader()` once per key until invalidate()
 *   peek(key)                  the promise cached() holds for `key`, or undefined; never loads
 *   invalidate(key?)           drop one cached getter, or all of them (memos included)
 *   now()                      the clock views should use
 */
export function createData({ api, now = () => new Date() }) {
  const cache = new Map();

  function once(key, load) {
    if (!cache.has(key)) {
      const promise = load();
      cache.set(key, promise);
      promise.catch(() => {
        if (cache.get(key) === promise) cache.delete(key);
      });
    }
    return cache.get(key);
  }

  const summary = (list) => (Array.isArray(list) ? list : []).map((a) => ({
    accountId: a.accountId || null,
    email: a.email || null,
    company: a.companyName || null,
    status: a.status || null,
  }));

  return {
    account: () => once('account', async () => {
      const user = (await api.get('/user-info'))?.result;
      return {
        email: user?.userProfile?.email || null,
        // Raw on purpose: the API types it as a free string ("-05:00", "UTC", "America/New_York").
        // dates.js parses it when a view needs it.
        timezone: user?.userProfile?.timezone || null,
        currency: user?.trueTrackingData?.OUTBOUND_CURRENCY || 'USD',
        attributionWindowDefault: Number(user?.trueTrackingData?.LEAD_ATTRIBUTION_TIMEFRAME) || null,
        // Agency relationships: who manages this account, and which client accounts it can operate on.
        managedBy: summary(user?.allowedAccounts),
        clients: summary(user?.accessibleAccounts),
        raw: user,
      };
    }),

    adAccounts: () => once('adAccounts', async () => {
      const page = await api.getPagedInfo('/ad-accounts', {}, { maxPages: 4, pageSize: 250 });
      return {
        rows: page.rows.map((a) => ({ id: String(a.id), name: a.name, type: a.type })),
        truncated: Boolean(page.truncated),
      };
    }),

    sources: () => once('sources', async () => {
      // Both flags default to true on the API: say what this list wants.
      const page = await api.getPagedInfo('/sources',
        { includeOrganic: true, includeDisregarded: false },
        { maxPages: 40, pageSize: 250 });
      return { rows: page.rows, truncated: Boolean(page.truncated) };
    }),

    stages: () => once('stages', () => api.getPaged('/stages', {}, { maxPages: 1, pageSize: 250 })),

    call: (path, params, opts) => api.get(path, params, opts),
    paged: (path, params, opts) => api.getPaged(path, params, opts),
    pagedInfo: (path, params, opts) => api.getPagedInfo(path, params, opts),

    // Prefixed so a view key can never shadow a getter.
    cached: (key, loader) => once(`view:${key}`, loader),
    // Read another view's memo without starting (or caching) a load of your own.
    peek: (key) => cache.get(`view:${key}`),

    invalidate(key) {
      if (key === undefined) cache.clear();
      else cache.delete(key);
    },

    now,
  };
}
