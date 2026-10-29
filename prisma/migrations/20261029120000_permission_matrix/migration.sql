-- Spec 0011: the stored permission matrix. Rows come from the startup backfill, not this file.

-- CreateTable
CREATE TABLE "role_permissions" (
    "role" VARCHAR(30) NOT NULL,
    "permission" VARCHAR(60) NOT NULL,
    "allowed" BOOLEAN NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_by_user_id" UUID,

    CONSTRAINT "role_permissions_pkey" PRIMARY KEY ("role","permission")
);

-- CreateTable
CREATE TABLE "permission_matrix" (
    "id" SMALLINT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "permission_matrix_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "permission_changes" (
    "id" UUID NOT NULL,
    "role" VARCHAR(30) NOT NULL,
    "permission" VARCHAR(60) NOT NULL,
    "before" BOOLEAN,
    "after" BOOLEAN,
    "actor_user_id" UUID,
    "actor_name" VARCHAR(100),
    "actor_email" VARCHAR(255),
    "note" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "permission_changes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "permission_changes_created_at_id_idx" ON "permission_changes"("created_at" DESC, "id" DESC);


-- The matrix version lives in exactly one row
ALTER TABLE "permission_matrix" ADD CONSTRAINT "permission_matrix_one_row" CHECK ("id" = 1);
INSERT INTO "permission_matrix" ("id", "version", "updated_at") VALUES (1, 1, CURRENT_TIMESTAMP);
