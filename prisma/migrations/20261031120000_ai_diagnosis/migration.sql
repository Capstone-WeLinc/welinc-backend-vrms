-- Spec 0013: AI moves into backend-vrms. Plain SQL for the extension (no postgresqlExtensions
-- preview feature); on Azure, azure.extensions must allow VECTOR before this runs.
CREATE EXTENSION IF NOT EXISTS vector;

-- CreateTable
CREATE TABLE "issue_embeddings" (
    "issue_id" UUID NOT NULL,
    "embedding" vector(768) NOT NULL,
    "model" VARCHAR(60) NOT NULL,
    "text_hash" CHAR(64) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "issue_embeddings_pkey" PRIMARY KEY ("issue_id")
);

-- CreateTable
CREATE TABLE "ai_diagnoses" (
    "id" UUID NOT NULL,
    "repair_ticket_id" UUID NOT NULL,
    "requested_by_user_id" UUID NOT NULL,
    "input" JSONB NOT NULL,
    "similar" JSONB NOT NULL,
    "result" JSONB NOT NULL,
    "model" VARCHAR(60) NOT NULL,
    "confidence" VARCHAR(10) NOT NULL,
    "latency_ms" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_diagnoses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_diagnosis_feedback" (
    "id" UUID NOT NULL,
    "diagnosis_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "helpful" BOOLEAN NOT NULL,
    "rating" SMALLINT,
    "comment" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "ai_diagnosis_feedback_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ai_diagnoses_repair_ticket_id_created_at_idx" ON "ai_diagnoses"("repair_ticket_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "ai_diagnoses_requested_by_user_id_created_at_idx" ON "ai_diagnoses"("requested_by_user_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "ai_diagnosis_feedback_diagnosis_id_user_id_key" ON "ai_diagnosis_feedback"("diagnosis_id", "user_id");

-- AddForeignKey
ALTER TABLE "issue_embeddings" ADD CONSTRAINT "issue_embeddings_issue_id_fkey" FOREIGN KEY ("issue_id") REFERENCES "repair_issues"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_diagnoses" ADD CONSTRAINT "ai_diagnoses_repair_ticket_id_fkey" FOREIGN KEY ("repair_ticket_id") REFERENCES "repair_tickets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_diagnosis_feedback" ADD CONSTRAINT "ai_diagnosis_feedback_diagnosis_id_fkey" FOREIGN KEY ("diagnosis_id") REFERENCES "ai_diagnoses"("id") ON DELETE CASCADE ON UPDATE CASCADE;
