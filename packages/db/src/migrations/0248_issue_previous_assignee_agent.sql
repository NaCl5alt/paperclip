ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "previous_assignee_agent_id" uuid;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "issues" ADD CONSTRAINT "issues_previous_assignee_agent_id_agents_id_fk" FOREIGN KEY ("previous_assignee_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
