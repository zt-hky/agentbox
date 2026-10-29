import { describe, expect, it } from "vitest";
import { planSchema } from "../lib/schemas";

const base = {
  name: "Pro",
  kind: "package",
  monthlyPrice: "139",
  cpuLimit: "2",
  memoryLimitMb: "4096",
  diskLimitGb: "20",
  pidsLimit: "2048",
  inodesLimit: "2000000",
  allowanceRuntimeHours: "200",
  allowanceCpuCoreHours: "400",
  allowanceMemGbHours: "800",
  trialDays: "",
  dailyRuntimeHours: "",
  maxAwakeHours: "12",
  idleTimeoutMinutes: "30",
  sortOrder: "1",
  public: true,
  active: true,
};

describe("planSchema", () => {
  it("turns blank optional fields into null and parses the rest", () => {
    const out = planSchema.parse(base);
    expect(out).toMatchObject({
      trialDays: null,
      dailyRuntimeHours: null,
      maxAwakeHours: 12,
      idleTimeoutMinutes: 30,
      inodesLimit: 2_000_000,
      sortOrder: 1,
      public: true,
    });
  });
  it("accepts a trial plan with a daily cap", () => {
    const out = planSchema.parse({ ...base, kind: "free", trialDays: "5", dailyRuntimeHours: "6" });
    expect(out).toMatchObject({ trialDays: 5, dailyRuntimeHours: 6 });
  });
  it("rejects out-of-range optional values", () => {
    expect(planSchema.safeParse({ ...base, dailyRuntimeHours: "25" }).success).toBe(false);
    expect(planSchema.safeParse({ ...base, trialDays: "0" }).success).toBe(false);
    expect(planSchema.safeParse({ ...base, idleTimeoutMinutes: "1.5" }).success).toBe(false);
  });
});
