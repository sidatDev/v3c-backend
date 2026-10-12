CREATE TABLE IF NOT EXISTS "InterestedClient" (
  "id" SERIAL PRIMARY KEY,
  "name" TEXT NOT NULL,
  "email" TEXT,
  "phone" TEXT,
  "message" TEXT,
  "ipAddress" TEXT,
  "tenantId" TEXT NOT NULL REFERENCES "Tenant"("id") ON DELETE CASCADE,
  "domainId" INTEGER REFERENCES "Domain"("id"),
  "aiAgentId" TEXT REFERENCES "Agent"("id"),
  "visitorId" INTEGER,
  "visitorSessionId" INTEGER REFERENCES "VisitorSession"("id"),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS "InterestedClient_tenantId_idx" ON "InterestedClient"("tenantId");
CREATE INDEX IF NOT EXISTS "InterestedClient_createdAt_idx" ON "InterestedClient"("createdAt");
CREATE INDEX IF NOT EXISTS "InterestedClient_email_idx" ON "InterestedClient"("email");
CREATE INDEX IF NOT EXISTS "InterestedClient_phone_idx" ON "InterestedClient"("phone");
CREATE INDEX IF NOT EXISTS "InterestedClient_visitorSessionId_idx" ON "InterestedClient"("visitorSessionId");

CREATE TABLE IF NOT EXISTS "PotentialClient" (
  "id" SERIAL PRIMARY KEY,
  "interestedClientId" INTEGER NOT NULL UNIQUE REFERENCES "InterestedClient"("id") ON DELETE CASCADE,
  "confidenceScore" INTEGER NOT NULL,
  "summary" TEXT NOT NULL,
  "reasoning" TEXT,
  "keyIntents" TEXT[] DEFAULT ARRAY[]::TEXT[],
  "tenantId" TEXT NOT NULL REFERENCES "Tenant"("id") ON DELETE CASCADE,
  "evaluatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS "PotentialClient_tenantId_idx" ON "PotentialClient"("tenantId");
CREATE INDEX IF NOT EXISTS "PotentialClient_confidenceScore_idx" ON "PotentialClient"("confidenceScore");
CREATE INDEX IF NOT EXISTS "PotentialClient_createdAt_idx" ON "PotentialClient"("createdAt");

ALTER TABLE "Conversation" ADD COLUMN IF NOT EXISTS "interestedClientId" INTEGER REFERENCES "InterestedClient"("id");
CREATE INDEX IF NOT EXISTS "Conversation_interestedClientId_idx" ON "Conversation"("interestedClientId");
