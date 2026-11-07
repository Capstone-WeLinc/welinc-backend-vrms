-- Spec 0023: per ticket checklist edits. Every existing step was copied from a known fix.
CREATE TYPE "StepOrigin" AS ENUM ('KNOWN_FIX', 'ADDED');

ALTER TABLE "repair_issue_steps"
  ADD COLUMN "origin" "StepOrigin" NOT NULL DEFAULT 'KNOWN_FIX',
  ADD COLUMN "edited_at" TIMESTAMPTZ(6);

ALTER TABLE "repair_issues"
  ADD COLUMN "checklist_version" INTEGER NOT NULL DEFAULT 0;
