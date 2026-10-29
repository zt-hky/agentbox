import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { billingSettingsSchema } from "@agentbox/core/settings";

const BASE = process.env.TEST_DATABASE_URL ?? "postgres://postgres:x@127.0.0.1:55450";
const FULL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "drizzle");

const FREE = "00000000-0000-4000-8000-0000000000a1";
const PAYG = "00000000-0000-4000-8000-0000000000a2";
const PRO = "00000000-0000-4000-8000-0000000000a3";
const MAX = "00000000-0000-4000-8000-0000000000a4";

/** Migrations 0000-0003 only: the shape production had before plans v2. */
function legacyFolder(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "abx-mig-"));
  cpSync(FULL, dir, { recursive: true });
  const journalPath = path.join(dir, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as { entries: { idx: number }[] };
  journal.entries = journal.entries.filter((e) => e.idx <= 3);
  writeFileSync(journalPath, JSON.stringify(journal));
  return dir;
}

describe("plans v2 migration on a populated database", () => {
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
    await migrate(db, { migrationsFolder: legacyFolder() });
    // Production-like rows: a Pro user, a Free user, a running + a deleted workspace, balances.
    await pool.query(`
      INSERT INTO "user" (id, name, email, email_verified, access_status) VALUES
        ('u_pro','pro','pro@x.io',true,'active'),
        ('u_free','free','free@x.io',true,'active'),
        ('u_gone','gone','gone@x.io',true,'active');
      INSERT INTO subscriptions (user_id, plan_id, cycle_start, cycle_end, used_runtime_hours) VALUES
        ('u_pro','${PRO}','2026-10-01Z','2026-11-01Z', 12.5),
        ('u_free','${FREE}','2026-10-01Z','2026-11-01Z', 3),
        ('u_gone','${FREE}','2026-10-01Z','2026-11-01Z', 0);
      INSERT INTO credit_balances (user_id, balance_micro) VALUES ('u_pro', 7000000);
      INSERT INTO workspaces (user_id, slug, slot, status, identity_secret_enc) VALUES
        ('u_pro','pro1',1,'running','x'),
        ('u_free','free1',2,'sleeping','x'),
        ('u_gone','gone1',3,'deleted','x');
    `);
    await migrate(db, { migrationsFolder: FULL });
  });
  afterAll(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
    await admin.end();
  });

  it("updates/creates the four plans with the spec values", async () => {
    const rows = await q(
      `select id, name, kind, monthly_price_micro::text as price, cpu_limit::float as cpu, memory_limit_mb as mem,
        disk_limit_gb as disk, inodes_limit as inodes, pids_limit as pids, trial_days, daily_runtime_hours as daily,
        allowance_runtime_hours as rt, allowance_cpu_core_hours as cpuh, allowance_mem_gb_hours as memh,
        max_awake_hours as maxawake, idle_timeout_minutes as idle, sort_order, public
       from plans order by sort_order`,
    );
    expect(rows).toEqual([
      {
        id: FREE,
        name: "Free trial",
        kind: "free",
        price: "0",
        cpu: 1,
        mem: 2048,
        disk: 5,
        inodes: 500000,
        pids: 512,
        trial_days: 5,
        daily: 6,
        rt: 30,
        cpuh: 30,
        memh: 60,
        maxawake: 6,
        idle: 15,
        sort_order: 0,
        public: true,
      },
      {
        id: PRO,
        name: "Pro",
        kind: "package",
        price: "139000000",
        cpu: 2,
        mem: 4096,
        disk: 20,
        inodes: 2000000,
        pids: 2048,
        trial_days: null,
        daily: null,
        rt: 200,
        cpuh: 400,
        memh: 800,
        maxawake: 12,
        idle: 30,
        sort_order: 1,
        public: true,
      },
      {
        id: MAX,
        name: "Max",
        kind: "package",
        price: "249000000",
        cpu: 4,
        mem: 8192,
        disk: 50,
        inodes: 4000000,
        pids: 4096,
        trial_days: null,
        daily: null,
        rt: 360,
        cpuh: 1440,
        memh: 2880,
        maxawake: 24,
        idle: 60,
        sort_order: 2,
        public: true,
      },
      {
        id: PAYG,
        name: "Credits only",
        kind: "payg",
        price: "0",
        cpu: 1,
        mem: 2048,
        disk: 5,
        inodes: 500000,
        pids: 512,
        trial_days: null,
        daily: null,
        rt: 0,
        cpuh: 0,
        memh: 0,
        maxawake: 6,
        idle: 15,
        sort_order: 3,
        public: false,
      },
    ]);
  });

  it("adds the credit-rate prices row as the latest effective one", async () => {
    const [latest] = await q(
      `select runtime_per_hour::text as rt, cpu_core_per_hour::text as cpu, mem_gb_per_hour::text as mem
       from prices where effective_from <= now() order by effective_from desc limit 1`,
    );
    expect(latest).toEqual({ rt: "600000", cpu: "400000", mem: "150000" });
    expect(await q(`select 1 from prices`)).toHaveLength(2);
  });

  it("billing setting gains creditValueVnd and keeps the other keys", async () => {
    const [row] = await q<{ value: unknown }>(`select value from settings where key = 'billing'`);
    expect(row!.value).toEqual({
      creditLabel: "credit",
      defaultPlanId: FREE,
      creditValueVnd: 1000,
    });
    expect(
      billingSettingsSchema.parse({ creditLabel: "credit", defaultPlanId: FREE }).creditValueVnd,
    ).toBe(1000);
  });

  it("starts the trial for Free subscriptions only and keeps usage/balances", async () => {
    const rows = await q<{
      user_id: string;
      trial: boolean;
      used: number;
      today: number;
      day_start: unknown;
    }>(
      `select user_id, trial_ends_at is not null as trial, used_runtime_hours as used,
        used_today_runtime_hours as today, day_start from subscriptions order by user_id`,
    );
    expect(rows).toEqual([
      { user_id: "u_free", trial: true, used: 3, today: 0, day_start: null },
      { user_id: "u_gone", trial: true, used: 0, today: 0, day_start: null },
      { user_id: "u_pro", trial: false, used: 12.5, today: 0, day_start: null },
    ]);
    const [row] = await q<{ ok: boolean }>(
      `select bool_and(trial_ends_at between now() + interval '4 days 23 hours' and now() + interval '5 days')
         as ok from subscriptions where plan_id = '${FREE}'`,
    );
    expect(row!.ok).toBe(true);
    const [bal] = await q<{ b: string }>(
      `select balance_micro::text as b from credit_balances where user_id = 'u_pro'`,
    );
    expect(bal!.b).toBe("7000000");
  });

  it("enqueues update_limits for every non-deleted workspace", async () => {
    const rows = await q<{ slug: string; type: string; status: string }>(
      `select w.slug, j.type, j.status from jobs j join workspaces w on w.id = j.workspace_id order by w.slug`,
    );
    expect(rows).toEqual([
      { slug: "free1", type: "update_limits", status: "queued" },
      { slug: "pro1", type: "update_limits", status: "queued" },
    ]);
  });
});
