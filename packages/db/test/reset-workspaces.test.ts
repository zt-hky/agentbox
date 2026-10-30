import { randomBytes } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { eq } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resetAllWorkspaces } from "../src/admin.ts";
import { migrationsDir, type Db } from "../src/client.ts";
import * as schema from "../src/schema.ts";

const BASE = process.env.TEST_DATABASE_URL ?? "postgres://postgres:x@127.0.0.1:55450";

describe("resetAllWorkspaces", () => {
  const name = `abx_reset_${randomBytes(6).toString("hex")}`;
  let admin: pg.Pool;
  let pool: pg.Pool;
  let db: Db;

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: `${BASE}/postgres`, max: 1 });
    await admin.query(`CREATE DATABASE ${name}`);
    pool = new pg.Pool({ connectionString: `${BASE}/${name}`, max: 2 });
    db = drizzle(pool, { schema });
    await migrate(db, { migrationsFolder: migrationsDir() });
  });
  afterAll(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
    await admin.end();
  });

  beforeEach(async () => {
    await pool.query(
      `TRUNCATE jobs, workspace_sessions, agent_keys, audit_log, workspaces, "user" CASCADE`,
    );
    await pool.query(`
      INSERT INTO "user" (id, name, email, email_verified, access_status, onboarded_at, onboarding_selection) VALUES
        ('a','a','a@x.io',true,'active',now(),'{"tools":["go"]}'),
        ('b','b','b@x.io',true,'active',now(),'{"tools":["rust"]}'),
        ('c','c','c@x.io',true,'active',now(),NULL);
      INSERT INTO workspaces (user_id, slug, slot, status, identity_secret_enc) VALUES
        ('a','aaa',1,'running','x'),
        ('b','bbb',2,'sleeping','x'),
        ('c','ccc',3,'deleted','x');
      INSERT INTO agent_keys (user_id, env_var, value_enc) VALUES ('a','OPENAI_API_KEY','enc');
    `);
    await pool.query(
      `INSERT INTO workspace_sessions (token_hash, user_id, workspace_id, host, expires_at)
       SELECT 'h', 'a', id, 'x', now() + interval '1 day' FROM workspaces WHERE slug = 'aaa'`,
    );
  });

  const rows = async <T extends object>(sql: string) => (await pool.query<T>(sql)).rows;

  it("a dry run reports and changes nothing", async () => {
    const r = await resetAllWorkspaces(db, { keepData: true, dryRun: true });
    expect(r).toMatchObject({ dryRun: true, usersReset: 3 });
    expect(r.workspaces.map((w) => w.slug).sort()).toEqual(["aaa", "bbb"]);
    expect(await rows(`select count(*)::int as n from jobs`)).toEqual([{ n: 0 }]);
    expect(
      await rows(`select count(*)::int as n from "user" where onboarded_at is not null`),
    ).toEqual([{ n: 3 }]);
    expect(await rows(`select status from workspaces order by slug`)).toEqual([
      { status: "running" },
      { status: "sleeping" },
      { status: "deleted" },
    ]);
  });

  it("keep-data queues keep-data deletes for live workspaces, resets onboarding, keeps choices and keys", async () => {
    await resetAllWorkspaces(db, { keepData: true, dryRun: false });
    expect(await rows(`select status from workspaces order by slug`)).toEqual([
      { status: "deleting" },
      { status: "deleting" },
      { status: "deleted" },
    ]);
    const queued = await db.select().from(schema.jobs);
    expect(queued).toHaveLength(2);
    expect(queued.every((j) => j.type === "delete_tenant")).toBe(true);
    expect(queued.every((j) => (j.payload as { keepData: boolean }).keepData === true)).toBe(true);
    expect(
      await rows(`select count(*)::int as n from "user" where onboarded_at is not null`),
    ).toEqual([{ n: 0 }]);
    expect(await rows(`select onboarding_selection from "user" where id = 'a'`)).toEqual([
      { onboarding_selection: { tools: ["go"] } },
    ]);
    expect(await rows(`select count(*)::int as n from agent_keys`)).toEqual([{ n: 1 }]);
    expect(await rows(`select revoked_at is not null as revoked from workspace_sessions`)).toEqual([
      { revoked: true },
    ]);
    const audit = await db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, "admin.reset_workspaces"));
    expect(audit).toHaveLength(1);
  });

  it("wipe queues wiping deletes and also clears selections and agent keys", async () => {
    await resetAllWorkspaces(db, { keepData: false, dryRun: false });
    const queued = await db.select().from(schema.jobs);
    expect(queued.every((j) => (j.payload as { keepData: boolean }).keepData === false)).toBe(true);
    expect(
      await rows(`select count(*)::int as n from "user" where onboarding_selection is not null`),
    ).toEqual([{ n: 0 }]);
    expect(await rows(`select count(*)::int as n from agent_keys`)).toEqual([{ n: 0 }]);
  });

  it("running it twice does not queue a second delete for a workspace already going away", async () => {
    await resetAllWorkspaces(db, { keepData: false, dryRun: false });
    await resetAllWorkspaces(db, { keepData: false, dryRun: false });
    expect(await rows(`select count(*)::int as n from jobs`)).toEqual([{ n: 2 }]);
  });
});
