/*
  Warnings:

  - You are about to drop the `contact_tags` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `deal_tags` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "contact_tags" DROP CONSTRAINT "contact_tags_contact_id_fkey";

-- DropForeignKey
ALTER TABLE "contact_tags" DROP CONSTRAINT "contact_tags_tag_id_fkey";

-- DropForeignKey
ALTER TABLE "deal_tags" DROP CONSTRAINT "deal_tags_deal_id_fkey";

-- DropForeignKey
ALTER TABLE "deal_tags" DROP CONSTRAINT "deal_tags_tag_id_fkey";

-- DropTable
DROP TABLE "contact_tags";

-- DropTable
DROP TABLE "deal_tags";

-- CreateTable
CREATE TABLE "record_tags" (
    "id" TEXT NOT NULL,
    "org_id" TEXT NOT NULL,
    "tag_id" TEXT NOT NULL,
    "entity_type" "EntityType" NOT NULL,
    "entity_id" TEXT NOT NULL,
    "created_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "record_tags_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "record_tags_org_id_entity_type_entity_id_idx" ON "record_tags"("org_id", "entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "record_tags_org_id_tag_id_idx" ON "record_tags"("org_id", "tag_id");

-- CreateIndex
CREATE UNIQUE INDEX "record_tags_tag_id_entity_type_entity_id_key" ON "record_tags"("tag_id", "entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "tags_org_id_module_idx" ON "tags"("org_id", "module");

-- AddForeignKey
ALTER TABLE "record_tags" ADD CONSTRAINT "record_tags_tag_id_fkey" FOREIGN KEY ("tag_id") REFERENCES "tags"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "record_tags" ADD CONSTRAINT "record_tags_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "record_tags" ADD CONSTRAINT "record_tags_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
