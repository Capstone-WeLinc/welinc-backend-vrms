-- Trigram search and grouping for the knowledge base (spec 0007). Must exist before the GIN indexes below.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- CreateEnum
CREATE TYPE "RepairPriority" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');

-- CreateEnum
CREATE TYPE "KnowledgeEntryStatus" AS ENUM ('DRAFT', 'ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "SuggestionKind" AS ENUM ('CHANGE', 'NEW_ENTRY');

-- CreateEnum
CREATE TYPE "SuggestionStatus" AS ENUM ('OPEN', 'ACCEPTED', 'DISMISSED');

-- AlterEnum
ALTER TYPE "UserRole" ADD VALUE 'CHIEF_MECHANIC';

-- AlterTable
ALTER TABLE "repair_issues" ADD COLUMN     "category_id" UUID,
ADD COLUMN     "followed_known_fix" BOOLEAN,
ADD COLUMN     "hours_spent" DECIMAL(5,2),
ADD COLUMN     "knowledge_entry_id" UUID,
ADD COLUMN     "resolution_note" TEXT,
ADD COLUMN     "resolved_at" TIMESTAMPTZ(6),
ADD COLUMN     "suggestion_dismissed_at" TIMESTAMPTZ(6);

-- CreateTable
CREATE TABLE "repair_issue_steps" (
    "id" UUID NOT NULL,
    "repair_issue_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "text" VARCHAR(300) NOT NULL,
    "checked_at" TIMESTAMPTZ(6),
    "checked_by_email" VARCHAR(255),

    CONSTRAINT "repair_issue_steps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "issue_categories" (
    "id" UUID NOT NULL,
    "name" VARCHAR(50) NOT NULL,
    "name_key" VARCHAR(50) NOT NULL,
    "description" VARCHAR(200),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "issue_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "knowledge_entries" (
    "id" UUID NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "name_key" VARCHAR(100) NOT NULL,
    "category_id" UUID NOT NULL,
    "status" "KnowledgeEntryStatus" NOT NULL DEFAULT 'DRAFT',
    "symptoms" TEXT NOT NULL,
    "description_template" TEXT,
    "suggested_priority" "RepairPriority" NOT NULL,
    "estimated_hours" DECIMAL(5,2),
    "safety_notes" TEXT,
    "created_by_email" VARCHAR(255) NOT NULL,
    "updated_by_email" VARCHAR(255) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "knowledge_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "knowledge_entry_steps" (
    "id" UUID NOT NULL,
    "entry_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "text" VARCHAR(300) NOT NULL,

    CONSTRAINT "knowledge_entry_steps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "knowledge_entry_parts" (
    "id" UUID NOT NULL,
    "entry_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "name" VARCHAR(100) NOT NULL,

    CONSTRAINT "knowledge_entry_parts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "knowledge_suggestions" (
    "id" UUID NOT NULL,
    "kind" "SuggestionKind" NOT NULL,
    "status" "SuggestionStatus" NOT NULL DEFAULT 'OPEN',
    "entry_id" UUID,
    "repair_issue_id" UUID,
    "body" TEXT NOT NULL,
    "created_by_email" VARCHAR(255) NOT NULL,
    "resolved_by_email" VARCHAR(255),
    "resolved_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "knowledge_suggestions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "knowledge_entry_changes" (
    "id" UUID NOT NULL,
    "entry_id" UUID,
    "category_id" UUID,
    "user_id" UUID,
    "email" VARCHAR(255) NOT NULL,
    "action" VARCHAR(50) NOT NULL,
    "field_name" VARCHAR(50),
    "previous_value" TEXT,
    "new_value" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "knowledge_entry_changes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "repair_issue_steps_repair_issue_id_position_key" ON "repair_issue_steps"("repair_issue_id", "position");

-- CreateIndex
CREATE UNIQUE INDEX "issue_categories_name_key_key" ON "issue_categories"("name_key");

-- CreateIndex
CREATE UNIQUE INDEX "knowledge_entries_name_key_key" ON "knowledge_entries"("name_key");

-- CreateIndex
CREATE INDEX "knowledge_entries_status_category_id_idx" ON "knowledge_entries"("status", "category_id");

-- CreateIndex
CREATE INDEX "knowledge_entries_name_idx" ON "knowledge_entries" USING GIN ("name" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "knowledge_entries_symptoms_idx" ON "knowledge_entries" USING GIN ("symptoms" gin_trgm_ops);

-- CreateIndex
CREATE UNIQUE INDEX "knowledge_entry_steps_entry_id_position_key" ON "knowledge_entry_steps"("entry_id", "position");

-- CreateIndex
CREATE UNIQUE INDEX "knowledge_entry_parts_entry_id_position_key" ON "knowledge_entry_parts"("entry_id", "position");

-- CreateIndex
CREATE INDEX "knowledge_suggestions_status_created_at_idx" ON "knowledge_suggestions"("status", "created_at");

-- CreateIndex
CREATE INDEX "knowledge_entry_changes_entry_id_created_at_idx" ON "knowledge_entry_changes"("entry_id", "created_at");

-- CreateIndex
CREATE INDEX "repair_issues_knowledge_entry_id_idx" ON "repair_issues"("knowledge_entry_id");

-- CreateIndex
CREATE INDEX "repair_issues_knowledge_entry_id_suggestion_dismissed_at_idx" ON "repair_issues"("knowledge_entry_id", "suggestion_dismissed_at");

-- AddForeignKey
ALTER TABLE "repair_issues" ADD CONSTRAINT "repair_issues_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "issue_categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "repair_issues" ADD CONSTRAINT "repair_issues_knowledge_entry_id_fkey" FOREIGN KEY ("knowledge_entry_id") REFERENCES "knowledge_entries"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "repair_issue_steps" ADD CONSTRAINT "repair_issue_steps_repair_issue_id_fkey" FOREIGN KEY ("repair_issue_id") REFERENCES "repair_issues"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_entries" ADD CONSTRAINT "knowledge_entries_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "issue_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_entry_steps" ADD CONSTRAINT "knowledge_entry_steps_entry_id_fkey" FOREIGN KEY ("entry_id") REFERENCES "knowledge_entries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_entry_parts" ADD CONSTRAINT "knowledge_entry_parts_entry_id_fkey" FOREIGN KEY ("entry_id") REFERENCES "knowledge_entries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_suggestions" ADD CONSTRAINT "knowledge_suggestions_entry_id_fkey" FOREIGN KEY ("entry_id") REFERENCES "knowledge_entries"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_suggestions" ADD CONSTRAINT "knowledge_suggestions_repair_issue_id_fkey" FOREIGN KEY ("repair_issue_id") REFERENCES "repair_issues"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_entry_changes" ADD CONSTRAINT "knowledge_entry_changes_entry_id_fkey" FOREIGN KEY ("entry_id") REFERENCES "knowledge_entries"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_entry_changes" ADD CONSTRAINT "knowledge_entry_changes_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "issue_categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Seed the issue categories (the old VEHICLE_SYSTEM_OPTIONS, plus General)
INSERT INTO "issue_categories" ("id", "name", "name_key", "sort_order", "updated_at") VALUES
    (gen_random_uuid(), 'Brakes', 'brakes', 1, CURRENT_TIMESTAMP),
    (gen_random_uuid(), 'Engine', 'engine', 2, CURRENT_TIMESTAMP),
    (gen_random_uuid(), 'Electrical', 'electrical', 3, CURRENT_TIMESTAMP),
    (gen_random_uuid(), 'Suspension', 'suspension', 4, CURRENT_TIMESTAMP),
    (gen_random_uuid(), 'Cooling', 'cooling', 5, CURRENT_TIMESTAMP),
    (gen_random_uuid(), 'Transmission', 'transmission', 6, CURRENT_TIMESTAMP),
    (gen_random_uuid(), 'General', 'general', 99, CURRENT_TIMESTAMP)
ON CONFLICT ("name_key") DO NOTHING;

-- Backfill: match the "[System] " prefix that create() writes to a category name, ignoring case.
-- Issues with no matching prefix keep category_id null.
UPDATE "repair_issues" ri
SET "category_id" = c."id"
FROM "issue_categories" c
WHERE ri."category_id" IS NULL
  AND c."name_key" = lower(trim(substring(ri."description" from '^\[([^\]]+)\]')));
