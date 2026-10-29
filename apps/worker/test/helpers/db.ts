import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { migrationsDir } from "@agentbox/db/client";
import * as schema from "@agentbox/db/schema";
import type { Db } from "../../src/types.ts";

const BASE = process.env.TEST_DATABASE_URL ?? "postgres://postgres:x@127.0.0.1:55433";

export interface TestDb {
  db: Db;
  url: string;
  close(): Promise<void>;
}

/** A fresh, migrated database per test file on the throwaway Postgres. */
export async function createTestDb(): Promise<TestDb> {
  const name = `abx_${randomBytes(6).toString("hex")}`;
  const admin = new pg.Pool({ connectionString: `${BASE}/postgres`, max: 1 });
  await admin.query(`CREATE DATABASE ${name}`);
  const url = `${BASE}/${name}`;
  const pool = new pg.Pool({ connectionString: url, max: 8 });
  const db = drizzle(pool, { schema });
  await migrate(db, { migrationsFolder: migrationsDir() });
  return {
    db,
    url,
    async close() {
      await pool.end();
      await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
      await admin.end();
    },
  };
}

/** Wipe all per-test rows but keep the seeded plans, prices and settings. */
export async function resetDb(db: Db): Promise<void> {
  await db.execute(
    sql.raw(`TRUNCATE "user", host_stats, audit_log, images, jobs, workspaces CASCADE`),
  );
}
