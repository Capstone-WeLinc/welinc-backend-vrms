-- AlterTable
ALTER TABLE "bookings" ADD COLUMN     "delivery_type" TEXT,
ADD COLUMN     "driver_id" UUID,
ADD COLUMN     "garage" TEXT,
ADD COLUMN     "helper_ids" TEXT[],
ADD COLUMN     "time" TEXT,
ADD COLUMN     "vehicle_id" UUID;

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "vehicles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_driver_id_fkey" FOREIGN KEY ("driver_id") REFERENCES "drivers"("id") ON DELETE SET NULL ON UPDATE CASCADE;
