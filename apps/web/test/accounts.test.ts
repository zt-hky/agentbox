import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  GITHUB_BASE_SCOPES,
  GITHUB_WORKFLOW_SCOPE,
  githubScopeString,
  hasGithubScope,
} from "@agentbox/core/accounts";
import {
  auditLog,
  githubConnections,
  jobs,
  workspaceIntegrations,
  workspaces,
} from "@agentbox/db/schema";
import {
  cancelOrSignOutCopilot,
  disconnectGithubAccount,
  getCopilotView,
  requestCopilotLogin,
} from "../lib/accounts";
import { UserError } from "../lib/errors";
import { authorizeUrl } from "../lib/github";
import { createTestDb, seedUser, type TestDb } from "./helpers/db";

let t: TestDb;
let n = 0;
const ip = "198.51.100.9";

beforeAll(async () => {
  t = await createTestDb();
});
afterAll(() => t.close());

async function seed(status: (typeof workspaces.$inferInsert)["status"]) {
  n++;
  const userId = await seedUser(t.db, `acc${n}@example.com`, "active");
  const [ws] = await t.db
    .insert(workspaces)
    .values({ userId, slug: `acc${n}x`, slot: 200 + n, status, identitySecretEnc: "x" })
    .returning();
  return { userId, ws: ws! };
}
const integration = async (workspaceId: string) =>
  (
    await t.db
      .select()
      .from(workspaceIntegrations)
      .where(
        and(
          eq(workspaceIntegrations.workspaceId, workspaceId),
          eq(workspaceIntegrations.kind, "copilot"),
        ),
      )
  )[0];
const jobTypes = async (workspaceId: string) =>
  (await t.db.select().from(jobs).where(eq(jobs.workspaceId, workspaceId))).map((j) => j.type);
const setStatus = (
  workspaceId: string,
  status: (typeof workspaceIntegrations.$inferInsert)["status"],
) =>
  t.db
    .update(workspaceIntegrations)
    .set({ status })
    .where(eq(workspaceIntegrations.workspaceId, workspaceId));
const audits = async (action: string) =>
  (await t.db.select().from(auditLog).where(eq(auditLog.action, action))).length;

describe("GitHub scopes", () => {
  it("default scopes are repo read:org gist; workflow is an explicit opt-in", () => {
    expect(githubScopeString(false)).toBe("repo read:org gist");
    expect(githubScopeString(true)).toBe("repo read:org gist workflow");
    expect([...GITHUB_BASE_SCOPES]).not.toContain(GITHUB_WORKFLOW_SCOPE);
    const cfg = { clientId: "cid", callbackPath: "/api/github/callback" };
    const plain = new URL(authorizeUrl(cfg, "st"));
    expect(plain.searchParams.get("scope")).toBe("repo read:org gist");
    const opt = new URL(authorizeUrl(cfg, "st", true));
    expect(opt.searchParams.get("scope")).toBe("repo read:org gist workflow");
  });

  it("reads granted scopes in GitHub's comma form and ours", () => {
    expect(hasGithubScope("gist,repo,workflow", "workflow")).toBe(true);
    expect(hasGithubScope("repo read:org gist", "workflow")).toBe(false);
    expect(hasGithubScope(null, "workflow")).toBe(false);
  });
});

describe("requestCopilotLogin", () => {
  it("needs a running workspace", async () => {
    const { userId, ws } = await seed("sleeping");
    await expect(requestCopilotLogin(t.db, { userId, ip })).rejects.toThrow(UserError);
    expect(await integration(ws.id)).toBeUndefined();
    expect(await jobTypes(ws.id)).toEqual([]);
  });

  it("records a starting row, queues copilot_login once, and audits", async () => {
    const { userId, ws } = await seed("running");
    const view = await requestCopilotLogin(t.db, { userId, ip });
    expect(view.status).toBe("starting");
    expect((await integration(ws.id))!.status).toBe("starting");
    expect(await jobTypes(ws.id)).toEqual(["copilot_login"]);
    // A second click while live reuses the session (no second job row).
    expect((await requestCopilotLogin(t.db, { userId, ip })).status).toBe("starting");
    expect(await jobTypes(ws.id)).toEqual(["copilot_login"]);
    const entries = await t.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "copilot.login_requested"));
    expect(entries.find((e) => e.targetId === ws.id)?.ip).toBe(ip);
  });

  it("refuses when already signed in, and while a sign-out is pending", async () => {
    const { userId, ws } = await seed("running");
    await requestCopilotLogin(t.db, { userId, ip });
    await setStatus(ws.id, "signed_in");
    await expect(requestCopilotLogin(t.db, { userId, ip })).rejects.toThrow(/already signed in/);
    await setStatus(ws.id, "signing_out");
    await expect(requestCopilotLogin(t.db, { userId, ip })).rejects.toThrow(/previous request/);
  });

  it("a failed or expired attempt can be retried from scratch", async () => {
    const { userId, ws } = await seed("running");
    await requestCopilotLogin(t.db, { userId, ip });
    await t.db
      .update(workspaceIntegrations)
      .set({ status: "expired", detail: { userCode: "AAAA-BBBB" } })
      .where(eq(workspaceIntegrations.workspaceId, ws.id));
    await t.db.delete(jobs).where(eq(jobs.workspaceId, ws.id));
    const view = await requestCopilotLogin(t.db, { userId, ip });
    expect(view.status).toBe("starting");
    expect((await integration(ws.id))!.detail).toEqual({});
    expect(await jobTypes(ws.id)).toEqual(["copilot_login"]);
  });
});

