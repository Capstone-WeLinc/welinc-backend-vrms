-- Spec 0029 (child 0003), migration 2: BMS expedite requests, the BMS repair update version
-- per ticket, and the link from an expedite answer delivery to its request.
-- CreateEnum
CREATE TYPE "ExpediteStatus" AS ENUM ('WAITING', 'ACCEPTED', 'DECLINED');

-- AlterTable
ALTER TABLE "deliveries" ADD COLUMN     "expedite_request_id" UUID;

-- AlterTable
ALTER TABLE "repair_tickets" ADD COLUMN     "bms_event_version" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "expedite_requests" (
    "id" UUID NOT NULL,
    "repair_ticket_id" UUID NOT NULL,
    "job_order_number" VARCHAR(40) NOT NULL,
    "reason" TEXT NOT NULL,
    "needed_by" DATE,
    "status" "ExpediteStatus" NOT NULL DEFAULT 'WAITING',
    "response_reason" TEXT,
    "new_priority" "RepairPriority",
    "new_due_at" TIMESTAMPTZ(6),
    "decided_by_user_id" UUID,
    "decided_by_name" VARCHAR(100),
    "decided_at" TIMESTAMPTZ(6),
    "received_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "payload_hash" CHAR(64) NOT NULL,

    CONSTRAINT "expedite_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "expedite_requests_status_received_at_idx" ON "expedite_requests"("status", "received_at");

-- CreateIndex
CREATE INDEX "expedite_requests_repair_ticket_id_status_idx" ON "expedite_requests"("repair_ticket_id", "status");

-- AddForeignKey
ALTER TABLE "expedite_requests" ADD CONSTRAINT "expedite_requests_repair_ticket_id_fkey" FOREIGN KEY ("repair_ticket_id") REFERENCES "repair_tickets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_expedite_request_id_fkey" FOREIGN KEY ("expedite_request_id") REFERENCES "expedite_requests"("id") ON DELETE SET NULL ON UPDATE CASCADE;

