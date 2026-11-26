// add-database v2. Copied by the add-database skill: do not edit, run the skill again to update it.
/** Whether the page can reach its database with the current credential: `{ ok: true, migrations }`. */
import { route } from '../_lib/respond.js';

export default route(['GET'], async ({ sql }) => {
  const [row] = await sql`select count(*)::int as migrations from schema_migrations`;
  return { ok: true, migrations: row.migrations };
});
