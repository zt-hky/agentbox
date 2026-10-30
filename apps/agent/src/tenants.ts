import { mkdir, readFile, rm, stat, writeFile, chmod } from "node:fs/promises";
import type { CreateTenantRequest, UpdateLimitsRequest } from "@agentbox/core/agent-api";
import { subuidStart, tenantUid } from "@agentbox/core/slots";
import {
  clearQuotaArgv,
  quotaArgv,
  sliceDropin,
  tenantHome,
  tenantUser,
  userDropin,
} from "./argv.ts";
import { CONTAINER_NAME } from "./config.ts";
import { HttpError } from "./errors.ts";
import { run, runAs } from "./exec.ts";
import { logEvent } from "./log.ts";
import { isTenantUid } from "./safe.ts";
import { registry, withLock } from "./state.ts";

export interface Tenant {
  uid: number;
  gid: number;
  home: string;
}

export async function lookupTenant(ws: string): Promise<Tenant | null> {
  const r = await run("getent", ["passwd", tenantUser(ws)], { check: false });
  if (r.code !== 0) return null;
  const f = r.stdout.trim().split(":");
  const uid = Number(f[2]);
  const gid = Number(f[3]);
  if (!isTenantUid(uid))
    throw new HttpError(409, `${tenantUser(ws)} exists with a uid outside the tenant range`);
  return { uid, gid, home: f[5] ?? tenantHome(ws) };
}

export async function requireTenant(ws: string): Promise<Tenant> {
  const t = await lookupTenant(ws);
  if (!t) throw new HttpError(404, `tenant ${ws} not found`);
  return t;
}

/** `/run/user/U` outlives the manager for lingering users, so ask systemd. */
export const userManagerUp = (uid: number) =>
  run("systemctl", ["is-active", "--quiet", `user@${uid}.service`], { check: false }).then(
    (r) => r.code === 0,
  );

export const startUserManager = (uid: number) => run("systemctl", ["start", `user@${uid}.service`]);
export const stopUserManager = (uid: number) =>
  run("systemctl", ["stop", `user@${uid}.service`], { timeoutMs: 60_000 });

async function ensureSubids(ws: string, start: number): Promise<void> {
  const want = `${tenantUser(ws)}:${start}:65536`;
  const has = async (file: string) =>
    (await readFile(file, "utf8").catch(() => "")).split("\n").some((l) => l === want);
  const end = start + 65535;
  if (!(await has("/etc/subuid")))
    await run("usermod", ["--add-subuids", `${start}-${end}`, tenantUser(ws)]);
  if (!(await has("/etc/subgid")))
    await run("usermod", ["--add-subgids", `${start}-${end}`, tenantUser(ws)]);
}

async function writeDropins(
  ws: string,
  uid: number,
  limits: UpdateLimitsRequest["limits"],
): Promise<void> {
  const userDir = `/etc/systemd/system/user@${uid}.service.d`;
  const sliceDir = `/etc/systemd/system/user-${uid}.slice.d`;
  await mkdir(userDir, { recursive: true, mode: 0o755 });
  await mkdir(sliceDir, { recursive: true, mode: 0o755 });
  await writeFile(`${userDir}/agentbox.conf`, userDropin(ws, uid), { mode: 0o644 });
  await writeFile(`${sliceDir}/agentbox.conf`, sliceDropin(limits), { mode: 0o644 });
}

