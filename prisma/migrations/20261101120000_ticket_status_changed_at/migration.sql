-- Spec 0015, AC-7 and AC-8: when each ticket's status last changed.
ALTER TABLE "repair_tickets" ADD COLUMN "status_changed_at" TIMESTAMPTZ(6);

UPDATE "repair_tickets" t SET "status_changed_at" = COALESCE(
  (SELECT a."created_at" FROM "audit_logs" a
    WHERE a."repair_ticket_id" = t."id"
      AND a."changes" @> '[{"field":"repairStatus"}]'
    ORDER BY a."created_at" DESC LIMIT 1),
  (SELECT a."created_at" FROM "audit_logs" a
    WHERE a."repair_ticket_id" = t."id" AND a."action" = 'CREATED'
    ORDER BY a."created_at" ASC LIMIT 1),
  t."created_at");

ALTER TABLE "repair_tickets" ALTER COLUMN "status_changed_at" SET NOT NULL;
ALTER TABLE "repair_tickets" ALTER COLUMN "status_changed_at" SET DEFAULT CURRENT_TIMESTAMP;

CREATE INDEX "repair_tickets_repair_status_status_changed_at_idx" ON "repair_tickets"("repair_status", "status_changed_at");
