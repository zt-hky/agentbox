import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const BASE = process.env.TEST_DATABASE_URL ?? "postgres://postgres:x@127.0.0.1:55450";
const FULL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "drizzle");

/** Every migration before 0010 (onboarding + image versions): production's shape before this change. */
function before0010(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "abx-mig-"));
  cpSync(FULL, dir, { recursive: true });
  const journalPath = path.join(dir, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as { entries: { idx: number }[] };
  journal.entries = journal.entries.filter((e) => e.idx <= 9);
  writeFileSync(journalPath, JSON.stringify(journal));
  return dir;
}

describe("0010 onboarding migration on a populated database", () => {
  const name = `abx_mig_${randomBytes(6).toString("hex")}`;
  let admin: pg.Pool;
  let pool: pg.Pool;
  const q = async <T extends object = Record<string, unknown>>(sql: string) =>
    (await pool.query<T>(sql)).rows;

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: `${BASE}/postgres`, max: 1 });
    await admin.query(`CREATE DATABASE ${name}`);
    pool = new pg.Pool({ connectionString: `${BASE}/${name}`, max: 2 });
    const db = drizzle(pool);
    await migrate(db, { migrationsFolder: before0010() });
    await pool.query(`
      INSERT INTO "user" (id, name, email, email_verified, access_status) VALUES
        ('u_old','old','old@x.io',true,'active');
      INSERT INTO workspaces (user_id, slug, slot, status, identity_secret_enc) VALUES
        ('u_old','old1',1,'running','x');
      INSERT INTO images (t3_ref, status, created_at) VALUES
        ('second', 'ready', '2026-10-02Z'),
        ('first', 'retired', '2026-10-01Z'),
        ('third', 'active', '2026-10-03Z');
    `);
    await migrate(db, { migrationsFolder: FULL });
  });
  afterAll(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
    await admin.end();
  });

  it("numbers existing images 1..n in build order", async () => {
    expect(await q(`select t3_ref, version from images order by version`)).toEqual([
      { t3_ref: "first", version: 1 },
      { t3_ref: "second", version: 2 },
      { t3_ref: "third", version: 3 },
    ]);
  });

  it("keeps versions unique and required", async () => {
    await expect(
      pool.query(`INSERT INTO images (t3_ref, version) VALUES ('dupe', 2)`),
    ).rejects.toThrow();
    await expect(pool.query(`INSERT INTO images (t3_ref) VALUES ('none')`)).rejects.toThrow();
  });

  it("makes every existing user go through onboarding and keeps their workspace", async () => {
    expect(await q(`select onboarded_at, onboarding_selection, reserved_slug from "user"`)).toEqual(
      [{ onboarded_at: null, onboarding_selection: null, reserved_slug: null }],
    );
    expect(await q(`select slug, data_kept from workspaces`)).toEqual([
      { slug: "old1", data_kept: false },
    ]);
  });
});
