CREATE TABLE "git_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"provider" text NOT NULL,
	"host" text NOT NULL,
	"method" text NOT NULL,
	"login" text NOT NULL,
	"email" text,
	"provider_user_id" text,
	"token_enc" text NOT NULL,
	"refresh_token_enc" text,
	"expires_at" timestamp with time zone,
	"scopes" text,
	"ssh_key_id" text,
	"known_hosts" text,
	"status" text DEFAULT 'active' NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
INSERT INTO "git_connections" ("user_id", "provider", "host", "method", "login", "provider_user_id", "token_enc", "scopes", "created_at")
SELECT "user_id", 'github', 'github.com', 'oauth', "login", "github_id"::text, "token_enc", "scopes", "created_at" FROM "github_connections";--> statement-breakpoint
DROP TABLE "github_connections" CASCADE;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "git_sync_pending" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "ssh_public_key" text;--> statement-breakpoint
ALTER TABLE "git_connections" ADD CONSTRAINT "git_connections_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "git_connections_user_host_uq" ON "git_connections" USING btree ("user_id","host");--> statement-breakpoint
UPDATE "workspaces" SET "git_sync_pending" = "github_sync_pending";--> statement-breakpoint
ALTER TABLE "workspaces" DROP COLUMN "github_sync_pending";--> statement-breakpoint
UPDATE "jobs" SET "type" = 'sync_git' WHERE "type" = 'sync_github';