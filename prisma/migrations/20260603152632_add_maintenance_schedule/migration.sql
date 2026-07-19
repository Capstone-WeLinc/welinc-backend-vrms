-- CreateTable
CREATE TABLE "maintenance_schedules" (
    "id" UUID NOT NULL,
    "vehicleId" VARCHAR(50) NOT NULL,
    "title" VARCHAR(100) NOT NULL,
    "garage_id" VARCHAR(50),
    "account_type" VARCHAR(100),
    "status" VARCHAR(50) NOT NULL,
    "assigned_mechanic" VARCHAR(100) NOT NULL,
    "checklist_template_id" UUID,
    "odometer_reading" INTEGER,
    "trigger_type" VARCHAR(50),
    "interval_km" INTEGER,
    "buffer_distance_km" INTEGER,
    "starting_reference_reading_km" INTEGER,
    "interval_type" VARCHAR(20),
    "start_reference_date" TIMESTAMPTZ(6),
    "previous_schedule_id" UUID,
    "work_order_progress" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "maintenance_schedules_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "maintenance_schedules_checklist_template_id_fkey" FOREIGN KEY ("checklist_template_id") REFERENCES "checklist_templates"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "maintenance_schedules_checklist_template_id_idx" ON "maintenance_schedules"("checklist_template_id");

-- CreateIndex
CREATE UNIQUE INDEX "maintenance_schedules_previous_schedule_id_key" ON "maintenance_schedules"("previous_schedule_id");

-- AddForeignKey
ALTER TABLE "maintenance_schedules" ADD CONSTRAINT "maintenance_schedules_previous_schedule_id_fkey" FOREIGN KEY ("previous_schedule_id") REFERENCES "maintenance_schedules"("id") ON DELETE SET NULL ON UPDATE CASCADE;
