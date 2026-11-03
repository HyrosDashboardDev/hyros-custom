/**
 * Which host each call goes to. The page talks to the direct HYROS hosts
 * (`api.hyros.com`, `mcp.hyros.com`) first. Ad blockers cut browser calls to
 * `hyros.com` from another site, so when a call fails at network level (fetch
 * rejects with a TypeError, no HTTP status) the same call is retried on the
 * next fallback host: the hosts HYROS sets on the Vercel project at
 * provisioning (resolveFallback), which proxy the same backends. A channel
 * without fallback hosts has only its direct host, and a network failure there
 * ends the call.
 *
 *   createRoutes()   per channel ('api', 'auth'):
 *     bases(channel)               the direct base, then the fallbacks of that channel
 *     withFallback(channel, run, { probe })
 *                                  run(base) on the active base, moving on only on a network failure
 *     active(channel)              { base, viaFallback } for the next call
 *
 * A host that answers anything, a 401, a 429 or a 500 included, becomes the
 * active one of its channel for the rest of the page load: HTTP statuses never
 * switch hosts. The active host lives in memory only, so every page load starts
 * on the direct hosts again. A timeout (an AbortError) is not a network failure
 * (the host may be slow, not blocked): it ends the call on that host, like an
 * HTTP error.
 *
 * A TypeError does not prove the host never saw the request: a lost answer
 * (a cut connection, a gateway error without CORS headers) looks the same.
 * A request that must not run twice (an OAuth code or refresh token, a client
 * registration) passes `probe`, an idempotent GET to the same base, run after
 * the network failure: any HTTP answer to it means the host is reachable, so
 * the original error is thrown and nothing is replayed elsewhere; only a probe
 * that fails at network level too moves the request to the next base.
 */
/** A fetch that never got an HTTP response. An AbortError (a timeout) is not one. */
export function isNetworkError(err) {
  return err instanceof TypeError;
}

const trimSlash = (url) => String(url ?? '').replace(/\/+$/, '');

/**
 * The hosts of one environment. `direct` is `{ api, auth }` (directUrls) and
 * always comes first; `fallbacks` is `{ api, auth }` with the hosts tried after
 * it, in order (resolveFallback), none unless given. `api` and `auth` keep
 * their own active host.
 */
export function createRoutes({ direct, fallbacks = { api: [], auth: [] } }) {
  const activeIndex = { api: 0, auth: 0 };

  function bases(channel) {
    const first = trimSlash(direct[channel]);
    const rest = (fallbacks?.[channel] || []).map(trimSlash).filter((url) => url && url !== first);
    return [first, ...new Set(rest)];
  }

  /**
   * run(base) on the active base of `channel`. A network failure tries the
   * next base, wrapping around, until every base was tried once; then the
   * first network error is thrown for the caller to map. Any other outcome,
   * a result or an error, makes that base the active one. With `probe`, a
   * network failure moves on only when probe(base) fails at network level
   * too; any other probe outcome throws the original error from that base.
   * The probe only runs when there is another base to move on to.
   */
  async function withFallback(channel, run, { probe } = {}) {
    const list = bases(channel);
    const start = Math.min(activeIndex[channel], list.length - 1);
    let firstError = null;
    for (let tried = 0; tried < list.length; tried += 1) {
      const index = (start + tried) % list.length;
      try {
        const out = await run(list[index]);
        activeIndex[channel] = index;
        return out;
      } catch (err) {
        if (!isNetworkError(err)) {
          activeIndex[channel] = index;
          throw err;
        }
        if (probe && list.length > 1 && !(await blocked(probe, list[index]))) {
          activeIndex[channel] = index;
          throw err;
        }
        firstError ??= err;
      }
    }
    throw firstError;
  }

  /** Whether probe(base) also failed at network level: the host is blocked, not just one answer lost. */
  async function blocked(probe, base) {
    try {
      await probe(base);
      return false;
    } catch (err) {
      return isNetworkError(err);
    }
  }

  function active(channel) {
    const list = bases(channel);
    const index = Math.min(activeIndex[channel], list.length - 1);
    return { base: list[index], viaFallback: index > 0 };
  }

  return { bases, withFallback, active };
}
