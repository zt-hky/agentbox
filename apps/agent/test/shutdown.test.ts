import { describe, expect, it } from "vitest";
import { isHostShuttingDown } from "../src/shutdown.ts";

const jobs = (line: string) =>
  `JOB UNIT                          TYPE  STATE\n${line}\n\n1 jobs listed.\n`;

describe("isHostShuttingDown", () => {
  it("detects the stopping state", () => {
    expect(isHostShuttingDown("stopping\n", "No jobs running.\n")).toBe(true);
  });
  it("detects queued shutdown targets", () => {
    expect(isHostShuttingDown("running\n", jobs("1234 reboot.target start waiting"))).toBe(true);
    expect(isHostShuttingDown("running\n", jobs("1 poweroff.target start running"))).toBe(true);
  });
  it("is false for a plain service restart", () => {
    expect(isHostShuttingDown("running\n", jobs("55 agentbox-agent.service restart running"))).toBe(
      false,
    );
    expect(isHostShuttingDown("degraded\n", "No jobs running.\n")).toBe(false);
    expect(isHostShuttingDown("", "")).toBe(false);
  });
  it("ignores stop jobs of a target", () => {
    expect(isHostShuttingDown("running\n", jobs("9 reboot.target stop waiting"))).toBe(false);
  });
});
