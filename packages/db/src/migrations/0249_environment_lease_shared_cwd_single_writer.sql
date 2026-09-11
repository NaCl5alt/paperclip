ALTER TABLE "environment_leases" ADD COLUMN IF NOT EXISTS "shared_workspace_cwd" text;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "environment_leases_active_shared_cwd_uq" ON "environment_leases" USING btree ("company_id","shared_workspace_cwd") WHERE "status" = 'active' AND "shared_workspace_cwd" IS NOT NULL;
