-- CreateEnum
CREATE TYPE "AccountType" AS ENUM ('IN_HOUSE', 'OUTSOURCED');

-- CreateEnum
CREATE TYPE "MaintenanceStatus" AS ENUM ('PENDING', 'DUE', 'IN_PROGRESS', 'COMPLETED', 'OVERDUE', 'CANCELLED');

-- CreateEnum
CREATE TYPE "MaintenanceTriggerType" AS ENUM ('MANUAL', 'ODOMETER', 'TIME');

-- CreateEnum
CREATE TYPE "MaintenanceIntervalType" AS ENUM ('DAILY', 'WEEKLY', 'MONTHLY', 'QUARTERLY', 'SEMI_ANNUALLY', 'ANNUALLY');

-- AlterTable
ALTER TABLE "maintenance_schedules"
  ALTER COLUMN "status" DROP DEFAULT,
  ALTER COLUMN "status" TYPE "MaintenanceStatus" USING (
    CASE
      WHEN UPPER(REPLACE("status"::text, '-', '_')) = 'IN_PROGRESS' THEN 'IN_PROGRESS'::"MaintenanceStatus"
      WHEN UPPER("status"::text) = 'DUE' THEN 'DUE'::"MaintenanceStatus"
      WHEN UPPER("status"::text) = 'COMPLETED' THEN 'COMPLETED'::"MaintenanceStatus"
      WHEN UPPER("status"::text) = 'OVERDUE' THEN 'OVERDUE'::"MaintenanceStatus"
      WHEN UPPER("status"::text) = 'CANCELLED' THEN 'CANCELLED'::"MaintenanceStatus"
      ELSE 'PENDING'::"MaintenanceStatus"
    END
  ),
  ALTER COLUMN "status" SET DEFAULT 'PENDING';

ALTER TABLE "maintenance_schedules"
  ALTER COLUMN "account_type" TYPE "AccountType" USING (
    CASE
      WHEN "account_type" IS NULL THEN NULL
      WHEN UPPER(REPLACE(REPLACE("account_type"::text, '-', '_'), ' ', '_')) = 'OUTSOURCED' THEN 'OUTSOURCED'::"AccountType"
      ELSE 'IN_HOUSE'::"AccountType"
    END
  );

ALTER TABLE "maintenance_schedules"
  ALTER COLUMN "trigger_type" TYPE "MaintenanceTriggerType" USING (
    CASE
      WHEN "trigger_type" IS NULL THEN NULL
      WHEN UPPER("trigger_type"::text) = 'ODOMETER' THEN 'ODOMETER'::"MaintenanceTriggerType"
      WHEN UPPER("trigger_type"::text) = 'TIME' THEN 'TIME'::"MaintenanceTriggerType"
      ELSE 'MANUAL'::"MaintenanceTriggerType"
    END
  );

ALTER TABLE "maintenance_schedules"
  ALTER COLUMN "interval_type" TYPE "MaintenanceIntervalType" USING (
    CASE
      WHEN "interval_type" IS NULL THEN NULL
      WHEN UPPER("interval_type"::text) = 'DAILY' THEN 'DAILY'::"MaintenanceIntervalType"
      WHEN UPPER("interval_type"::text) = 'WEEKLY' THEN 'WEEKLY'::"MaintenanceIntervalType"
      WHEN UPPER("interval_type"::text) = 'MONTHLY' THEN 'MONTHLY'::"MaintenanceIntervalType"
      WHEN UPPER("interval_type"::text) = 'QUARTERLY' THEN 'QUARTERLY'::"MaintenanceIntervalType"
      WHEN UPPER(REPLACE("interval_type"::text, '-', '_')) IN ('SEMI_ANNUALLY', 'SEMI_ANNUAL') THEN 'SEMI_ANNUALLY'::"MaintenanceIntervalType"
      WHEN UPPER("interval_type"::text) IN ('ANNUALLY', 'YEARLY') THEN 'ANNUALLY'::"MaintenanceIntervalType"
      ELSE NULL
    END
  );
