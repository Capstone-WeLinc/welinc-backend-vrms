-- Spec 0005, AC-11: where VRMS stands in welinc-auth's directory feed, and which copy of VRMS
-- works the feed right now (the lease, AC-16). One row, id 'auth'; a null cursor means "do a
-- full read first".
CREATE TABLE "directory_sync_state" (
    "id" TEXT NOT NULL,
    "cursor" TEXT,
    "lease_until" TIMESTAMPTZ(3),
    "lease_owner" UUID,
    "failing_since" TIMESTAMPTZ(3),
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "directory_sync_state_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "directory_sync_state_single_row" CHECK ("id" = 'auth')
);

INSERT INTO "directory_sync_state" ("id") VALUES ('auth');
