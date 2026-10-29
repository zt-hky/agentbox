-- Deterministic seed: plans, prices, settings (fixed UUIDs).
INSERT INTO "plans" ("id", "name", "kind", "monthly_price_micro", "cpu_limit", "memory_limit_mb", "disk_limit_gb", "pids_limit", "allowance_runtime_hours", "allowance_cpu_core_hours", "allowance_mem_gb_hours", "active") VALUES
  ('00000000-0000-4000-8000-0000000000a1', 'Free', 'free', 0, 2.00, 4096, 10, 2048, 20, 20, 40, true),
  ('00000000-0000-4000-8000-0000000000a2', 'Pay as you go', 'payg', 0, 4.00, 8192, 30, 2048, 0, 0, 0, true),
  ('00000000-0000-4000-8000-0000000000a3', 'Pro', 'package', 100000000, 8.00, 16384, 50, 2048, 200, 300, 800, true)
ON CONFLICT ("id") DO NOTHING;
--> statement-breakpoint
INSERT INTO "prices" ("id", "runtime_per_hour", "cpu_core_per_hour", "mem_gb_per_hour", "effective_from") VALUES
  ('00000000-0000-4000-8000-0000000000b1', 500000, 200000, 50000, '2026-01-01T00:00:00Z')
ON CONFLICT ("id") DO NOTHING;
--> statement-breakpoint
INSERT INTO "settings" ("key", "value") VALUES
  ('hibernation', '{"idleTimeoutMinutes":30,"idleCpuPercent":5,"idleNetBytesPerMin":32768,"maxAwakeHours":24}'::jsonb),
  ('capacity', '{"maxRunningMemoryRatio":0.8}'::jsonb),
  ('billing', '{"creditLabel":"credit","defaultPlanId":"00000000-0000-4000-8000-0000000000a1"}'::jsonb)
ON CONFLICT ("key") DO NOTHING;
