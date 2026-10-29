ALTER TABLE "plans" ADD COLUMN "inodes_limit" integer DEFAULT 4000000 NOT NULL;--> statement-breakpoint
ALTER TABLE "plans" ADD COLUMN "trial_days" integer;--> statement-breakpoint
ALTER TABLE "plans" ADD COLUMN "daily_runtime_hours" double precision;--> statement-breakpoint
ALTER TABLE "plans" ADD COLUMN "max_awake_hours" double precision;--> statement-breakpoint
ALTER TABLE "plans" ADD COLUMN "idle_timeout_minutes" integer;--> statement-breakpoint
ALTER TABLE "plans" ADD COLUMN "sort_order" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "plans" ADD COLUMN "public" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "trial_ends_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "day_start" date;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD COLUMN "used_today_runtime_hours" double precision DEFAULT 0 NOT NULL;