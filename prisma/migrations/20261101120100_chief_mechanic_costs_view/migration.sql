-- Spec 0015, AC-2: the Chief Mechanic sees costs by default. Turns the row on only when it is off and
-- no person ever changed it. One statement: it locks the matrix row first (so it is serialised with the
-- matrix editor), flips the row, logs it as System, and bumps the version only when a row flipped.
-- A fresh database has no row yet; the startup backfill inserts it on from the catalog.
WITH locked AS (
    SELECT "version" FROM "permission_matrix" WHERE "id" = 1 FOR UPDATE
),
flipped AS (
    UPDATE "role_permissions" rp
    SET "allowed" = true, "updated_at" = now(), "updated_by_user_id" = NULL
    WHERE rp."role" = 'CHIEF_MECHANIC'
      AND rp."permission" = 'ticket.costs.view'
      AND rp."allowed" = false
      AND EXISTS (SELECT 1 FROM locked)
      AND NOT EXISTS (
          SELECT 1 FROM "permission_changes" pc
          WHERE pc."role" = 'CHIEF_MECHANIC'
            AND pc."permission" = 'ticket.costs.view'
            AND pc."actor_user_id" IS NOT NULL
      )
    RETURNING rp."role", rp."permission"
),
logged AS (
    INSERT INTO "permission_changes" ("id", "role", "permission", "before", "after", "note")
    SELECT gen_random_uuid(), "role", "permission", false, true, 'Spec 0015: new Chief Mechanic default'
    FROM flipped
    RETURNING 1
)
UPDATE "permission_matrix"
SET "version" = "version" + 1, "updated_at" = CURRENT_TIMESTAMP
WHERE "id" = 1 AND EXISTS (SELECT 1 FROM logged);
