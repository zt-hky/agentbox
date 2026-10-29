import type { TenantLimits } from "@agentbox/core/agent-api";
import { CONTAINER_NAME, ROOTFS_DIR, STOP_TIMEOUT_SEC, TENANTS_DIR } from "./config.ts";

/** Pure argv builders. Everything the agent executes is an argv array; nothing goes through a shell. */

export function tenantHome(ws: string): string {
  return `${TENANTS_DIR}/${ws}`;
}
export function rootfsPath(imageId: string): string {
  return `${ROOTFS_DIR}/${imageId}`;
}

/** Transport validated in host-validation.md A: run `argv` in the tenant's user manager. */
export function transportPrefix(user: string, opts: { detached?: boolean } = {}): string[] {
  return [
    "systemd-run",
    `--machine=${user}@`,
    "--user",
    "--quiet",
    "--wait",
    "--pipe",
    "--collect",
    ...(opts.detached ? ["-p", "KillMode=process"] : []),
  ];
}

export function tenantUser(ws: string): string {
  return `abx-${ws}`;
}

export interface RunArgvInput {
  ws: string;
  slot: number;
  imageId: string;
  limits: TenantLimits;
}

/** The Agent-contract `podman run` argv (host-validation.md); AppArmor option intentionally absent. */
export function podmanRunArgv({ ws, slot, imageId, limits }: RunArgvInput): string[] {
  const t3 = 20000 + 2 * slot;
  const code = 20001 + 2 * slot;
  const mem = `${limits.memoryMb}m`;
  const pids = limits.pidsLimit;
  const nproc = `${pids + 256}:${pids + 256}`;
  const home = tenantHome(ws);
  return [
    "podman",
    "run",
    "-d",
    "--replace",
    "--name",
    CONTAINER_NAME,
    "--hostname",
    ws,
    "--rootfs",
    "--read-only",
    "--userns=keep-id:uid=1000,gid=1000",
    "--user",
    "1000:1000",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    "--network",
    "pasta:--no-map-gw,--ipv4-only,--map-guest-addr,none",
    "--dns",
    "1.1.1.1",
    "--dns",
    "1.0.0.1",
    "-p",
    `127.0.0.1:${t3}:3773`,
    "-p",
    `127.0.0.1:${code}:8080`,
    "--memory",
    mem,
    "--memory-swap",
    mem,
    "--oom-score-adj",
    "1000",
    "--cpus",
    String(limits.cpus),
    "--pids-limit",
    String(pids),
    "--ulimit",
    `nproc=${nproc}`,
    "--ulimit",
    "nofile=65536:65536",
    "--ulimit",
    "core=0",
    "--tmpfs",
    "/tmp:rw,nosuid,nodev,size=2g,mode=1777",
    "--tmpfs",
    "/var/tmp:rw,nosuid,nodev,size=512m,mode=1777",
    "--tmpfs",
    "/run:rw,nosuid,nodev,size=64m",
    "--shm-size",
    "256m",
    "-v",
    `${home}/workspace:/workspace:rw,nosuid,nodev`,
    "--workdir",
    "/workspace",
    "--env",
    "HOME=/workspace/home",
    "--env-file",
    `${home}/t3.env`,
    "--log-driver",
    "k8s-file",
    "--log-opt",
    "max-size=10mb",
    "--init",
    "--stop-timeout",
    String(STOP_TIMEOUT_SEC),
    "--label",
    `agentbox.workspace=${ws}`,
    rootfsPath(imageId),
    "/opt/agentbox/bin/workspace-init",
  ];
}

/** Writes stdin to a file with mode 0600, running as the tenant. */
export function writeSecretFileArgv(path: string): string[] {
  return ["sh", "-c", 'umask 077; cat > "$1" && chmod 600 "$1"', "sh", path];
}

export function envFileContent(env: Record<string, string>): string {
  const lines: string[] = [];
  for (const [k, v] of Object.entries(env)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) throw new Error(`invalid env name ${k}`);
    if (/[\r\n\0]/.test(v)) throw new Error(`invalid characters in env value for ${k}`);
    lines.push(`${k}=${v}`);
  }
  return `${lines.join("\n")}\n`;
}

export function quotaArgv(uid: number, diskGb: number): string[] {
  const soft = Math.floor(diskGb * 1024 * 0.95);
  return [
    "xfs_quota",
    "-x",
    "-c",
    `limit -u bsoft=${soft}m bhard=${diskGb}g ihard=4000000 ${uid}`,
    "/srv/agentbox",
  ];
}

export function clearQuotaArgv(uid: number): string[] {
  return ["xfs_quota", "-x", "-c", `limit -u bsoft=0 bhard=0 ihard=0 ${uid}`, "/srv/agentbox"];
}

export function userDropin(ws: string, uid: number): string {
  return [
    // Monitoring tools (Beszel) list user@<U>.service; the description names the workspace.
    "[Unit]",
    `Description=AgentBox workspace ${ws}`,
    "",
    "[Service]",
    "PrivateTmp=yes",
    "ProtectSystem=strict",
    `ReadWritePaths=${tenantHome(ws)} /run/user/${uid}`,
    "InaccessiblePaths=-/home -/root",
    "ProtectKernelModules=yes",
    "ProtectClock=yes",
    "LockPersonality=yes",
    "",
  ].join("\n");
}

export function sliceDropin(limits: TenantLimits): string {
  return [
    "[Slice]",
    `MemoryMax=${limits.memoryMb + 512}M`,
    `TasksMax=${limits.pidsLimit + 512}`,
    `CPUQuota=${Math.round(limits.cpus * 100 + 50)}%`,
    "",
  ].join("\n");
}

export function buildArgv(t3Ref: string, tag: string, context: string): string[] {
  return [
    "podman",
    "build",
    "--pull=always",
    "--no-cache",
    "--build-arg",
    `T3_REF=${t3Ref}`,
    "-t",
    tag,
    context,
  ];
}

/** Runs `argv` with stdout+stderr appended to `logPath` (written by the invoking user). */
export function logToFileArgv(logPath: string, argv: string[]): string[] {
  return ["sh", "-c", 'log=$1; shift; exec "$@" >>"$log" 2>&1', "sh", logPath, ...argv];
}

export function trivyArgv(rootfsDir: string, cacheDir: string, image: string): string[] {
  return [
    "podman",
    "run",
    "--rm",
    "-v",
    `${rootfsDir}:/rootfs:ro`,
    "-v",
    `${cacheDir}:/root/.cache/trivy`,
    image,
    "rootfs",
    "--scanners",
    "vuln",
    "--format",
    "json",
    "--quiet",
    "/rootfs",
  ];
}
