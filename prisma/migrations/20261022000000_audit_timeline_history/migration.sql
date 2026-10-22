-- AlterTable
ALTER TABLE "audit_logs" ALTER COLUMN "user_id" DROP NOT NULL,
ALTER COLUMN "email" DROP NOT NULL,
ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMPTZ(3);

-- CreateIndex
CREATE INDEX "audit_logs_created_at_id_idx" ON "audit_logs"("created_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "audit_logs_email_idx" ON "audit_logs"("email");

-- CreateIndex
CREATE INDEX "audit_logs_action_idx" ON "audit_logs"("action");


-- Backfill (spec 0003). Every statement is guarded, so running it again adds nothing.
-- ids and times are set here because their defaults live in Prisma, not the database.

-- 1. completed_at means "closed at" for both outcomes: fill old closed tickets from
--    their last matching status change, else their last update.
UPDATE "repair_tickets" t
SET "completed_at" = COALESCE(
  (SELECT MAX(a."created_at") FROM "audit_logs" a
   WHERE a."repair_ticket_id" = t."id"
     AND a."action" = 'STATUS_CHANGE'
     AND a."new_value" = t."repair_status"::text),
  t."updated_at")
WHERE t."repair_status" IN ('COMPLETED', 'CANCELLED')
  AND t."completed_at" IS NULL;

-- 2. One CREATED row (no actor) per ticket that has none.
INSERT INTO "audit_logs" ("id", "repair_ticket_id", "user_id", "email", "action", "created_at")
SELECT gen_random_uuid(), t."id", NULL, NULL, 'CREATED', t."created_at"
FROM "repair_tickets" t
WHERE NOT EXISTS (
  SELECT 1 FROM "audit_logs" a
  WHERE a."repair_ticket_id" = t."id" AND a."action" = 'CREATED');

-- 3. Copy shop changes into the audit table. changed_at keeps microseconds while
--    audit created_at keeps milliseconds, so the guard compares the rounded value.
INSERT INTO "audit_logs" ("id", "repair_ticket_id", "user_id", "email", "action", "field_name", "previous_value", "new_value", "created_at")
SELECT gen_random_uuid(), s."repair_ticket_id", s."changed_by_user_id", NULL, 'SHOP_CHANGE', 'garage', s."previous_value", s."new_value", s."changed_at"
FROM "shop_change_logs" s
WHERE NOT EXISTS (
  SELECT 1 FROM "audit_logs" a
  WHERE a."action" = 'SHOP_CHANGE'
    AND a."repair_ticket_id" = s."repair_ticket_id"
    AND a."created_at" = s."changed_at"::timestamptz(3)
    AND a."previous_value" IS NOT DISTINCT FROM s."previous_value"
    AND a."new_value" IS NOT DISTINCT FROM s."new_value");
