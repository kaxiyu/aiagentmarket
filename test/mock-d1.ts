// Mock Cloudflare D1 implementation using Node.js v24 native node:sqlite for high-fidelity in-memory testing

// @ts-ignore - node:sqlite is built-in in Node v24
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export class MockD1PreparedStatement {
  private db: any;
  private sql: string;
  private params: any[];

  constructor(db: any, sql: string, params: any[] = []) {
    this.db = db;
    this.sql = sql;
    this.params = params;
  }

  bind(...params: any[]) {
    return new MockD1PreparedStatement(this.db, this.sql, params);
  }

  async first<T = any>(colName?: string): Promise<T | null> {
    const stmt = this.db.prepare(this.sql);
    const row = stmt.get(...this.params) as Record<string, unknown> | undefined;
    if (!row) return null;
    if (colName) return (row[colName] as T) ?? null;
    return row as T;
  }

  async all<T = any>(): Promise<{ results: T[]; success: boolean; meta: any }> {
    const stmt = this.db.prepare(this.sql);
    const rows = stmt.all(...this.params) as T[];
    return {
      results: rows || [],
      success: true,
      meta: { changes: 0 },
    };
  }

  async run(): Promise<{ success: boolean; meta: any }> {
    const stmt = this.db.prepare(this.sql);
    const info = stmt.run(...this.params);
    return {
      success: true,
      meta: { changes: info.changes },
    };
  }

  async raw<T = any[]>(): Promise<T[]> {
    return [];
  }

  executeRaw() {
    const stmt = this.db.prepare(this.sql);
    return stmt.run(...this.params);
  }
}

export class MockD1Database {
  private db: any;

  constructor() {
    this.db = new DatabaseSync(':memory:');
  }

  prepare(sql: string): MockD1PreparedStatement {
    return new MockD1PreparedStatement(this.db, sql);
  }

  async batch(statements: MockD1PreparedStatement[] | any[]): Promise<any[]> {
    this.db.exec('BEGIN TRANSACTION;');
    try {
      const results = [];
      for (const stmt of statements) {
        results.push(stmt.executeRaw());
      }
      this.db.exec('COMMIT;');
      return results;
    } catch (err) {
      this.db.exec('ROLLBACK;');
      throw err;
    }
  }

  async exec(sql: string): Promise<any> {
    this.db.exec(sql);
    return { count: 1, duration: 0 };
  }

  async dump(): Promise<ArrayBuffer> {
    return new ArrayBuffer(0);
  }

  withSession(token?: string): this {
    return this;
  }

  loadMigrations(migrationPath: string) {
    const sql = fs.readFileSync(migrationPath, 'utf8');
    this.db.exec(sql);
  }
}

export function createTestD1(): D1Database {
  const d1 = new MockD1Database();
  const migrationPath = path.resolve(process.cwd(), 'migrations/0001_initial_schema.sql');
  d1.loadMigrations(migrationPath);
  return d1 as unknown as D1Database;
}
