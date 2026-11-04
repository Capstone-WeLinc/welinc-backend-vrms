-- Spec 0022, AC-4: each roster person's VRMS role, for the Chief badge on the Mechanics screen.
-- Empty until that person's next sign in or the next Admin sync: this migration cannot reach
-- welinc-auth. Prisma does not model CHECK constraints, so `migrate dev` reports no drift.
ALTER TABLE "mechanics" ADD COLUMN "role" VARCHAR(20);

ALTER TABLE "mechanics" ADD CONSTRAINT "mechanics_role_check"
  CHECK ("role" IS NULL OR "role" IN ('MECHANIC', 'CHIEF_MECHANIC'));
