import { z } from "zod";

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
});
export type BillingSettings = z.infer<typeof billingSettingsSchema>;

export const settingsSchemas = {
  hibernation: hibernationSettingsSchema,
  capacity: capacitySettingsSchema,
  billing: billingSettingsSchema,
} as const;
export type SettingKey = keyof typeof settingsSchemas;
export type SettingValue<K extends SettingKey> = z.infer<(typeof settingsSchemas)[K]>;

export function parseSetting<K extends SettingKey>(key: K, value: unknown): SettingValue<K> {
  return settingsSchemas[key].parse(value) as SettingValue<K>;
}
