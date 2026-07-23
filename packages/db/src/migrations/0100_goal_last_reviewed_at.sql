ALTER TABLE "goals" ADD COLUMN IF NOT EXISTS "last_reviewed_at" timestamp with time zone;--> statement-breakpoint
UPDATE "goals" SET "last_reviewed_at" = now() WHERE "last_reviewed_at" IS NULL;
