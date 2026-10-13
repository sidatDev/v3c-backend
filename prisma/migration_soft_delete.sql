-- Add isDeleted soft-delete column and indexes to InterestedClient and PotentialClient
ALTER TABLE "InterestedClient" ADD COLUMN IF NOT EXISTS "isDeleted" BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS "InterestedClient_isDeleted_idx" ON "InterestedClient"("isDeleted");

ALTER TABLE "PotentialClient" ADD COLUMN IF NOT EXISTS "isDeleted" BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS "PotentialClient_isDeleted_idx" ON "PotentialClient"("isDeleted");
