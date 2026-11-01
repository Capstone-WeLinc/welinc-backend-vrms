-- Spec 0016: safe create, lookup lists, vehicle types and vehicle history. All additive.
CREATE TYPE "TicketAccountType" AS ENUM ('ONLINE', 'CORPORATE');

CREATE TABLE "lookup_values" (
    "id" UUID NOT NULL,
    "list" VARCHAR(40) NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "name_key" VARCHAR(100) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "lookup_values_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "lookup_values_list_name_key_key" ON "lookup_values"("list", "name_key");
CREATE INDEX "lookup_values_list_is_active_idx" ON "lookup_values"("list", "is_active");

CREATE TABLE "lookup_value_changes" (
    "id" UUID NOT NULL,
    "lookup_value_id" UUID NOT NULL,
    "action" VARCHAR(12) NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "actor_user_id" UUID,
    "actor_name" VARCHAR(100),
    "actor_email" VARCHAR(255),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "lookup_value_changes_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "lookup_value_changes_created_at_id_idx" ON "lookup_value_changes"("created_at" DESC, "id" DESC);
ALTER TABLE "lookup_value_changes" ADD CONSTRAINT "lookup_value_changes_lookup_value_id_fkey"
  FOREIGN KEY ("lookup_value_id") REFERENCES "lookup_values"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "vehicles" ADD COLUMN "vehicle_type_id" UUID;
ALTER TABLE "vehicles" ADD CONSTRAINT "vehicles_vehicle_type_id_fkey"
  FOREIGN KEY ("vehicle_type_id") REFERENCES "lookup_values"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "vehicle_changes" (
    "id" UUID NOT NULL,
    "vehicle_id" UUID NOT NULL,
    "field" VARCHAR(30) NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "actor_user_id" UUID,
    "actor_name" VARCHAR(100),
    "actor_email" VARCHAR(255),
    "note" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "vehicle_changes_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "vehicle_changes_vehicle_id_created_at_idx" ON "vehicle_changes"("vehicle_id", "created_at");
ALTER TABLE "vehicle_changes" ADD CONSTRAINT "vehicle_changes_vehicle_id_fkey"
  FOREIGN KEY ("vehicle_id") REFERENCES "vehicles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "repair_tickets" ADD COLUMN "account_type" "TicketAccountType";
ALTER TABLE "repair_tickets" ADD COLUMN "corporation" VARCHAR(100);
ALTER TABLE "repair_tickets" ADD COLUMN "prior_vehicle_status" "VehicleStatus";

-- Starting values, sort order 10, 20, 30 and so on in the listed order
INSERT INTO "lookup_values" ("id", "list", "name", "name_key", "sort_order", "updated_at") VALUES
  (gen_random_uuid(), 'corporation', 'WeLinc Transport Corp', 'welinc transport corp', 10, CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'corporation', 'Metro Freight Corp', 'metro freight corp', 20, CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'corporation', 'Global Logistics Inc', 'global logistics inc', 30, CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'vehicle_type', '4 wheeler', '4 wheeler', 10, CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'vehicle_type', '6 wheeler', '6 wheeler', 20, CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'vehicle_type', '10 wheeler', '10 wheeler', 30, CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'vehicle_type', 'Wing van', 'wing van', 40, CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'vehicle_type', 'Tractor head', 'tractor head', 50, CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'vehicle_type', 'Trailer', 'trailer', 60, CURRENT_TIMESTAMP);
