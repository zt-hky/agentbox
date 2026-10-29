-- Plans v2 data (fixed UUIDs). Idempotent on re-run; safe on a populated database.
-- a1 Free trial, a2 Credits only (internal), a3 Pro, a4 Max.
UPDATE "plans" SET
  "name" = 'Free trial', "kind" = 'free', "monthly_price_micro" = 0,
  "cpu_limit" = 1.00, "memory_limit_mb" = 2048, "disk_limit_gb" = 5, "pids_limit" = 512, "inodes_limit" = 500000,
  "allowance_runtime_hours" = 30, "allowance_cpu_core_hours" = 30, "allowance_mem_gb_hours" = 60,
  "trial_days" = 5, "daily_runtime_hours" = 6, "max_awake_hours" = 6, "idle_timeout_minutes" = 15,
  "sort_order" = 0, "public" = true, "active" = true
WHERE "id" = '00000000-0000-4000-8000-0000000000a1';
--> statement-breakpoint
UPDATE "plans" SET
  "name" = 'Credits only', "kind" = 'payg', "monthly_price_micro" = 0,
  "cpu_limit" = 1.00, "memory_limit_mb" = 2048, "disk_limit_gb" = 5, "pids_limit" = 512, "inodes_limit" = 500000,
  "allowance_runtime_hours" = 0, "allowance_cpu_core_hours" = 0, "allowance_mem_gb_hours" = 0,
  "trial_days" = NULL, "daily_runtime_hours" = NULL, "max_awake_hours" = 6, "idle_timeout_minutes" = 15,
  "sort_order" = 3, "public" = false, "active" = true
WHERE "id" = '00000000-0000-4000-8000-0000000000a2';
--> statement-breakpoint
UPDATE "plans" SET
  "name" = 'Pro', "kind" = 'package', "monthly_price_micro" = 139000000,
  "cpu_limit" = 2.00, "memory_limit_mb" = 4096, "disk_limit_gb" = 20, "pids_limit" = 2048, "inodes_limit" = 2000000,
  "allowance_runtime_hours" = 200, "allowance_cpu_core_hours" = 400, "allowance_mem_gb_hours" = 800,
  "trial_days" = NULL, "daily_runtime_hours" = NULL, "max_awake_hours" = 12, "idle_timeout_minutes" = 30,
  "sort_order" = 1, "public" = true, "active" = true
WHERE "id" = '00000000-0000-4000-8000-0000000000a3';
--> statement-breakpoint
INSERT INTO "plans" ("id", "name", "kind", "monthly_price_micro", "cpu_limit", "memory_limit_mb", "disk_limit_gb", "pids_limit", "inodes_limit", "allowance_runtime_hours", "allowance_cpu_core_hours", "allowance_mem_gb_hours", "trial_days", "daily_runtime_hours", "max_awake_hours", "idle_timeout_minutes", "sort_order", "public", "active") VALUES
  ('00000000-0000-4000-8000-0000000000a4', 'Max', 'package', 249000000, 4.00, 8192, 50, 4096, 4000000, 360, 1440, 2880, NULL, NULL, 24, 60, 2, true, true)
ON CONFLICT ("id") DO UPDATE SET
  "name" = EXCLUDED."name", "kind" = EXCLUDED."kind", "monthly_price_micro" = EXCLUDED."monthly_price_micro",
  "cpu_limit" = EXCLUDED."cpu_limit", "memory_limit_mb" = EXCLUDED."memory_limit_mb", "disk_limit_gb" = EXCLUDED."disk_limit_gb",
  "pids_limit" = EXCLUDED."pids_limit", "inodes_limit" = EXCLUDED."inodes_limit",
  "allowance_runtime_hours" = EXCLUDED."allowance_runtime_hours", "allowance_cpu_core_hours" = EXCLUDED."allowance_cpu_core_hours",
  "allowance_mem_gb_hours" = EXCLUDED."allowance_mem_gb_hours", "trial_days" = EXCLUDED."trial_days",
  "daily_runtime_hours" = EXCLUDED."daily_runtime_hours", "max_awake_hours" = EXCLUDED."max_awake_hours",
  "idle_timeout_minutes" = EXCLUDED."idle_timeout_minutes", "sort_order" = EXCLUDED."sort_order",
  "public" = EXCLUDED."public", "active" = EXCLUDED."active";
--> statement-breakpoint
-- Credit rates (micro-credits): runtime 0.6/h, CPU 0.4/core-h, memory 0.15/GB-h; effective from migration time.
INSERT INTO "prices" ("id", "runtime_per_hour", "cpu_core_per_hour", "mem_gb_per_hour", "effective_from") VALUES
  ('00000000-0000-4000-8000-0000000000b2', 600000, 400000, 150000, now())
ON CONFLICT ("id") DO NOTHING;
--> statement-breakpoint
UPDATE "settings" SET "value" = '{"creditValueVnd":1000}'::jsonb || "value" WHERE "key" = 'billing';
--> statement-breakpoint
-- Existing Free users start a 5-day trial now.
UPDATE "subscriptions" SET "trial_ends_at" = now() + interval '5 days'
WHERE "plan_id" = '00000000-0000-4000-8000-0000000000a1' AND "trial_ends_at" IS NULL;
--> statement-breakpoint
-- Limits changed for every plan: have the worker re-apply them (quota/inodes/pids; CPU/RAM on next start).
INSERT INTO "jobs" ("type", "workspace_id", "payload")
SELECT 'update_limits', "id", '{}'::jsonb FROM "workspaces" WHERE "status" <> 'deleted'
ON CONFLICT DO NOTHING;
