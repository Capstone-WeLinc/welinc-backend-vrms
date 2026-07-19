ALTER TABLE "users" ADD COLUMN "deleted_at" TIMESTAMPTZ(6);
ALTER TABLE "bookings" ADD COLUMN "deleted_at" TIMESTAMPTZ(6);
ALTER TABLE "vehicles" ADD COLUMN "deleted_at" TIMESTAMPTZ(6);
ALTER TABLE "garages" ADD COLUMN "deleted_at" TIMESTAMPTZ(6);
ALTER TABLE "drivers" ADD COLUMN "deleted_at" TIMESTAMPTZ(6);
ALTER TABLE "checklist_templates" ADD COLUMN "deleted_at" TIMESTAMPTZ(6);
ALTER TABLE "checklist_items" ADD COLUMN "deleted_at" TIMESTAMPTZ(6);
ALTER TABLE "maintenance_schedules" ADD COLUMN "deleted_at" TIMESTAMPTZ(6);

CREATE INDEX "users_deleted_at_idx" ON "users"("deleted_at");
CREATE INDEX "bookings_deleted_at_idx" ON "bookings"("deleted_at");
CREATE INDEX "vehicles_deleted_at_idx" ON "vehicles"("deleted_at");
CREATE INDEX "garages_deleted_at_idx" ON "garages"("deleted_at");
CREATE INDEX "drivers_deleted_at_idx" ON "drivers"("deleted_at");
CREATE INDEX "checklist_templates_deleted_at_idx" ON "checklist_templates"("deleted_at");
CREATE INDEX "checklist_items_deleted_at_idx" ON "checklist_items"("deleted_at");
CREATE INDEX "maintenance_schedules_deleted_at_idx" ON "maintenance_schedules"("deleted_at");
