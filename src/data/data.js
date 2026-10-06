/**
 * The data API views see as `ctx.data`. It is the only way a view reaches
 * HYROS: views never import the MCP client, the auth module or call fetch.
 *
 * Getters cache their promise for the life of the page, so three views asking
 * for the account cost one call. A failed promise is dropped from the cache
 * so the next ask tries again. Nothing is stored outside memory.
 *
 *   account()     hyros_get_user_info, normalized
 *   adAccounts()  { rows: [{ id, name, type }], truncated }
 *   sources()     { rows, truncated } with the raw source rows
 *   stages()      raw stage rows
 *   call / paged / pagedInfo   passthrough to the MCP client for any other read tool
 *   invalidate(key?)           drop one cached getter, or all of them
 *   now()                      the clock views should use
 */
export function createData({ mcp, now = () => new Date() }) {
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
      const user = await mcp.callTool('hyros_get_user_info', {});
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
      const page = await mcp.callToolPagedInfo('hyros_get_ad_accounts', { request: {} }, { maxPages: 4, pageSize: 250 });
      return {
        rows: page.rows.map((a) => ({ id: String(a.id), name: a.name, type: a.type })),
        truncated: Boolean(page.truncated),
      };
    }),

    sources: () => once('sources', async () => {
      const page = await mcp.callToolPagedInfo('hyros_get_sources',
        { request: { includeOrganic: true, includeDisregarded: false } },
        { maxPages: 40, pageSize: 250 });
      return { rows: page.rows, truncated: Boolean(page.truncated) };
    }),

    stages: () => once('stages', () => mcp.callToolPaged('hyros_get_stages', { request: {} }, { maxPages: 1, pageSize: 250 })),

    call: (tool, args, opts) => mcp.callTool(tool, args, opts),
    paged: (tool, args, opts) => mcp.callToolPaged(tool, args, opts),
    pagedInfo: (tool, args, opts) => mcp.callToolPagedInfo(tool, args, opts),

    invalidate(key) {
      if (key === undefined) cache.clear();
      else cache.delete(key);
    },

    now,
  };
}
