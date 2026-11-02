-- Spec 0018: before and after photos. Additive: two nullable columns, a backfill and an index swap.

-- When work first started on the ticket (first move into IN_PROGRESS or OUTSOURCED). Never cleared.
ALTER TABLE "repair_tickets" ADD COLUMN "work_started_at" TIMESTAMPTZ(6);

-- The phone's recorded time for a photo, sent by the browser (AC-12). Null when absent or invalid.
ALTER TABLE "attachments" ADD COLUMN "taken_at" TIMESTAMPTZ(6);

-- Backfill 1: the earliest STATUS_CHANGE audit row into IN_PROGRESS or OUTSOURCED.
UPDATE "repair_tickets" AS t
SET "work_started_at" = s.started
FROM (
  SELECT a."repair_ticket_id", MIN(a."created_at") AS started
  FROM "audit_logs" AS a
  WHERE a."action" = 'STATUS_CHANGE'
    AND EXISTS (
      SELECT 1 FROM jsonb_array_elements(a."changes") AS c
      WHERE c->>'field' = 'repairStatus' AND c->>'after' IN ('IN_PROGRESS', 'OUTSOURCED')
    )
  GROUP BY a."repair_ticket_id"
) AS s
WHERE t."id" = s."repair_ticket_id";

-- Backfill 2: no such row, but the ticket is in a started open status today.
UPDATE "repair_tickets"
SET "work_started_at" = "status_changed_at"
WHERE "work_started_at" IS NULL
  AND "repair_status" IN ('IN_PROGRESS', 'ON_HOLD', 'FOR_VERIFICATION', 'OUTSOURCED', 'PENDING_APPROVAL');

-- AC-21: both photo kinds are one pool for duplicates. Where the same live bytes sit in both kinds
-- on one ticket, keep the older row live and soft delete the newer one, and say so.
DO $$
DECLARE
  removed INTEGER;
BEGIN
  WITH ranked AS (
    SELECT "id",
           ROW_NUMBER() OVER (
             PARTITION BY "repair_ticket_id", "sha256"
             ORDER BY "created_at", "id"
           ) AS n
    FROM "attachments"
    WHERE "deleted_at" IS NULL AND "kind" IN ('VEHICLE_PHOTO', 'PROOF')
  )
  UPDATE "attachments" AS a
  SET "deleted_at" = CURRENT_TIMESTAMP, "deleted_by_name" = 'System'
  FROM ranked
  WHERE a."id" = ranked."id" AND ranked.n > 1;
  GET DIAGNOSTICS removed = ROW_COUNT;
  RAISE NOTICE 'spec 0018: soft deleted % duplicate photo row(s) across Before and After', removed;
END $$;

DROP INDEX "attachments_live_sha256_key";

-- PROOF maps onto VEHICLE_PHOTO, so the photo kinds share a group; documents keep their own kind.
CREATE UNIQUE INDEX "attachments_live_sha256_key" ON "attachments"(
  "repair_ticket_id",
  (CASE "kind" WHEN 'PROOF' THEN 'VEHICLE_PHOTO'::"AttachmentKind" ELSE "kind" END),
  "sha256"
) WHERE "deleted_at" IS NULL;
