-- Suite spec 0013, AC-28 and AC-30: VRMS's matrix history moved to welinc-auth's permission_changes
-- (npm run permissions:export here, then npm run permissions:import -- VRMS <file> there). Run that
-- export against this database BEFORE this migration deploys, or the history is lost.
-- DropTable
DROP TABLE "permission_changes";

