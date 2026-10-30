import { describe, expect, it } from "vitest";
import {
  buildArgv,
  envFileContent,
  logToFileArgv,
  podmanRunArgv,
  quotaArgv,
  sliceDropin,
  transportPrefix,
  userDropin,
} from "../src/argv.ts";

const IMAGE = "a".repeat(64);
const argv = podmanRunArgv({
  ws: "alice",
  slot: 7,
  imageId: IMAGE,
  limits: { cpus: 2, memoryMb: 4096, pidsLimit: 2048, inodes: 2000000 },
});

describe("podman run argv", () => {
  it("contains every security and resource flag", () => {
    const joined = argv.join(" ");
    for (const flag of [
      "--read-only",
      "--rootfs",
      "--userns=keep-id:uid=1000,gid=1000",
      "--user 1000:1000",
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges",
      "--network pasta:--no-map-gw,--ipv4-only,--map-guest-addr,none",
      "--dns 1.1.1.1",
      "--dns 1.0.0.1",
      "-p 127.0.0.1:20014:3773",
      "-p 127.0.0.1:20015:8080",
      "--memory 4096m",
      "--memory-swap 4096m",
      "--oom-score-adj 1000",
      "--cpus 2",
      "--pids-limit 2048",
      "--ulimit nproc=2304:2304",
      "--ulimit nofile=65536:65536",
      "--ulimit core=0",
      "--tmpfs /tmp:rw,nosuid,nodev,size=2g,mode=1777",
      "--tmpfs /var/tmp:rw,nosuid,nodev,size=512m,mode=1777",
      "--tmpfs /run:rw,nosuid,nodev,size=64m",
      "--shm-size 256m",
      "-v /srv/agentbox/tenants/alice/workspace:/workspace:rw,nosuid,nodev",
      "--env HOME=/workspace/home",
      "--env-file /srv/agentbox/tenants/alice/t3.env",
      "--log-driver k8s-file",
      "--init",
      "--stop-timeout 20",
      "--label agentbox.workspace=alice",
      "-d",
      "--replace",
      "--name abx-ws",
      "--hostname alice",
    ]) {
      expect(joined, flag).toContain(flag);
    }
    expect(argv.slice(-2)).toEqual([
      `/srv/agentbox/rootfs/${IMAGE}`,
      "/opt/agentbox/bin/workspace-init",
    ]);
  });

  it("never contains forbidden options", () => {
    const joined = argv.join(" ");
    for (const bad of [
      "--privileged",
      "--cap-add",
      "--device",
      "--pid=host",
      "--pid host",
      "--ipc=host",
      "--uts=host",
      "--userns=host",
      "--network host",
      "--network=host",
      "--net host",
      "seccomp=unconfined",
      "label=disable",
      "apparmor=unconfined",
      "podman.sock",
      "docker.sock",
      "--security-opt=systempaths",
      "--read-only=false",
      "--add-host",
    ]) {
      expect(joined, bad).not.toContain(bad);
    }
    expect(argv.filter((a) => a === "-v")).toHaveLength(1);
    expect(argv).not.toContain("apparmor=agentbox-sandbox");
  });

  it("uses an argv array only (no shell invocation)", () => {
    expect(argv[0]).toBe("podman");
    expect(argv).not.toContain("sh");
    expect(argv).not.toContain("-c");
  });
});

describe("transport and helpers", () => {
  it("builds the validated tenant prefix", () => {
    expect(transportPrefix("abx-alice")).toEqual([
      "systemd-run",
      "--machine=abx-alice@",
      "--user",
      "--quiet",
      "--wait",
      "--pipe",
      "--collect",
    ]);
    expect(transportPrefix("abx-alice", { detached: true }).slice(-2)).toEqual([
      "-p",
      "KillMode=process",
    ]);
  });

  it("builds quota and drop-ins", () => {
    expect(quotaArgv(204998, 10, 2_000_000)).toEqual([
      "xfs_quota",
      "-x",
      "-c",
      "limit -u bsoft=9728m bhard=10g ihard=2000000 204998",
      "/srv/agentbox",
    ]);
    expect(userDropin("smoke", 204998)).toContain(
      "ReadWritePaths=/srv/agentbox/tenants/smoke /run/user/204998",
    );
    expect(userDropin("smoke", 204998)).not.toMatch(/ProtectHome|ProtectKernelLogs/);
    expect(sliceDropin({ cpus: 2, memoryMb: 4096, pidsLimit: 2048, inodes: 2000000 })).toBe(
      "[Slice]\nMemoryMax=4608M\nTasksMax=2560\nCPUQuota=250%\n",
    );
  });

  it("renders env files and rejects injection", () => {
    expect(envFileContent({ A_B: "x", C: "y" })).toBe("A_B=x\nC=y\n");
    expect(() => envFileContent({ A: "x\nB=1" })).toThrow();
    expect(() => envFileContent({ "A B": "x" })).toThrow();
  });

  it("passes log path positionally", () => {
    const a = logToFileArgv("/l/x.log", ["podman", "build", "."]);
    expect(a.slice(-4)).toEqual(["/l/x.log", "podman", "build", "."]);
    expect(a.slice(0, 3)[1]).toBe("-c");
  });

  it("builds slim only: no SLIM build arg", () => {
    expect(buildArgv("main", "repo:001", "/ctx")).toEqual([
      "podman",
      "build",
      "--pull=always",
      "--no-cache",
      "--build-arg",
      "T3_REF=main",
      "-t",
      "repo:001",
      "/ctx",
    ]);
  });
});
