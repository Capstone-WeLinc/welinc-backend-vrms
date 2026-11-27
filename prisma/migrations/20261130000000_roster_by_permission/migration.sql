-- Suite spec 0018 child 0002, AC-33 and AC-34: the mechanic roster follows the permission
-- "Can be assigned tickets" (ticket.assignable) instead of two role codes.
-- `role` keeps the person's VRMS role code, custom ones included (C_ codes, at most 30 characters).
ALTER TABLE "mechanics" DROP CONSTRAINT "mechanics_role_check";
ALTER TABLE "mechanics" ALTER COLUMN "role" TYPE VARCHAR(30);

-- Holds ticket.assignable now. False: stays on their open tickets and in history, but isn't offered
-- in assign pickers. Every existing row was a mechanic or chief, both assignable by default.
ALTER TABLE "mechanics" ADD COLUMN "assignable" BOOLEAN NOT NULL DEFAULT true;

-- Holds ticket.verify now: the lead mark on the dashboard's Team section (was role = CHIEF_MECHANIC).
-- Backfilled from the role, so nothing changes until the roster first recomputes from the grants.
ALTER TABLE "mechanics" ADD COLUMN "is_lead" BOOLEAN NOT NULL DEFAULT false;
UPDATE "mechanics" SET "is_lead" = true WHERE "role" = 'CHIEF_MECHANIC';
