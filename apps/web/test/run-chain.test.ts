import { describe, expect, it } from "vitest";
import { runChainItems } from "../lib/toolchain/run-chain";
import type { RunView } from "../lib/toolchain/view";

const base: RunView = {
  id: "r",
  status: "running",
  trigger: "user",
  open: true,
  generation: 1,
  plan: {
    steps: [
      { tool: "node", action: "install", from: null, to: "24.1.0" },
      { tool: "bun", action: "upgrade", from: "1.0.0", to: "1.1.0" },
      { tool: "python", action: "remove", from: "3.12.0", to: null },
    ],
    skipped: [],
    errors: [],
  },
  steps: [
    { tool: "node", action: "install", status: "ok", version: "24.1.0" },
    { tool: "bun", action: "install", status: "running", version: "1.1.0" },
  ],
  progress: { done: 1, total: 3 },
  error: null,
  logTail: "",
  createdAt: "2026-01-01T00:00:00.000Z",
  startedAt: null,
  finishedAt: null,
};

describe("runChainItems", () => {
  it("joins plan steps to agent records and marks the running one active", () => {
    const items = runChainItems(base);
    expect(items.map((i) => i.state)).toEqual(["done", "active", "pending"]);
    expect(items[0]!.label).toBe("Installed Node.js");
    expect(items[1]!.label).toMatch(/^Upgrading /);
    expect(items[1]!.detail).toBe("1.0.0 to 1.1.0");
  });

  it("stops animating when the run is no longer open", () => {
    const items = runChainItems({ ...base, open: false, status: "interrupted" });
    expect(items.some((i) => i.state === "active")).toBe(false);
  });

  it("surfaces a failed step error", () => {
    const items = runChainItems({
      ...base,
      steps: [{ tool: "node", action: "install", status: "failed", error: "disk full" }],
    });
    expect(items[0]).toMatchObject({ state: "failed", detail: "disk full" });
  });

  it("falls back to records when there is no plan", () => {
    const items = runChainItems({ ...base, plan: null });
    expect(items).toHaveLength(2);
  });
});
