ALTER TABLE "jobs" ADD COLUMN "result" jsonb;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "finished_at" timestamp with time zone;