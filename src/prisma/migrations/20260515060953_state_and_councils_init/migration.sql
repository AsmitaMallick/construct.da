-- CreateTable
CREATE TABLE "State" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "State_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "councils" (
    "council_id" TEXT NOT NULL,
    "council_name" TEXT NOT NULL,
    "state_id" TEXT,
    "official_website" TEXT,
    "status" TEXT DEFAULT 'pending',
    "documents_found" INTEGER NOT NULL DEFAULT 0,
    "last_processed_at" TIMESTAMP(3),
    "notes" TEXT,

    CONSTRAINT "councils_pkey" PRIMARY KEY ("council_id")
);

-- CreateTable
CREATE TABLE "council_documents" (
    "doc_id" TEXT NOT NULL,
    "council_id" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "domain" TEXT,
    "document_title" TEXT,
    "document_type" TEXT,
    "file_format" TEXT,
    "file_size_bytes" BIGINT,
    "content_hash" TEXT,
    "publication_date" TIMESTAMP(3),
    "is_archived" BOOLEAN NOT NULL DEFAULT false,
    "credibility_score" DOUBLE PRECISION,
    "validation_decision" TEXT,
    "validation_reason" TEXT,
    "blob_url" TEXT,
    "text_extracted" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "council_documents_pkey" PRIMARY KEY ("doc_id")
);

-- CreateTable
CREATE TABLE "validation_audit_log" (
    "log_id" SERIAL NOT NULL,
    "run_id" TEXT,
    "council_id" TEXT,
    "url" TEXT,
    "check_name" TEXT,
    "check_result" TEXT,
    "check_detail" TEXT,
    "llm_prompt" TEXT,
    "llm_response" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "validation_audit_log_pkey" PRIMARY KEY ("log_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "State_code_key" ON "State"("code");

-- CreateIndex
CREATE UNIQUE INDEX "State_name_key" ON "State"("name");

-- CreateIndex
CREATE INDEX "councils_state_id_idx" ON "councils"("state_id");

-- AddForeignKey
ALTER TABLE "councils" ADD CONSTRAINT "councils_state_id_fkey" FOREIGN KEY ("state_id") REFERENCES "State"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "council_documents" ADD CONSTRAINT "council_documents_council_id_fkey" FOREIGN KEY ("council_id") REFERENCES "councils"("council_id") ON DELETE RESTRICT ON UPDATE CASCADE;
