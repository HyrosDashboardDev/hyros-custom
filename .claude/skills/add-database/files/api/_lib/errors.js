// add-database v2. Copied by the add-database skill: do not edit, run the skill again to update it.
/** The errors a route answers with, and how a thrown error maps to one. No dependency, so it is tested without a database. */

/** An error with the HTTP status and the code the page reads (`src/core/db.js`). */
export class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const badRequest = (message) => new HttpError(400, 'bad_request', message);
export const notFound = (message = 'Not found') => new HttpError(404, 'not_found', message);

/** Connection failures of the database or the pooler, and Postgres refusing new connections. */
const UNAVAILABLE_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'CONNECT_TIMEOUT', 'CONNECTION_CLOSED', 'CONNECTION_ENDED', '57P01', '53300']);

/** The status, code and message a thrown error answers with. */
export function toResponse(err) {
  if (err instanceof HttpError) return { status: err.status, code: err.code, message: err.message };
  // SQLSTATE 25006: Supabase made the database read only because its disk is full
  if (err?.code === '25006') return { status: 507, code: 'storage_full', message: 'The dashboard database is full. Delete data to keep saving.' };
  if (UNAVAILABLE_CODES.has(err?.code)) return { status: 503, code: 'unavailable', message: 'The dashboard database cannot be reached right now' };
  return { status: 500, code: 'internal', message: 'The dashboard database failed to answer' };
}
