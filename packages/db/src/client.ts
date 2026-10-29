import path from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { eq } from "drizzle-orm";
import pg from "pg";
import { parseSetting, type SettingKey, type SettingValue } from "@agentbox/core/settings";
import * as schema from "./schema.ts";

export type Db = NodePgDatabase<typeof schema>;

let _pool: pg.Pool | undefined;
let _db: Db | undefined;

function getDb(): Db {
  if (!_db) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
    _pool = new pg.Pool({ connectionString: url });
    _db = drizzle(_pool, { schema });
  }
  return _db;
}

/** Lazy: importing this module never connects; first property access creates the pool. */
export const db: Db = new Proxy({} as Db, {
  get(_t, prop) {
    const real = getDb();
    const v = Reflect.get(real, prop, real) as unknown;
    return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(real) : v;
  },
});

export function migrationsDir(): string {
  return (
    process.env.AGENTBOX_MIGRATIONS_DIR ??
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "drizzle")
  );
}

export async function runMigrations(): Promise<void> {
  await migrate(getDb(), { migrationsFolder: migrationsDir() });
}

export async function closeDb(): Promise<void> {
  const pool = _pool;
  _pool = undefined;
  _db = undefined;
  await pool?.end();
}

export async function readSetting<K extends SettingKey>(
  database: Pick<Db, "select">,
  key: K,
): Promise<SettingValue<K> | null> {
  const rows = await database
    .select({ value: schema.settings.value })
    .from(schema.settings)
    .where(eq(schema.settings.key, key))
    .limit(1);
  const row = rows[0];
  return row ? parseSetting(key, row.value) : null;
}
