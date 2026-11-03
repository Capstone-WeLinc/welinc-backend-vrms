-- Spec 0020: vehicle availability. Additive: one nullable column, no backfill.

-- The ticket behind an automatic status row (create and release); null on manual rows.
ALTER TABLE "vehicle_changes" ADD COLUMN "repair_ticket_id" UUID;

CREATE INDEX "vehicle_changes_repair_ticket_id_idx" ON "vehicle_changes"("repair_ticket_id");

ALTER TABLE "vehicle_changes" ADD CONSTRAINT "vehicle_changes_repair_ticket_id_fkey" FOREIGN KEY ("repair_ticket_id") REFERENCES "repair_tickets"("id") ON DELETE SET NULL ON UPDATE CASCADE;
