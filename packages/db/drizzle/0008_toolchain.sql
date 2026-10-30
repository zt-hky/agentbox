CREATE TABLE "tool_latest" (
	"tool_id" text PRIMARY KEY NOT NULL,
	"latest" text,
	"lts" text,
	"versions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"meta" jsonb,
	"checked_at" timestamp with time zone,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "toolchain_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"job_id" uuid,
	"trigger" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"generation" integer DEFAULT 0 NOT NULL,
	"plan" jsonb,
	"steps" jsonb,
	"log" text,
	"error" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspace_tools" (
	"workspace_id" uuid NOT NULL,
	"tool_id" text NOT NULL,
	"channel" text DEFAULT 'latest' NOT NULL,
	"pinned_version" text,
	"desired" boolean DEFAULT true NOT NULL,
	"source" text DEFAULT 'default' NOT NULL,
	"requested_action" text,
	"state" text DEFAULT 'pending' NOT NULL,
	"installed_version" text,
	"previous_version" text,
	"backend" text,
	"installed_at" timestamp with time zone,
	"observed_at" timestamp with time zone,
	"size_bytes" bigint,
	"last_error" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_tools_workspace_id_tool_id_pk" PRIMARY KEY("workspace_id","tool_id")
);
--> statement-breakpoint
ALTER TABLE "images" ADD COLUMN "manifest" jsonb;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "toolchain_generation" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "toolchain_applied_generation" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "toolchain_pending" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "toolchain_abi" text;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "toolchain_reconciled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "toolchain_runs" ADD CONSTRAINT "toolchain_runs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_tools" ADD CONSTRAINT "workspace_tools_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "toolchain_runs_ws_created_idx" ON "toolchain_runs" USING btree ("workspace_id","created_at");