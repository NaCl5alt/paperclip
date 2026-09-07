CREATE TABLE IF NOT EXISTS "shared_workspace_claims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"claim_key" text NOT NULL,
	"cwd" text NOT NULL,
	"company_id" uuid,
	"agent_id" uuid,
	"heartbeat_run_id" uuid,
	"status" text DEFAULT 'active' NOT NULL,
	"claimed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"heartbeat_at" timestamp with time zone DEFAULT now() NOT NULL,
	"released_at" timestamp with time zone,
	"release_reason" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "shared_workspace_claims" ADD CONSTRAINT "shared_workspace_claims_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "shared_workspace_claims" ADD CONSTRAINT "shared_workspace_claims_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "shared_workspace_claims" ADD CONSTRAINT "shared_workspace_claims_heartbeat_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("heartbeat_run_id") REFERENCES "heartbeat_runs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "shared_workspace_claims_active_key_uq" ON "shared_workspace_claims" USING btree ("claim_key") WHERE "status" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "shared_workspace_claims_active_cwd_uq" ON "shared_workspace_claims" USING btree ("cwd") WHERE "status" = 'active';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shared_workspace_claims_run_idx" ON "shared_workspace_claims" USING btree ("heartbeat_run_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shared_workspace_claims_status_heartbeat_idx" ON "shared_workspace_claims" USING btree ("status","heartbeat_at");
