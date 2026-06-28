/**
 * Environment for the corpus API Worker.
 *
 * `DB` is built per-request in index.ts as a libSQL shim (see libsql.ts) over
 * the Turso connection, typed as D1Database so the lifted query layer (db.ts)
 * is unchanged from ainu-mcp.
 */
export interface Env {
  // Plain vars
  API_VERSION: string;

  // Secrets (wrangler secret put)
  DATABASE_URL: string; // libsql://…turso.io
  DATABASE_AUTH_TOKEN: string;
}
