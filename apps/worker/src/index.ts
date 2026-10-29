import http from "node:http";
import { closeDb, db, runMigrations } from "@agentbox/db/client";
import { createAgentClient } from "./agent-client.ts";
import { loadConfig } from "./config.ts";
import { startCycleLoop } from "./cycle.ts";
import { createGateway } from "./gateway.ts";
import { JobRunner } from "./jobs.ts";
import { createLogger, errMessage } from "./log.ts";
import { startMeteringLoop } from "./metering.ts";
import type { Ctx } from "./types.ts";

const SHUTDOWN_GRACE_MS = 30_000;

async function main(): Promise<void> {
  const config = loadConfig();
  const log = createLogger(config.logLevel);
  await runMigrations();
  log.info("migrations applied");

  const ctx: Ctx = {
    db,
    config,
    log,
    now: () => new Date(),
    agent: createAgentClient({ socketPath: config.agentSocket, token: config.agentToken }),
  };

  const runner = new JobRunner(ctx);
  const recovered = await runner.recoverRunning();
  if (recovered > 0)
    log.warn("requeued jobs left running by a previous worker", { count: recovered });

  const server = http.createServer(createGateway(ctx));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, "0.0.0.0", resolve);
  });
  log.info("gateway-auth listening", { port: config.port });

  runner.start();
  const stopMetering = startMeteringLoop(ctx);
  const stopCycle = startCycleLoop(ctx);

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info("shutting down", { signal });
    stopMetering();
    stopCycle();
    server.close();
    server.closeIdleConnections();
    const left = await runner.stop(SHUTDOWN_GRACE_MS);
    if (left > 0)
      log.warn("exiting with jobs still running; they are requeued on next start", { left });
    server.closeAllConnections();
    await closeDb();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((e) => {
  process.stderr.write(`worker failed to start: ${errMessage(e)}\n`);
  process.exit(1);
});