describe("cancelOrSignOutCopilot", () => {
  it("a live sign-in becomes cancelling (the worker loop kills the CLI); no sync job", async () => {
    const { userId, ws } = await seed("running");
    await requestCopilotLogin(t.db, { userId, ip });
    await cancelOrSignOutCopilot(t.db, { userId, ip });
    expect((await integration(ws.id))!.status).toBe("cancelling");
    expect(await jobTypes(ws.id)).not.toContain("sync_github");
  });

  it("a signed-in Copilot becomes signing_out and queues sync_github (works asleep too)", async () => {
    const { userId, ws } = await seed("sleeping");
    await t.db
      .insert(workspaceIntegrations)
      .values({ workspaceId: ws.id, kind: "copilot", status: "signed_in" });
    await cancelOrSignOutCopilot(t.db, { userId, ip });
    expect((await integration(ws.id))!.status).toBe("signing_out");
    expect(await jobTypes(ws.id)).toEqual(["sync_github"]);
    expect(await audits("copilot.signed_out")).toBeGreaterThan(0);
  });

  it("does nothing without a row", async () => {
    const { userId, ws } = await seed("running");
    await cancelOrSignOutCopilot(t.db, { userId, ip });
    expect(await jobTypes(ws.id)).toEqual([]);
  });
});

describe("disconnectGithubAccount", () => {
  const connect = (userId: string) =>
    t.db
      .insert(githubConnections)
      .values({ userId, login: "octo", githubId: 1n, tokenEnc: "enc", scopes: "repo" });

  it("removes the link, queues the reverse-state sync and marks Copilot for sign-out", async () => {
    const { userId, ws } = await seed("sleeping");
    await connect(userId);
    await t.db
      .insert(workspaceIntegrations)
      .values({ workspaceId: ws.id, kind: "copilot", status: "signed_in" });
    const conn = await disconnectGithubAccount(t.db, { userId, ip });
    expect(conn?.login).toBe("octo");
    expect(
      await t.db.select().from(githubConnections).where(eq(githubConnections.userId, userId)),
    ).toHaveLength(0);
    expect((await integration(ws.id))!.status).toBe("signing_out");
    expect(await jobTypes(ws.id)).toEqual(["sync_github"]);
    expect(await audits("github.disconnected")).toBeGreaterThan(0);
  });

  it("leaves a workspace without any Copilot row alone and is a no-op without a link", async () => {
    const { userId, ws } = await seed("running");
    expect(await disconnectGithubAccount(t.db, { userId, ip })).toBeNull();
    await connect(userId);
    await disconnectGithubAccount(t.db, { userId, ip });
    expect(await integration(ws.id)).toBeUndefined();
    expect(await jobTypes(ws.id)).toEqual(["sync_github"]);
  });

  it("a live Copilot sign-in is cancelled, not signed out", async () => {
    const { userId, ws } = await seed("running");
    await connect(userId);
    await requestCopilotLogin(t.db, { userId, ip });
    await disconnectGithubAccount(t.db, { userId, ip });
    expect((await integration(ws.id))!.status).toBe("cancelling");
  });
});

describe("getCopilotView", () => {
  it("reports workspace status and parsed detail", async () => {
    const { userId, ws } = await seed("running");
    expect(await getCopilotView(t.db, userId)).toEqual({
      workspaceStatus: "running",
      copilot: null,
    });
    await t.db.insert(workspaceIntegrations).values({
      workspaceId: ws.id,
      kind: "copilot",
      status: "code",
      detail: { userCode: "9B0A-2584", verificationUri: "https://github.com/login/device" },
    });
    const v = await getCopilotView(t.db, userId);
    expect(v.copilot?.status).toBe("code");
    expect(v.copilot?.detail.userCode).toBe("9B0A-2584");
  });
});
