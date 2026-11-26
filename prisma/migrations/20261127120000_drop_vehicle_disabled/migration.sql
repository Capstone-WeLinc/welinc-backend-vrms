-- Spec 0029 (child 0001), AC-4: a truck's status is VMMS's value now, and VMMS has no DISABLED.
-- Rows still on it become AVAILABLE until the fleet sync writes VMMS's value over them.
UPDATE "vehicles" SET "status" = 'AVAILABLE' WHERE "status" = 'DISABLED';
UPDATE "repair_tickets" SET "prior_vehicle_status" = 'AVAILABLE' WHERE "prior_vehicle_status" = 'DISABLED';

ALTER TYPE "VehicleStatus" RENAME TO "VehicleStatus_old";
CREATE TYPE "VehicleStatus" AS ENUM ('AVAILABLE', 'UNDER_REPAIR', 'UNDER_MAINTENANCE');
ALTER TABLE "vehicles" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "vehicles" ALTER COLUMN "status" TYPE "VehicleStatus" USING ("status"::text::"VehicleStatus");
ALTER TABLE "vehicles" ALTER COLUMN "status" SET DEFAULT 'AVAILABLE';
ALTER TABLE "repair_tickets" ALTER COLUMN "prior_vehicle_status" TYPE "VehicleStatus" USING ("prior_vehicle_status"::text::"VehicleStatus");
DROP TYPE "VehicleStatus_old";
