-- Spec 0012: stored settings. Rows hold only values an Admin changed; the catalog in
-- src/settings/catalog.ts owns every type, default and range.

-- CreateTable
CREATE TABLE "app_settings" (
    "key" VARCHAR(60) NOT NULL,
    "value" JSONB NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_by_user_id" UUID,

    CONSTRAINT "app_settings_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "settings_state" (
    "id" SMALLINT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "settings_state_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "setting_changes" (
    "id" UUID NOT NULL,
    "key" VARCHAR(60) NOT NULL,
    "before" JSONB NOT NULL,
    "after" JSONB NOT NULL,
    "action" VARCHAR(10) NOT NULL,
    "actor_user_id" UUID,
    "actor_name" VARCHAR(100),
    "actor_email" VARCHAR(255),
    "note" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "setting_changes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "setting_changes_key_idx" ON "setting_changes"("key");

-- CreateIndex
CREATE INDEX "setting_changes_created_at_id_idx" ON "setting_changes"("created_at" DESC, "id" DESC);


-- The settings version lives in exactly one row
ALTER TABLE "settings_state" ADD CONSTRAINT "settings_state_one_row" CHECK ("id" = 1);
INSERT INTO "settings_state" ("id", "version", "updated_at") VALUES (1, 1, CURRENT_TIMESTAMP);

-- AC-18: issue categories move from knowledge.edit to lookups.manage, so each role keeps the
-- access it had. Logged by System, with one matrix version bump only when rows were inserted.
WITH inserted AS (
    INSERT INTO "role_permissions" ("role", "permission", "allowed", "updated_at")
    SELECT "role", 'lookups.manage', "allowed", now()
    FROM "role_permissions"
    WHERE "permission" = 'knowledge.edit'
    ON CONFLICT DO NOTHING
    RETURNING "role", "permission", "allowed"
),
logged AS (
    INSERT INTO "permission_changes" ("id", "role", "permission", "before", "after", "note")
    SELECT gen_random_uuid(), "role", "permission", NULL, "allowed", 'Copied from knowledge.edit (spec 0012)'
    FROM inserted
    RETURNING 1
)
UPDATE "permission_matrix"
SET "version" = "version" + 1, "updated_at" = CURRENT_TIMESTAMP
WHERE "id" = 1 AND EXISTS (SELECT 1 FROM logged);
