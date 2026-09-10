import fs from "node:fs";
import path from "node:path";

export type Row = Record<string, unknown>;

/**
 * The single place where PostgreSQL and SQLite differ. Everything above this
 * file writes PostgreSQL-flavoured SQL with $n placeholders.
 */
export interface Driver {
  readonly kind: "postgres" | "sqlite";
  query<T extends Row = Row>(sql: string, params?: unknown[]): Promise<T[]>;
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
}

class PgDriver implements Driver {
  readonly kind = "postgres" as const;
  constructor(private pool: import("pg").Pool) {}

  async query<T extends Row>(sql: string, params: unknown[] = []): Promise<T[]> {
    const res = await this.pool.query(sql, params);
    return res.rows as T[];
  }
  async exec(sql: string): Promise<void> {
    await this.pool.query(sql);
  }
  async close(): Promise<void> {
    await this.pool.end();
  }
}

class SqliteDriver implements Driver {
  readonly kind = "sqlite" as const;
  constructor(private db: import("better-sqlite3").Database) {}

  async query<T extends Row>(sql: string, params: unknown[] = []): Promise<T[]> {
    // SQLite has no $n placeholders that bind positionally from an array, so
    // rewrite each occurrence to `?` and expand params in occurrence order
    // (this also handles a $1 that appears twice).
    const ordered: unknown[] = [];
    const rewritten = sql.replace(/\$(\d+)/g, (_, n) => {
      ordered.push(toSqliteValue(params[Number(n) - 1]));
      return "?";
    });
    const stmt = this.db.prepare(rewritten);
    if (stmt.reader) return stmt.all(...ordered) as T[];
    stmt.run(...ordered);
    return [];
  }
  async exec(sql: string): Promise<void> {
    this.db.exec(sql);
  }
  async close(): Promise<void> {
    this.db.close();
  }
}

function toSqliteValue(v: unknown): unknown {
  if (typeof v === "boolean") return v ? 1 : 0;
  return v;
}

export function pgToSqliteDdl(sql: string): string {
  return sql
    .replace(/BIGSERIAL PRIMARY KEY/g, "INTEGER PRIMARY KEY AUTOINCREMENT")
    .replace(/\bJSONB\b/g, "TEXT")
    .replace(/\bTIMESTAMPTZ\b/g, "TEXT")
    .replace(/DEFAULT now\(\)/g, "DEFAULT CURRENT_TIMESTAMP");
}

export interface OpenOptions {
  databaseUrl?: string;
  sqlitePath?: string;
  log?: (msg: string) => void;
}

export async function openDriver(opts: OpenOptions = {}): Promise<Driver> {
  const log = opts.log ?? ((m: string) => console.log(m));
  const url = opts.databaseUrl ?? process.env.DATABASE_URL;
  if (url) {
    const pg = await import("pg");
    const pool = new pg.default.Pool({
      connectionString: url,
      max: 4,
      // BIGINT/BIGSERIAL would otherwise come back as strings.
      types: {
        getTypeParser: (oid: number, format?: string) =>
          oid === 20 ? (v: string) => Number(v) : pg.default.types.getTypeParser(oid, format as "text"),
      } as import("pg").CustomTypesConfig,
    });
    await pool.query("SELECT 1");
    log(`[db] PostgreSQL via DATABASE_URL`);
    return new PgDriver(pool);
  }
  const file = opts.sqlitePath ?? path.resolve("data", "runtime.sqlite");
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const Database = (await import("better-sqlite3")).default;
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  log(`[db] DATABASE_URL is not set — falling back to local SQLite at ${file}`);
  return new SqliteDriver(db);
}
