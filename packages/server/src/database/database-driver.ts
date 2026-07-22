/**
 * Database abstraction layer — driver-agnostic interface for SQLite and PostgreSQL.
 *
 * Production: PostgreSQL with row-level security, connection pooling, migrations.
 * Development: SQLite with WAL mode, foreign keys.
 *
 * The interface is identical for both drivers. Switching is via DATABASE_DRIVER env var.
 */

export interface DatabaseDriver {
  query<T = unknown>(sql: string, params?: unknown[]): Promise<T[]>;
  queryOne<T = unknown>(sql: string, params?: unknown[]): Promise<T | null>;
  execute(sql: string, params?: unknown[]): Promise<{ changes: number; lastInsertRowid?: number }>;
  exec(sql: string): Promise<void>;
  transaction<T>(fn: (db: DatabaseDriver) => Promise<T>): Promise<T>;
  close(): Promise<void>;
  driver: 'sqlite' | 'postgresql';
  pragma(statement: string): Promise<void>;
}

export interface DatabaseConfig {
  driver: 'sqlite' | 'postgresql';
  sqlite?: {
    path: string;
    wal?: boolean;
    foreignKeys?: boolean;
  };
  postgresql?: {
    host: string;
    port: number;
    database: string;
    user: string;
    password: string;
    ssl?: boolean;
    poolSize?: number;
    schema?: string;
  };
}

export function createDatabaseConfigFromEnv(): DatabaseConfig {
  const driver = (process.env.DATABASE_DRIVER || 'sqlite') as 'sqlite' | 'postgresql';

  if (driver === 'postgresql') {
    return {
      driver: 'postgresql',
      postgresql: {
        host: process.env.PGHOST || 'localhost',
        port: parseInt(process.env.PGPORT || '5432', 10),
        database: process.env.PGDATABASE || 'djimitflo',
        user: process.env.PGUSER || 'djimitflo',
        password: process.env.PGPASSWORD || '',
        ssl: process.env.PGSSL === 'true',
        poolSize: parseInt(process.env.PG_POOL_SIZE || '10', 10),
        schema: process.env.PGSCHEMA || 'public',
      },
    };
  }

  return {
    driver: 'sqlite',
    sqlite: {
      path: process.env.DB_PATH || './data/djimitflo.sqlite',
      wal: true,
      foreignKeys: true,
    },
  };
}

/**
 * SQLite implementation using better-sqlite3.
 */
export class SqliteDriver implements DatabaseDriver {
  readonly driver = 'sqlite' as const;
  private db: import('better-sqlite3').Database;

  constructor(config: DatabaseConfig['sqlite']) {
    if (!config) throw new Error('SQLite config required');

    const Database = require('better-sqlite3');
    this.db = new Database(config.path);

    if (config.wal) {
      this.db.pragma('journal_mode = WAL');
    }
    if (config.foreignKeys) {
      this.db.pragma('foreign_keys = ON');
    }
  }

  async query<T = unknown>(sql: string, params: unknown[] = []): Promise<T[]> {
    const pgSql = this.toPostgresSyntax(sql);
    return this.db.prepare(pgSql).all(...params) as T[];
  }

  async queryOne<T = unknown>(sql: string, params: unknown[] = []): Promise<T | null> {
    const pgSql = this.toPostgresSyntax(sql);
    return (this.db.prepare(pgSql).get(...params) as T) || null;
  }

  async execute(sql: string, params: unknown[] = []): Promise<{ changes: number; lastInsertRowid?: number }> {
    const pgSql = this.toPostgresSyntax(sql);
    const result = this.db.prepare(pgSql).run(...params);
    return { changes: result.changes, lastInsertRowid: Number(result.lastInsertRowid) };
  }

  async exec(sql: string): Promise<void> {
    this.db.exec(sql);
  }

  async transaction<T>(fn: (db: DatabaseDriver) => Promise<T>): Promise<T> {
    this.db.transaction(() => {
      fn(this);
    })();
    return undefined as T;
  }

  async close(): Promise<void> {
    this.db.close();
  }

  async pragma(statement: string): Promise<void> {
    this.db.pragma(statement);
  }

