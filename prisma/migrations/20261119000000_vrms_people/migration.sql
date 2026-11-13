-- Suite spec 0014 (task 13a): VRMS's own copy of every person holding a VRMS role, from the
-- directory feed, so the Users page stops calling welinc-auth's GET /auth/users.
CREATE TABLE "vrms_people" (
    "auth_user_id" UUID NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "email" VARCHAR(255) NOT NULL,
    "picture" TEXT,
    "roles" TEXT[],
    "temporary_roles" TEXT[],
    "is_active" BOOLEAN NOT NULL,
    "deleted" BOOLEAN NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "vrms_people_pkey" PRIMARY KEY ("auth_user_id")
);

-- The table starts empty: the next sync tick reads the whole directory again to fill it. A full
-- read changes nothing else that is already in step.
UPDATE "directory_sync_state" SET "cursor" = NULL;
