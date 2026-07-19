-- CreateTable
CREATE TABLE "bookings" (
    "id" UUID NOT NULL,
    "booking_id" VARCHAR(50) NOT NULL,
    "client" VARCHAR(200) NOT NULL,
    "service" VARCHAR(100) NOT NULL,
    "date" TEXT NOT NULL,
    "pickup_address" TEXT,
    "delivery_address" TEXT,
    "status" TEXT NOT NULL DEFAULT 'For Plotting',
    "amount" DECIMAL(10,2),
    "discrepancy_note" TEXT,
    "flagged" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "bookings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "bookings_booking_id_key" ON "bookings"("booking_id");
