-- Spec 0019: admin ticket editing. Additive: three nullable columns, no backfill.

-- Who edited the ticket last and when (details, mechanics or issues). The audit rows stay the record.
ALTER TABLE "repair_tickets" ADD COLUMN "edited_at" TIMESTAMPTZ(6);
ALTER TABLE "repair_tickets" ADD COLUMN "edited_by_user_id" UUID;
ALTER TABLE "repair_tickets" ADD COLUMN "edited_by_name" VARCHAR(100);
