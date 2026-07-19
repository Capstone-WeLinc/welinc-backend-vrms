-- AlterTable
ALTER TABLE "repair_tickets" ADD COLUMN     "is_unlocked" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "remarks" TEXT,
ADD COLUMN     "unlock_reason" TEXT;

-- CreateTable
CREATE TABLE "repair_parts" (
    "id" UUID NOT NULL,
    "repair_ticket_id" UUID NOT NULL,
    "description" VARCHAR(255) NOT NULL,
    "unit_cost" DECIMAL(10,2) NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "subtotal" DECIMAL(10,2) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "repair_parts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shop_change_logs" (
    "id" UUID NOT NULL,
    "repair_ticket_id" UUID NOT NULL,
    "changed_by_user_id" UUID NOT NULL,
    "changed_by_name" VARCHAR(100) NOT NULL,
    "previous_value" VARCHAR(255) NOT NULL,
    "new_value" VARCHAR(255) NOT NULL,
    "changed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shop_change_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL,
    "repair_ticket_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "username" VARCHAR(50) NOT NULL,
    "action" VARCHAR(100) NOT NULL,
    "field_name" VARCHAR(50),
    "previous_value" TEXT,
    "new_value" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "audit_logs_repair_ticket_id_created_at_idx" ON "audit_logs"("repair_ticket_id", "created_at");

-- AddForeignKey
ALTER TABLE "repair_parts" ADD CONSTRAINT "repair_parts_repair_ticket_id_fkey" FOREIGN KEY ("repair_ticket_id") REFERENCES "repair_tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shop_change_logs" ADD CONSTRAINT "shop_change_logs_repair_ticket_id_fkey" FOREIGN KEY ("repair_ticket_id") REFERENCES "repair_tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_repair_ticket_id_fkey" FOREIGN KEY ("repair_ticket_id") REFERENCES "repair_tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
