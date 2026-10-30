import { z } from "zod";
import { toolchainDefaultsSchema, toolchainDisabledSchema } from "./toolchain/catalog.ts";

export const hibernationSettingsSchema = z.object({
  idleTimeoutMinutes: z.number().positive(),
  idleCpuPercent: z.number().min(0),
  idleNetBytesPerMin: z.number().min(0),
  maxAwakeHours: z.number().min(0),
});
export type HibernationSettings = z.infer<typeof hibernationSettingsSchema>;

export const capacitySettingsSchema = z.object({
  maxRunningMemoryRatio: z.number().gt(0).max(1),
});
export type CapacitySettings = z.infer<typeof capacitySettingsSchema>;

export const billingSettingsSchema = z.object({
  creditLabel: z.string().min(1),
  defaultPlanId: z.uuid(),
  /** 1 credit = this many VND (display only). */
  creditValueVnd: z.number().positive().default(1000),
});
export type BillingSettings = z.infer<typeof billingSettingsSchema>;

/** `defaults`: tools every workspace gets (until the user chooses otherwise); `disabled`: catalog entries switched off. */
export const toolchainSettingsSchema = z.object({
  defaults: toolchainDefaultsSchema,
  disabled: toolchainDisabledSchema.default([]),
});
export type ToolchainSettings = z.infer<typeof toolchainSettingsSchema>;

export const settingsSchemas = {
  hibernation: hibernationSettingsSchema,
  capacity: capacitySettingsSchema,
  billing: billingSettingsSchema,
  toolchain: toolchainSettingsSchema,
} as const;
export type SettingKey = keyof typeof settingsSchemas;
export type SettingValue<K extends SettingKey> = z.infer<(typeof settingsSchemas)[K]>;

export function parseSetting<K extends SettingKey>(key: K, value: unknown): SettingValue<K> {
  return settingsSchemas[key].parse(value) as SettingValue<K>;
}
