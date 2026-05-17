-- CreateTable
CREATE TABLE "council_links" (
    "id" TEXT NOT NULL,
    "council_id" INTEGER NOT NULL,
    "url" TEXT NOT NULL,
    "title" TEXT,
    "source_type" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "council_links_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "council_links_council_id_idx" ON "council_links"("council_id");

-- CreateIndex
CREATE UNIQUE INDEX "council_links_council_id_url_key" ON "council_links"("council_id", "url");

-- AddForeignKey
ALTER TABLE "council_links" ADD CONSTRAINT "council_links_council_id_fkey" FOREIGN KEY ("council_id") REFERENCES "councils"("council_id") ON DELETE CASCADE ON UPDATE CASCADE;
