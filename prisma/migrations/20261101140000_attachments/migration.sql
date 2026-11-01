-- Spec 0017: ticket attachments (vehicle photos, proof, receipts, other documents). Additive.
CREATE TYPE "AttachmentKind" AS ENUM ('VEHICLE_PHOTO', 'PROOF', 'RECEIPT', 'OTHER_DOCUMENT');

CREATE TABLE "attachments" (
    "id" UUID NOT NULL,
    "repair_ticket_id" UUID NOT NULL,
    "issue_id" UUID,
    "kind" "AttachmentKind" NOT NULL,
    "storage_key" VARCHAR(300) NOT NULL,
    "thumbnail_key" VARCHAR(300),
    "file_name" VARCHAR(255) NOT NULL,
    "mime_type" VARCHAR(100) NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "sha256" CHAR(64) NOT NULL,
    "uploaded_by_user_id" UUID NOT NULL,
    "uploaded_by_name" VARCHAR(100) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(6),
    "deleted_by_user_id" UUID,
    "deleted_by_name" VARCHAR(100),
    "purged_at" TIMESTAMPTZ(6),
    CONSTRAINT "attachments_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "attachments_storage_key_key" ON "attachments"("storage_key");
CREATE INDEX "attachments_repair_ticket_id_kind_idx" ON "attachments"("repair_ticket_id", "kind");
CREATE INDEX "attachments_issue_id_idx" ON "attachments"("issue_id");

-- AC-8: at most one live attachment per ticket, kind and uploaded bytes. A backstop: the service
-- checks for the duplicate first, under the ticket row lock.
CREATE UNIQUE INDEX "attachments_live_sha256_key" ON "attachments"("repair_ticket_id", "kind", "sha256")
  WHERE "deleted_at" IS NULL;

-- AC-19: the purge reads removed rows whose blobs are not deleted yet.
CREATE INDEX "attachments_purge_due_idx" ON "attachments"("deleted_at")
  WHERE "purged_at" IS NULL AND "deleted_at" IS NOT NULL;

ALTER TABLE "attachments" ADD CONSTRAINT "attachments_repair_ticket_id_fkey"
  FOREIGN KEY ("repair_ticket_id") REFERENCES "repair_tickets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_issue_id_fkey"
  FOREIGN KEY ("issue_id") REFERENCES "repair_issues"("id") ON DELETE SET NULL ON UPDATE CASCADE;
