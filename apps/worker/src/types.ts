import type { Db } from "@agentbox/db/client";
import type { AgentClient } from "./agent-client.ts";
import type { Config } from "./config.ts";
import type { Logger } from "./log.ts";

export type { Db };
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type Executor = Db | Tx;

export interface Ctx {
  db: Db;
  config: Config;
  agent: AgentClient;
  now: () => Date;
  log: Logger;
}
