import { chmod, chown, rm } from "node:fs/promises";
import { CP_USER, SOCKET_PATH } from "./config.ts";
import { run } from "./exec.ts";
import { startFirewallSync } from "./firewall.ts";
import { cleanStaleRootfsTmp } from "./images.ts";
import { reconcile, stopAll } from "./lifecycle.ts";
import { errMessage, logEvent } from "./log.ts";
import { ensureRootfs } from "./rootfs.ts";
import { createAgentServer } from "./server.ts";

async function main(): Promise<void> {
  // Hidden helper: apply the rootfs fixups to an already-extracted tree (used to import a local image).
  if (process.argv[2] === "--prepare-rootfs") {
    const dir = process.argv[3] ?? "";
    if (!/^\/srv\/agentbox\/rootfs\/[^/]+$/.test(dir))
      throw new Error("usage: --prepare-rootfs /srv/agentbox/rootfs/<name>");
    await ensureRootfs(dir);
    console.log(`prepared ${dir}`);
    return;
  }

  const token = process.env.AGENTBOX_AGENT_TOKEN ?? "";
  if (token.length < 16) throw new Error("AGENTBOX_AGENT_TOKEN missing or too short");
  if (process.getuid?.() !== 0) throw new Error("the agent must run as root");

  const server = createAgentServer(token);
  await rm(SOCKET_PATH, { force: true });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(SOCKET_PATH, () => resolve());
  });
  const uid = Number((await run("id", ["-u", CP_USER])).stdout.trim());
  const gid = Number((await run("id", ["-g", CP_USER])).stdout.trim());
  await chown(SOCKET_PATH, uid, gid);
  await chmod(SOCKET_PATH, 0o600);
  logEvent({ event: "listening" });

  await reconcile();
  await cleanStaleRootfsTmp();
  const stopFirewall = await startFirewallSync();

  let stopping = false;
  const shutdown = (signal: string) => {
    if (stopping) return;
    stopping = true;
    logEvent({ event: "shutdown", signal });
    stopFirewall();
    server.close();
    void stopAll().finally(() => process.exit(0));
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((e) => {
  logEvent({ event: "fatal", error: errMessage(e) });
  process.exit(1);
});
