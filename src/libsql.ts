/**
 * libSQL-backed shim presenting the small slice of the D1Database API the query
 * layer uses — `prepare(sql).bind(...args).all<T>()` / `.first<T>()` (and
 * `prepare(sql).all<T>()` without bind). Lifted verbatim from ainu-mcp so the
 * corpus query layer (db.ts) is byte-for-byte the same against Turso (libSQL
 * over HTTP). Uses the `/web` entry (fetch-based, no Node built-ins).
 */
import { createClient, type Client, type InValue } from "@libsql/client/web";

class LibsqlStatement {
  constructor(
    private readonly client: Client,
    private readonly sql: string,
    private readonly args: InValue[] = [],
  ) {}

  bind(...args: unknown[]): LibsqlStatement {
    return new LibsqlStatement(this.client, this.sql, args as InValue[]);
  }

  async all<T = unknown>(): Promise<{ results: T[] }> {
    const rs = await this.client.execute({ sql: this.sql, args: this.args });
    return { results: rs.rows as unknown as T[] };
  }

  async first<T = unknown>(): Promise<T | null> {
    const rs = await this.client.execute({ sql: this.sql, args: this.args });
    return (rs.rows[0] as unknown as T) ?? null;
  }
}

/** Minimal D1Database-shaped wrapper over a libSQL client. */
export class LibsqlDb {
  private readonly client: Client;
  constructor(url: string, authToken: string) {
    this.client = createClient({ url, authToken });
  }
  prepare(sql: string): LibsqlStatement {
    return new LibsqlStatement(this.client, sql);
  }
}
