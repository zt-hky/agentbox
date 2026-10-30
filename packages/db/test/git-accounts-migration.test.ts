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

/** Every migration before 0011 (git accounts): production's shape before this change. */
function before0011(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "abx-mig-"));
  cpSync(FULL, dir, { recursive: true });
  const journalPath = path.join(dir, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as { entries: { idx: number }[] };
  journal.entries = journal.entries.filter((e) => e.idx <= 10);
  writeFileSync(journalPath, JSON.stringify(journal));
  return dir;
}

describe("0011 git accounts migration on a populated database", () => {
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
    await migrate(db, { migrationsFolder: before0011() });
    await pool.query(`
      INSERT INTO "user" (id, name, email, email_verified, access_status) VALUES
        ('u_a','a','a@x.io',true,'active'), ('u_b','b','b@x.io',true,'active');
      INSERT INTO workspaces (user_id, slug, slot, status, identity_secret_enc, github_sync_pending) VALUES
        ('u_a','wsa',1,'running','x',true), ('u_b','wsb',2,'running','x',false);
      INSERT INTO github_connections (user_id, login, github_id, token_enc, scopes, created_at) VALUES
        ('u_a','octo',12345678901,'v1.tok','repo,read:org','2026-10-01Z');
      INSERT INTO jobs (type, workspace_id, status)
        SELECT 'sync_github', id, 'queued' FROM workspaces WHERE slug = 'wsa';
      INSERT INTO jobs (type, workspace_id, status)
        SELECT 'sync_github', id, 'done' FROM workspaces WHERE slug = 'wsb';
    `);
    await migrate(db, { migrationsFolder: FULL });
  });
  afterAll(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
    await admin.end();
  });

  it("moves github_connections rows to git_connections and drops the old table", async () => {
    expect(
      await q(
        `select user_id, provider, host, method, login, provider_user_id, token_enc, scopes, status, ssh_key_id, refresh_token_enc, expires_at, created_at::text from git_connections`,
      ),
    ).toEqual([
      {
        user_id: "u_a",
        provider: "github",
        host: "github.com",
        method: "oauth",
        login: "octo",
        provider_user_id: "12345678901",
        token_enc: "v1.tok",
        scopes: "repo,read:org",
        status: "active",
        ssh_key_id: null,
        refresh_token_enc: null,
        expires_at: null,
        created_at: expect.stringContaining("2026-10-01"),
      },
    ]);
    expect(await q(`select to_regclass('github_connections') as t`)).toEqual([{ t: null }]);
  });

  it("enforces one connection per user and host", async () => {
    await expect(
      pool.query(
        `INSERT INTO git_connections (user_id, provider, host, method, login, token_enc) VALUES ('u_a','generic','github.com','token','x','y')`,
      ),
    ).rejects.toThrow();
  });

  it("cascades connections when the user is deleted", async () => {
    await pool.query(
      `INSERT INTO "user" (id, name, email, email_verified, access_status) VALUES ('u_c','c','c@x.io',true,'active')`,
    );
    await pool.query(
      `INSERT INTO git_connections (user_id, provider, host, method, login, token_enc) VALUES ('u_c','gitea','git.example.com','token','c','t')`,
    );
    await pool.query(`DELETE FROM "user" WHERE id = 'u_c'`);
    expect(await q(`select 1 from git_connections where user_id = 'u_c'`)).toEqual([]);
  });

  it("renames the pending flag keeping its value and adds the ssh key column", async () => {
    expect(
      await q(`select slug, git_sync_pending, ssh_public_key from workspaces order by slug`),
    ).toEqual([
      { slug: "wsa", git_sync_pending: true, ssh_public_key: null },
      { slug: "wsb", git_sync_pending: false, ssh_public_key: null },
    ]);
  });

  it("converts sync_github jobs to sync_git", async () => {
    expect(await q(`select type, status from jobs order by status`)).toEqual([
      { type: "sync_git", status: "done" },
      { type: "sync_git", status: "queued" },
    ]);
  });
});
