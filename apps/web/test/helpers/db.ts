import { randomBytes } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { migrationsDir, type Db } from "@agentbox/db/client";
import * as schema from "@agentbox/db/schema";

const BASE = process.env.TEST_DATABASE_URL ?? "postgres://postgres:x@127.0.0.1:55434";

export interface TestDb {
  db: Db;
  close(): Promise<void>;
}

/** A fresh, migrated database per test file on the throwaway Postgres. */
export async function createTestDb(): Promise<TestDb> {
  const name = `abxweb_${randomBytes(6).toString("hex")}`;
  const admin = new pg.Pool({ connectionString: `${BASE}/postgres`, max: 1 });
  await admin.query(`CREATE DATABASE ${name}`);
  const pool = new pg.Pool({ connectionString: `${BASE}/${name}`, max: 4 });
  const db = drizzle(pool, { schema });
  await migrate(db, { migrationsFolder: migrationsDir() });
  return {
    db,
    async close() {
      await pool.end();
      await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
      await admin.end();
    },
  };
}

let counter = 0;
/** Insert a user plus a pending access request. */
export async function seedRequester(db: Db, email: string) {
  const id = `u_${++counter}_${randomBytes(3).toString("hex")}`;
  await db
    .insert(schema.user)
    .values({ id, name: email.split("@")[0]!, email, accessStatus: "pending" });
  const [req] = await db
    .insert(schema.accessRequests)
    .values({ userId: id, message: "hi" })
    .returning({ id: schema.accessRequests.id });
  return { userId: id, requestId: req!.id };
}

/** Insert a user with no access request, in any access status. */
export async function seedUser(
  db: Db,
  email: string,
  accessStatus: (typeof schema.user.$inferInsert)["accessStatus"],
) {
  const id = `s_${++counter}_${randomBytes(3).toString("hex")}`;
  await db.insert(schema.user).values({ id, name: email.split("@")[0]!, email, accessStatus });
  return id;
}

export async function seedAdmin(db: Db, email = "admin@example.com") {
  const id = `a_${++counter}_${randomBytes(3).toString("hex")}`;
  await db
    .insert(schema.user)
    .values({ id, name: "Admin", email, role: "admin", accessStatus: "active" });
  return id;
}
