import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AgentError, createAgentClient } from "../src/agent-client.ts";
import { IMAGE_ID, TOKEN, startFakeAgent, type FakeAgent } from "./helpers/fake-agent.ts";

let agent: FakeAgent;
beforeAll(async () => {
  agent = await startFakeAgent();
});
afterAll(() => agent.close());

const client = (over = {}) =>
  createAgentClient({ socketPath: agent.socketPath, token: TOKEN, ...over });

describe("agent client", () => {
  it("sends bearer auth and JSON bodies over the unix socket", async () => {
    await client().stopWorkspace("alice");
    const [c] = agent.callsTo("POST /v1/workspaces/alice/stop");
    expect(c!.auth).toBe(`Bearer ${TOKEN}`);
  });

  it("surfaces the agent's {error} body with the status", async () => {
    agent.on("POST /v1/workspaces/alice/start", {
      status: 409,
      json: { error: "image rootfs missing" },
    });
    const err = await client()
      .startWorkspace("alice", {
        imageId: IMAGE_ID,
        slot: 1,
        limits: { cpus: 1, memoryMb: 512, pidsLimit: 100 },
        env: { T3CODE_GATEWAY_IDENTITY_SECRET: "s", T3CODE_GATEWAY_IDENTITY_AUDIENCE: "alice" },
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgentError);
    expect(err).toMatchObject({ message: "image rootfs missing", status: 409 });
  });

  it("rejects responses that fail the core schema", async () => {
    agent.on("GET /v1/stats", { json: { host: {} } });
    await expect(client().stats()).rejects.toThrow(/invalid response/);
  });

  it("rejects a wrong token with the agent's 401 error", async () => {
    await expect(client({ token: "wrong" }).stopWorkspace("alice")).rejects.toMatchObject({
      status: 401,
      message: "unauthorized",
    });
  });

  it("times out and reports a transport error when the agent never answers", async () => {
    agent.on("POST /v1/workspaces/hang/stop", "hang");
    await expect(client({ timeoutMs: 25 }).stopWorkspace("hang")).rejects.toThrow(/timed out/);
  });

  it("fails clearly when the socket does not exist", async () => {
    await expect(
      createAgentClient({ socketPath: "/nonexistent/agent.sock", token: TOKEN }).stats(),
    ).rejects.toBeInstanceOf(AgentError);
  });
});
