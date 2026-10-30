CREATE TABLE "agent_keys" (
	"user_id" text NOT NULL,
	"env_var" text NOT NULL,
	"value_enc" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_keys_user_id_env_var_pk" PRIMARY KEY("user_id","env_var")
);
--> statement-breakpoint
ALTER TABLE "images" ADD COLUMN "version" integer;--> statement-breakpoint
UPDATE "images" SET "version" = n.rn FROM (SELECT "id", row_number() OVER (ORDER BY "created_at", "id")::int AS rn FROM "images") n WHERE "images"."id" = n."id";--> statement-breakpoint
ALTER TABLE "images" ALTER COLUMN "version" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "onboarded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "onboarding_selection" jsonb;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "reserved_slug" text;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "data_kept" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_keys" ADD CONSTRAINT "agent_keys_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "images" ADD CONSTRAINT "images_version_unique" UNIQUE("version");--> statement-breakpoint
ALTER TABLE "user" ADD CONSTRAINT "user_reserved_slug_unique" UNIQUE("reserved_slug");