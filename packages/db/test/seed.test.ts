import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { billingSettingsSchema } from "@agentbox/core/settings";

const seed = readFileSync(new URL("../drizzle/0001_seed.sql", import.meta.url), "utf8");

describe("seed migration", () => {
  it("billing.defaultPlanId points at the Free plan row", () => {
    const m = /'billing', '(\{.*?\})'::jsonb/.exec(seed);
    const parsed = billingSettingsSchema.parse(JSON.parse(m![1]!));
    expect(seed).toContain(`('${parsed.defaultPlanId}', 'Free', 'free'`);
  });
});
