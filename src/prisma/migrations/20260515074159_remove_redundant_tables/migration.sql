/*
  Warnings:

  - The primary key for the `councils` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - The `council_id` column on the `councils` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - You are about to drop the `council_documents` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `validation_audit_log` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "council_documents" DROP CONSTRAINT "council_documents_council_id_fkey";

-- AlterTable
ALTER TABLE "councils" DROP CONSTRAINT "councils_pkey",
DROP COLUMN "council_id",
ADD COLUMN     "council_id" SERIAL NOT NULL,
ADD CONSTRAINT "councils_pkey" PRIMARY KEY ("council_id");

-- DropTable
DROP TABLE "council_documents";

-- DropTable
DROP TABLE "validation_audit_log";
