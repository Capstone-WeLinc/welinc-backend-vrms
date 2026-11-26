-- VRMS spec 0029, migration 1: the fleet copy ids on vehicles and garages, VMMS referrals, the
-- delivery outbox, and on repair tickets an optional driver (referral tickets have none), the
-- VMMS event version and the outside shop.

-- CreateEnum
CREATE TYPE "ReferralStatus" AS ENUM ('WAITING', 'OPENED_TICKET', 'ADDED_TO_TICKET', 'REJECTED');

-- CreateEnum
CREATE TYPE "DeliveryTarget" AS ENUM ('VMMS', 'BMS');

-- CreateEnum
CREATE TYPE "DeliveryKind" AS ENUM ('REPAIR_EVENT', 'REFERRAL_REJECTED', 'REPAIR_UPDATE', 'EXPEDITE_ANSWER');

-- CreateEnum
CREATE TYPE "DeliveryStatus" AS ENUM ('PENDING', 'SENT', 'FAILED', 'DISMISSED');

-- AlterTable
ALTER TABLE "garages" ADD COLUMN     "synced_at" TIMESTAMPTZ(6),
ADD COLUMN     "vmms_garage_id" UUID;

-- AlterTable
ALTER TABLE "repair_tickets" ADD COLUMN     "outside_shop_name" VARCHAR(150),
ADD COLUMN     "vmms_event_version" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "vmms_provider_id" UUID,
ALTER COLUMN "driver_id" DROP NOT NULL;

-- AlterTable
ALTER TABLE "vehicles" ADD COLUMN     "garage_id" UUID,
ADD COLUMN     "make" VARCHAR(100),
ADD COLUMN     "synced_at" TIMESTAMPTZ(6),
ADD COLUMN     "truck_size_category" VARCHAR(50),
ADD COLUMN     "vmms_vehicle_id" UUID;

-- CreateTable
CREATE TABLE "referrals" (
    "id" UUID NOT NULL,
    "vehicle_id" UUID NOT NULL,
    "vmms_vehicle_id" UUID NOT NULL,
    "vehicle_plate" VARCHAR(20) NOT NULL,
    "maintenance_schedule_id" UUID NOT NULL,
    "work_order_number" VARCHAR(40) NOT NULL,
    "odometer_reading" INTEGER NOT NULL,
    "findings" JSONB NOT NULL,
    "chief_mechanic_remarks" TEXT,
    "status" "ReferralStatus" NOT NULL DEFAULT 'WAITING',
    "rejection_reason" TEXT,
    "decided_by_user_id" UUID,
    "decided_by_name" VARCHAR(100),
    "decided_at" TIMESTAMPTZ(6),
    "repair_ticket_id" UUID,
    "received_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "payload_hash" CHAR(64) NOT NULL,

    CONSTRAINT "referrals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deliveries" (
    "id" UUID NOT NULL,
    "seq" BIGSERIAL NOT NULL,
    "target" "DeliveryTarget" NOT NULL,
    "kind" "DeliveryKind" NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "DeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "first_attempt_at" TIMESTAMPTZ(6),
    "next_attempt_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_attempt_at" TIMESTAMPTZ(6),
    "last_status_code" INTEGER,
    "last_error" VARCHAR(500),
    "sent_at" TIMESTAMPTZ(6),
    "manual_retry_count" INTEGER NOT NULL DEFAULT 0,
    "dismiss_reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "repair_ticket_id" UUID,
    "referral_id" UUID,

    CONSTRAINT "deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "referrals_status_received_at_idx" ON "referrals"("status", "received_at");

-- CreateIndex
CREATE INDEX "referrals_vehicle_id_idx" ON "referrals"("vehicle_id");

-- CreateIndex
CREATE INDEX "referrals_repair_ticket_id_idx" ON "referrals"("repair_ticket_id");

-- CreateIndex
CREATE UNIQUE INDEX "deliveries_seq_key" ON "deliveries"("seq");

-- CreateIndex
CREATE INDEX "deliveries_status_next_attempt_at_idx" ON "deliveries"("status", "next_attempt_at");

-- CreateIndex
CREATE INDEX "deliveries_target_repair_ticket_id_created_at_idx" ON "deliveries"("target", "repair_ticket_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "garages_vmms_garage_id_key" ON "garages"("vmms_garage_id");

-- CreateIndex
CREATE UNIQUE INDEX "vehicles_vmms_vehicle_id_key" ON "vehicles"("vmms_vehicle_id");

-- CreateIndex
CREATE INDEX "vehicles_garage_id_idx" ON "vehicles"("garage_id");

-- AddForeignKey
ALTER TABLE "vehicles" ADD CONSTRAINT "vehicles_garage_id_fkey" FOREIGN KEY ("garage_id") REFERENCES "garages"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "vehicles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_repair_ticket_id_fkey" FOREIGN KEY ("repair_ticket_id") REFERENCES "repair_tickets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_repair_ticket_id_fkey" FOREIGN KEY ("repair_ticket_id") REFERENCES "repair_tickets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_referral_id_fkey" FOREIGN KEY ("referral_id") REFERENCES "referrals"("id") ON DELETE SET NULL ON UPDATE CASCADE;