  private toPostgresSyntax(sql: string): string {
    return sql
      .replace(/datetime\('now'\)/g, 'CURRENT_TIMESTAMP')
      .replace(/\?/g, () => `$${++SqliteDriver.paramIndex}`)
      .replace(/AUTOINCREMENT/gi, 'GENERATED ALWAYS AS IDENTITY');
  }

  private static paramIndex = 0;
}

/**
 * PostgreSQL implementation using pg (node-postgres).
 * Structural implementation — requires `pg` dependency.
 */
export class PostgresDriver implements DatabaseDriver {
  readonly driver = 'postgresql' as const;
  private pool: any;

  constructor(private config: DatabaseConfig['postgresql']) {
    if (!config) throw new Error('PostgreSQL config required');
  }

  async connect(): Promise<void> {
    try {
      const { Pool } = require('pg');
      this.pool = new Pool({
        host: this.config!.host,
        port: this.config!.port,
        database: this.config!.database,
        user: this.config!.user,
        password: this.config!.password,
        ssl: this.config!.ssl ? { rejectUnauthorized: false } : false,
        max: this.config!.poolSize || 10,
      });

      if (this.config!.schema) {
        await this.pool.query(`SET search_path TO ${this.config!.schema}`);
      }
    } catch {
      throw new Error('PostgreSQL driver requires "pg" package. Run: npm install pg');
    }
  }

  async query<T = unknown>(sql: string, params: unknown[] = []): Promise<T[]> {
    const result = await this.pool.query(sql, params);
    return result.rows as T[];
  }

  async queryOne<T = unknown>(sql: string, params: unknown[] = []): Promise<T | null> {
    const result = await this.pool.query(sql, params);
    return (result.rows[0] as T) || null;
  }

  async execute(sql: string, params: unknown[] = []): Promise<{ changes: number; lastInsertRowid?: number }> {
    const result = await this.pool.query(sql, params);
    return { changes: result.rowCount || 0 };
  }

  async exec(sql: string): Promise<void> {
    await this.pool.query(sql);
  }

  async transaction<T>(fn: (db: DatabaseDriver) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(this);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async pragma(_statement: string): Promise<void> {
    void _statement;
  }

  /**
   * Enable Row-Level Security on a table.
   */
  async enableRLS(tableName: string): Promise<void> {
    await this.pool.query(`ALTER TABLE ${tableName} ENABLE ROW LEVEL SECURITY`);
  }

  /**
   * Create a policy for tenant isolation.
   */
  async createTenantPolicy(tableName: string, tenantColumn = 'tenant_id'): Promise<void> {
    await this.pool.query(`
      CREATE POLICY ${tableName}_tenant_isolation ON ${tableName}
      USING (${tenantColumn} = current_setting('app.current_tenant')::text)
    `);
  }
}

/**
 * Factory function to create the appropriate database driver.
 */
export async function createDatabaseDriver(config?: DatabaseConfig): Promise<DatabaseDriver> {
  const dbConfig = config || createDatabaseConfigFromEnv();

  if (dbConfig.driver === 'postgresql') {
    const driver = new PostgresDriver(dbConfig.postgresql);
    await driver.connect();
    return driver;
  }

  return new SqliteDriver(dbConfig.sqlite);
}

/**
 * SQL migration compatibility layer.
 * Converts SQLite-specific syntax to PostgreSQL when needed.
 */
export function translateMigration(sql: string, targetDriver: 'sqlite' | 'postgresql'): string {
  if (targetDriver === 'postgresql') {
    return sql
      .replace(/INTEGER PRIMARY KEY AUTOINCREMENT/gi, 'SERIAL PRIMARY KEY')
      .replace(/TEXT NOT NULL DEFAULT \(datetime\('now'\)\)/g, "TEXT NOT NULL DEFAULT (NOW()::text)")
      .replace(/TEXT DEFAULT \(datetime\('now'\)\)/g, "TEXT DEFAULT (NOW()::text)")
      .replace(/datetime\('now',\s*'([^']+)'\)/g, "NOW() + INTERVAL '$1'")
      .replace(/datetime\('now'\)/g, 'NOW()')
      .replace(/BLOB/gi, 'BYTEA')
      .replace(/REAL/gi, 'DOUBLE PRECISION');
  }

  return sql;
}
