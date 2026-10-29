import { z } from "zod";
import { isValidWorkspaceSlug } from "@agentbox/core/hosts";
import {
  billingSettingsSchema,
  capacitySettingsSchema,
  hibernationSettingsSchema,
} from "@agentbox/core/settings";

export const slugSchema = z
  .string()
  .trim()
  .refine(
    isValidWorkspaceSlug,
    "3-20 chars, lowercase letters and digits, starting with a letter, not reserved",
  );

export const accessRequestSchema = z.object({
  slug: slugSchema,
  message: z.string().trim().max(500, "Keep it under 500 characters"),
});

export const grantSchema = z.object({
  userId: z.string().min(1).max(128),
  slug: slugSchema,
  planId: z.uuid(),
});

export const rejectSchema = z.object({
  requestId: z.uuid(),
  reason: z.string().trim().min(1, "A reason is required").max(500),
});

const creditAmount = z
  .string()
  .trim()
  .regex(/^\d{1,12}(\.\d{1,6})?$/, "Enter a decimal amount, e.g. 5 or 2.5");

export const creditAdjustSchema = z.object({
  userId: z.string().min(1),
  direction: z.enum(["add", "remove"]),
  amount: creditAmount,
  note: z.string().trim().min(1, "A note is required").max(500),
});

/** Optional number field from a text input: blank -> null. */
const optionalNumber = (schema: z.ZodNumber) =>
  z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? null : v),
    z.coerce.number().pipe(schema).nullable(),
  );

export const planSchema = z.object({
  name: z.string().trim().min(1).max(60),
  kind: z.enum(["free", "package", "payg"]),
  monthlyPrice: creditAmount.or(z.literal("0")),
  cpuLimit: z.coerce.number().positive().max(64),
  memoryLimitMb: z.coerce.number().int().min(256).max(262144),
  diskLimitGb: z.coerce.number().int().min(1).max(10000),
  pidsLimit: z.coerce.number().int().min(64).max(65536),
  inodesLimit: z.coerce.number().int().min(1000).max(1_000_000_000),
  allowanceRuntimeHours: z.coerce.number().min(0),
  allowanceCpuCoreHours: z.coerce.number().min(0),
  allowanceMemGbHours: z.coerce.number().min(0),
  trialDays: optionalNumber(z.number().int().min(1).max(365)),
  dailyRuntimeHours: optionalNumber(z.number().positive().max(24)),
  maxAwakeHours: optionalNumber(z.number().positive().max(720)),
  idleTimeoutMinutes: optionalNumber(z.number().int().min(1).max(10080)),
  sortOrder: z.coerce.number().int().min(0).max(1000),
  public: z.boolean(),
  active: z.boolean(),
});
export type PlanFormValues = z.input<typeof planSchema>;

export const planChangeSchema = z.object({
  userId: z.string().min(1).max(128),
  planId: z.uuid(),
  /** `charge`: debit the first month now; `waive`: start the cycle without a fee (audited). */
  fee: z.enum(["charge", "waive"]),
});

export const priceSchema = z.object({
  runtimePerHour: creditAmount,
  cpuCorePerHour: creditAmount,
  memGbPerHour: creditAmount,
});

export const t3RefSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/, "Enter a valid git branch, tag or commit");

export { billingSettingsSchema, capacitySettingsSchema, hibernationSettingsSchema };