export function createTenant(req: CreateTenantRequest): Promise<void> {
  return withLock(req.ws, async () => {
    const t0 = Date.now();
    const { ws } = req;
    const uid = tenantUid(req.slot);
    const start = subuidStart(req.slot);
    const user = tenantUser(ws);
    const home = tenantHome(ws);

    const existing = await lookupTenant(ws);
    if (existing && existing.uid !== uid) {
      throw new HttpError(409, `${user} exists with uid ${existing.uid}, requested ${uid}`);
    }
    if (!existing) {
      const owner = await run("getent", ["passwd", String(uid)], { check: false });
      if (owner.code === 0)
        throw new HttpError(409, `uid ${uid} already belongs to another account`);
      const grp = await run("getent", ["group", user], { check: false });
      if (grp.code !== 0) await run("groupadd", ["--gid", String(uid), user]);
      await run("useradd", [
        "--uid",
        String(uid),
        "--gid",
        String(uid),
        "--home-dir",
        home,
        "--create-home",
        "--skel",
        "/dev/null",
        "--shell",
        "/usr/sbin/nologin",
        user,
      ]);
      await run("passwd", ["-l", user]);
    }
    await ensureSubids(ws, start);
    // A kept home (delete with keepData) already exists: `useradd --create-home` leaves it alone, so
    // hand the directory itself back to the account (contents keep the uid; slot and uid are reused).
    if (!existing) await run("chown", [`${uid}:${uid}`, home]);
    await chmod(home, 0o700);

    await writeDropins(ws, uid, req.limits);
    await run("systemctl", ["daemon-reload"]);
    await run("xfs_quota", quotaArgv(uid, req.diskGb, req.limits.inodes).slice(1));
    await run("loginctl", ["enable-linger", user]);

    const workspaceDir = `${home}/workspace`;
    const hasWorkspace = await stat(workspaceDir).then(
      (s) => s.isDirectory(),
      () => false,
    );
    if (!hasWorkspace) {
      await startUserManager(uid);
      await runAs(user, ["install", "-d", "-m", "0700", workspaceDir]);
      if (!registry.has(ws)) await stopUserManager(uid);
    }
    logEvent({
      ws,
      event: existing ? "tenant_reconciled" : "tenant_created",
      durationMs: Date.now() - t0,
    });
  });
}

export function updateLimits(ws: string, req: UpdateLimitsRequest): Promise<void> {
  return withLock(ws, async () => {
    const t = await requireTenant(ws);
    await run("xfs_quota", quotaArgv(t.uid, req.diskGb, req.limits.inodes).slice(1));
    await writeDropins(ws, t.uid, req.limits);
    await run("systemctl", ["daemon-reload"]);
    logEvent({ ws, event: "limits_updated" });
  });
}

/**
 * Remove the tenant's container, quota, subids and host account. `keepData` leaves the tenant home
 * (`/workspace`: dotfiles, tool and agent config, projects) in place; `createTenant` for the same
 * slug and slot adopts it again.
 */
export function deleteTenant(ws: string, opts: { keepData?: boolean } = {}): Promise<void> {
  return withLock(ws, async () => {
    const t0 = Date.now();
    const user = tenantUser(ws);
    const tenant = await lookupTenant(ws);
    if (tenant) {
      const { uid } = tenant;
      if (await userManagerUp(uid)) {
        await runAs(user, ["podman", "rm", "-f", "-t", "20", CONTAINER_NAME], { check: false });
      }
      registry.delete(ws);
      await run("loginctl", ["disable-linger", user], { check: false });
      await stopUserManager(uid).catch(() => undefined);
      await run("loginctl", ["terminate-user", user], { check: false });
      await run("xfs_quota", clearQuotaArgv(uid).slice(1), { check: false });
      const start = subuidStart(uid - 200000);
      const range = `${start}-${start + 65535}`;
      await run("usermod", ["--del-subuids", range, "--del-subgids", range, user], {
        check: false,
      });
      let lastErr = "";
      for (let i = 0; i < 6; i++) {
        const r = await run("userdel", [user], { check: false });
        if (r.code === 0 || r.code === 6) {
          lastErr = "";
          break;
        }
        lastErr = r.stderr.trim();
        await run("loginctl", ["terminate-user", user], { check: false });
        await new Promise((res) => setTimeout(res, 1000));
      }
      if (lastErr) throw new HttpError(500, `userdel ${user} failed: ${lastErr.slice(0, 300)}`);
      const grp = await run("getent", ["group", user], { check: false });
      if (grp.code === 0) await run("groupdel", [user], { check: false });
      for (const d of [
        `/etc/systemd/system/user@${uid}.service.d`,
        `/etc/systemd/system/user-${uid}.slice.d`,
      ]) {
        await rm(d, { recursive: true, force: true });
      }
    }
    registry.delete(ws);
    if (!opts.keepData) await run("rm", ["-rf", "--one-file-system", "--", tenantHome(ws)]);
    await run("systemctl", ["daemon-reload"]);
    logEvent({
      ws,
      event: opts.keepData ? "tenant_deleted_kept_data" : "tenant_deleted",
      durationMs: Date.now() - t0,
    });
  });
}
