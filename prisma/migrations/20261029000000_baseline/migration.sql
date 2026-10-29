-- Spec 0010: one baseline for the whole schema. The knowledge base indexes need pg_trgm.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "VehicleStatus" AS ENUM ('AVAILABLE', 'UNDER_REPAIR', 'UNDER_MAINTENANCE', 'DISABLED');

-- CreateEnum
CREATE TYPE "RepairStatus" AS ENUM ('OPEN', 'ASSIGNED', 'IN_PROGRESS', 'ON_HOLD', 'FOR_VERIFICATION', 'OUTSOURCED', 'PENDING_APPROVAL', 'CLOSED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "DueAtSource" AS ENUM ('PRIORITY', 'ISSUE_TYPE', 'MANUAL');

-- CreateEnum
CREATE TYPE "RepairPriority" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');

-- CreateEnum
CREATE TYPE "KnowledgeEntryStatus" AS ENUM ('DRAFT', 'ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "SuggestionKind" AS ENUM ('CHANGE', 'NEW_ENTRY');

-- CreateEnum
CREATE TYPE "SuggestionStatus" AS ENUM ('OPEN', 'ACCEPTED', 'DISMISSED');

-- CreateTable
CREATE TABLE "vehicles" (
    "id" UUID NOT NULL,
    "plate_number" VARCHAR(20) NOT NULL,
    "model" VARCHAR(100) NOT NULL,
    "capacity" INTEGER NOT NULL DEFAULT 0,
    "status" "VehicleStatus" NOT NULL DEFAULT 'AVAILABLE',
    "odometer" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "deleted_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "vehicles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "garages" (
    "id" UUID NOT NULL,
    "name" VARCHAR(50) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "deleted_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "garages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mechanics" (
    "id" UUID NOT NULL,
    "auth_user_id" UUID NOT NULL,
    "email" VARCHAR(255),
    "name" VARCHAR(100) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "mechanics_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "drivers" (
    "id" UUID NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "license_number" VARCHAR(50) NOT NULL,
    "is_verified" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "deleted_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "drivers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "repair_tickets" (
    "id" UUID NOT NULL,
    "repair_number" VARCHAR(50) NOT NULL,
    "repair_status" "RepairStatus" NOT NULL DEFAULT 'OPEN',
    "priority" "RepairPriority" NOT NULL DEFAULT 'MEDIUM',
    "vehicle_id" UUID NOT NULL,
    "driver_id" UUID NOT NULL,
    "garage_id" UUID NOT NULL,
    "odometer" INTEGER NOT NULL,
    "reported_by_user_id" UUID,
    "reported_by_name" VARCHAR(100),
    "verified_by_user_id" UUID,
    "verified_by_name" VARCHAR(100),
    "verified_at" TIMESTAMPTZ(6),
    "due_at" TIMESTAMPTZ(6),
    "due_at_source" "DueAtSource",
    "parts_cost" DECIMAL(10,2),
    "labor_cost" DECIMAL(10,2),
    "total_cost" DECIMAL(10,2),
    "is_lump_sum" BOOLEAN NOT NULL DEFAULT false,
    "cancellation_reason" TEXT,
    "remarks" TEXT,
    "is_unlocked" BOOLEAN NOT NULL DEFAULT false,
    "unlock_reason" TEXT,
    "last_activity_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "closed_at" TIMESTAMPTZ(6),

    CONSTRAINT "repair_tickets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ticket_assignments" (
    "id" UUID NOT NULL,
    "repair_ticket_id" UUID NOT NULL,
    "mechanic_id" UUID NOT NULL,
    "assigned_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "assigned_by_user_id" UUID,
    "assigned_by_name" VARCHAR(100),

    CONSTRAINT "ticket_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "repair_issues" (
    "id" UUID NOT NULL,
    "repair_ticket_id" UUID NOT NULL,
    "description" TEXT NOT NULL,
    "category_id" UUID,
    "knowledge_entry_id" UUID,
    "resolution_note" TEXT,
    "hours_spent" DECIMAL(5,2),
    "followed_known_fix" BOOLEAN,
    "resolved_at" TIMESTAMPTZ(6),
    "suggestion_dismissed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "repair_issues_pkey" PRIMARY KEY ("id")
);

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
CREATE TABLE "repair_parts" (
    "id" UUID NOT NULL,
    "repair_ticket_id" UUID NOT NULL,
    "description" VARCHAR(255) NOT NULL,
    "unit_cost" DECIMAL(10,2) NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "subtotal" DECIMAL(10,2) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "repair_parts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL,
    "repair_ticket_id" UUID NOT NULL,
    "actor_user_id" UUID,
    "actor_name" VARCHAR(100),
    "actor_email" VARCHAR(255),
    "actor_role" VARCHAR(30),
    "action" VARCHAR(50) NOT NULL,
    "changes" JSONB NOT NULL DEFAULT '[]',
    "note" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
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
    "actor_user_id" UUID,
    "actor_name" VARCHAR(100),
    "actor_email" VARCHAR(255),
    "actor_role" VARCHAR(30),
    "action" VARCHAR(50) NOT NULL,
    "changes" JSONB NOT NULL DEFAULT '[]',
    "note" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "knowledge_entry_changes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "vehicles_plate_number_key" ON "vehicles"("plate_number");

-- CreateIndex
CREATE INDEX "vehicles_deleted_at_idx" ON "vehicles"("deleted_at");

-- CreateIndex
CREATE UNIQUE INDEX "garages_name_key" ON "garages"("name");

-- CreateIndex
CREATE INDEX "garages_deleted_at_idx" ON "garages"("deleted_at");

-- CreateIndex
CREATE UNIQUE INDEX "mechanics_auth_user_id_key" ON "mechanics"("auth_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "drivers_license_number_key" ON "drivers"("license_number");

-- CreateIndex
CREATE INDEX "drivers_license_number_idx" ON "drivers"("license_number");

-- CreateIndex
CREATE INDEX "drivers_deleted_at_idx" ON "drivers"("deleted_at");

-- CreateIndex
CREATE UNIQUE INDEX "repair_tickets_repair_number_key" ON "repair_tickets"("repair_number");

-- CreateIndex
CREATE INDEX "repair_tickets_repair_status_created_at_idx" ON "repair_tickets"("repair_status", "created_at");

-- CreateIndex
CREATE INDEX "repair_tickets_repair_status_last_activity_at_idx" ON "repair_tickets"("repair_status", "last_activity_at");

-- CreateIndex
CREATE INDEX "repair_tickets_due_at_idx" ON "repair_tickets"("due_at");

-- CreateIndex
CREATE INDEX "repair_tickets_vehicle_id_idx" ON "repair_tickets"("vehicle_id");

-- CreateIndex
CREATE INDEX "ticket_assignments_mechanic_id_idx" ON "ticket_assignments"("mechanic_id");

-- CreateIndex
CREATE UNIQUE INDEX "ticket_assignments_repair_ticket_id_mechanic_id_key" ON "ticket_assignments"("repair_ticket_id", "mechanic_id");

-- CreateIndex
CREATE INDEX "repair_issues_knowledge_entry_id_idx" ON "repair_issues"("knowledge_entry_id");

-- CreateIndex
CREATE INDEX "repair_issues_knowledge_entry_id_suggestion_dismissed_at_idx" ON "repair_issues"("knowledge_entry_id", "suggestion_dismissed_at");

-- CreateIndex
CREATE UNIQUE INDEX "repair_issue_steps_repair_issue_id_position_key" ON "repair_issue_steps"("repair_issue_id", "position");

-- CreateIndex
CREATE INDEX "audit_logs_repair_ticket_id_created_at_idx" ON "audit_logs"("repair_ticket_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_logs_created_at_id_idx" ON "audit_logs"("created_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "audit_logs_actor_email_idx" ON "audit_logs"("actor_email");

-- CreateIndex
CREATE INDEX "audit_logs_action_idx" ON "audit_logs"("action");

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
CREATE INDEX "knowledge_entry_changes_category_id_created_at_idx" ON "knowledge_entry_changes"("category_id", "created_at");

-- AddForeignKey
ALTER TABLE "repair_tickets" ADD CONSTRAINT "repair_tickets_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "vehicles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "repair_tickets" ADD CONSTRAINT "repair_tickets_driver_id_fkey" FOREIGN KEY ("driver_id") REFERENCES "drivers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "repair_tickets" ADD CONSTRAINT "repair_tickets_garage_id_fkey" FOREIGN KEY ("garage_id") REFERENCES "garages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_assignments" ADD CONSTRAINT "ticket_assignments_repair_ticket_id_fkey" FOREIGN KEY ("repair_ticket_id") REFERENCES "repair_tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_assignments" ADD CONSTRAINT "ticket_assignments_mechanic_id_fkey" FOREIGN KEY ("mechanic_id") REFERENCES "mechanics"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "repair_issues" ADD CONSTRAINT "repair_issues_repair_ticket_id_fkey" FOREIGN KEY ("repair_ticket_id") REFERENCES "repair_tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "repair_issues" ADD CONSTRAINT "repair_issues_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "issue_categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "repair_issues" ADD CONSTRAINT "repair_issues_knowledge_entry_id_fkey" FOREIGN KEY ("knowledge_entry_id") REFERENCES "knowledge_entries"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "repair_issue_steps" ADD CONSTRAINT "repair_issue_steps_repair_issue_id_fkey" FOREIGN KEY ("repair_issue_id") REFERENCES "repair_issues"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "repair_parts" ADD CONSTRAINT "repair_parts_repair_ticket_id_fkey" FOREIGN KEY ("repair_ticket_id") REFERENCES "repair_tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_repair_ticket_id_fkey" FOREIGN KEY ("repair_ticket_id") REFERENCES "repair_tickets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

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


-- Seed the issue categories (the old VEHICLE_SYSTEM_OPTIONS, plus General); npm run seed never creates them
INSERT INTO "issue_categories" ("id", "name", "name_key", "sort_order", "updated_at") VALUES
    (gen_random_uuid(), 'Brakes', 'brakes', 1, CURRENT_TIMESTAMP),
    (gen_random_uuid(), 'Engine', 'engine', 2, CURRENT_TIMESTAMP),
    (gen_random_uuid(), 'Electrical', 'electrical', 3, CURRENT_TIMESTAMP),
    (gen_random_uuid(), 'Suspension', 'suspension', 4, CURRENT_TIMESTAMP),
    (gen_random_uuid(), 'Cooling', 'cooling', 5, CURRENT_TIMESTAMP),
    (gen_random_uuid(), 'Transmission', 'transmission', 6, CURRENT_TIMESTAMP),
    (gen_random_uuid(), 'General', 'general', 99, CURRENT_TIMESTAMP)
ON CONFLICT ("name_key") DO NOTHING;
