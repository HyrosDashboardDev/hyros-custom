// add-database v2. Copied by the add-database skill: do not edit, run the skill again to update it.
/**
 * Every route under `api/db/` is one `route(...)`: it allows only the listed methods, checks the caller
 * (`auth.js`), runs the handler and answers JSON. A failure answers `{ error: { code, message } }` with the
 * status the page maps (`src/core/db.js`):
 *
 *   400 bad_request    the handler threw badRequest(...)
 *   401 auth           no token, or HYROS refused it: the page gets a new one and retries once
 *   403 forbidden      a token of another account, or the cron secret on a route that does not take the cron
 *   404 not_found      the handler threw notFound(...)
 *   405 method         a method the route does not take
 *   507 storage_full   the database disk is full and read only (SQLSTATE 25006)
 *   503 no_database / unavailable   no database yet, or it or HYROS cannot be reached
 *   500 internal       anything else; the details stay in the function log
 */
import { CALLERS, identifyCaller } from './auth.js';
import { hasDatabase, sql } from './db.js';
import { HttpError, toResponse } from './errors.js';

export { HttpError, badRequest, notFound } from './errors.js';

/**
 * A route: `export default route(['GET', 'POST'], async ({ req, user, caller, sql }) => result)`. The handler's
 * result is sent as JSON with 200; `undefined` answers 204.
 *
 * `callers` names who may call it (`auth.js`): `['user']`, the page, by default; `['cron']` for a Vercel cron
 * job; both only when a route really serves both. `caller` says which one called; `user` is null for the cron.
 */
export function route(methods, handler, { callers = ['user'] } = {}) {
  if (!callers.length || callers.some((c) => !CALLERS.includes(c))) throw new Error(`route callers must be some of ${CALLERS.join(', ')}`);
  const allowed = new Set(methods.map((m) => m.toUpperCase()));
  return async function dashboardRoute(req, res) {
    try {
      if (!allowed.has(req.method)) {
        res.setHeader('Allow', [...allowed].join(', '));
        throw new HttpError(405, 'method', `${req.method} is not allowed here`);
      }
      if (!hasDatabase) throw new HttpError(503, 'no_database', 'The dashboard has no database yet');
      const { caller, user } = await identifyCaller(req, callers);
      const result = await handler({ req, user, caller, sql });
      res.setHeader('Cache-Control', 'no-store');
      if (result === undefined) res.status(204).end();
      else res.status(200).json(result);
    } catch (err) {
      const out = toResponse(err);
      if (out.status >= 500) console.error(`[api] ${req.method} ${req.url} failed: ${err?.code || ''} ${err?.message || err}`);
      res.setHeader('Cache-Control', 'no-store');
      res.status(out.status).json({ error: { code: out.code, message: out.message } });
    }
  };
}
