import { createAgentClient } from "../../src/agent-client.ts";
import type { Config } from "../../src/config.ts";
import { silentLogger } from "../../src/log.ts";
import type { Ctx, Db } from "../../src/types.ts";
import { ENC_KEY } from "./seed.ts";
import { TOKEN } from "./fake-agent.ts";

export const BASE_DOMAIN = "agentbox.io.vn";

export const testConfig: Config = {
  baseDomain: BASE_DOMAIN,
  appOrigin: `https://app.${BASE_DOMAIN}`,
  port: 0,
  agentSocket: "/nonexistent",
  agentToken: TOKEN,
  encryptionKey: ENC_KEY,
  gitOAuth: {},
  logLevel: "error",
};

export interface Clock {
  now(): Date;
  set(d: Date): void;
  advance(ms: number): void;
}
export function createClock(start = new Date("2026-03-10T12:00:00.000Z")): Clock {
  let t = start.getTime();
  return {
    now: () => new Date(t),
    set: (d) => void (t = d.getTime()),
    advance: (ms) => void (t += ms),
  };
}

export function makeCtx(
  db: Db,
  clock: Clock,
  opts: { socketPath?: string; agent?: Partial<Ctx["agent"]> } = {},
): Ctx {
  const real = createAgentClient({
    socketPath: opts.socketPath ?? "/nonexistent",
    token: TOKEN,
  });
  return {
    db,
    config: testConfig,
    log: silentLogger,
    now: clock.now,
    agent: { ...real, ...opts.agent },
  };
}
