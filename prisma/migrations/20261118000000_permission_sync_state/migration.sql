-- Suite spec 0013, AC-29: the matrix sync from welinc-auth's GET /auth/permissions/VRMS. One row,
-- id 'auth': the last applied ETag, when it was applied, the failing flag for the warn once rule,
-- and the lease so one copy of VRMS syncs at a time.
CREATE TABLE "permission_sync_state" (
    "id" TEXT NOT NULL,
    "etag" VARCHAR(40),
    "synced_at" TIMESTAMPTZ(3),
    "failing_since" TIMESTAMPTZ(3),
    "lease_until" TIMESTAMPTZ(3),
    "lease_owner" UUID,

    CONSTRAINT "permission_sync_state_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "permission_sync_state_single_row" CHECK ("id" = 'auth')
);

INSERT INTO "permission_sync_state" ("id") VALUES ('auth');
