BEGIN;

-- 1. Create Enums if they do not exist
DO $$ BEGIN
    CREATE TYPE "Status" AS ENUM ('ACTIVE', 'INACTIVE');
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    CREATE TYPE "RoleLevel" AS ENUM ('L0_PLATFORM', 'L1_GROUP', 'L2_COMPANY', 'L3_DEPARTMENT', 'L4_AGENT');
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- 2. Create Group table
CREATE TABLE IF NOT EXISTS "Group" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "status" "Status" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Group_pkey" PRIMARY KEY ("id")
);

-- 3. Create Department table
CREATE TABLE IF NOT EXISTS "Department" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "Status" NOT NULL DEFAULT 'ACTIVE',
    "tenantId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Department_pkey" PRIMARY KEY ("id")
);

-- 4. Create unique & lookup indexes
CREATE UNIQUE INDEX IF NOT EXISTS "Group_slug_key" ON "Group"("slug");
CREATE INDEX IF NOT EXISTS "Department_tenantId_idx" ON "Department"("tenantId");

-- 5. Alter Tenant table (add optional groupId column and index)
ALTER TABLE "Tenant" ADD COLUMN IF NOT EXISTS "groupId" TEXT;
CREATE INDEX IF NOT EXISTS "Tenant_groupId_idx" ON "Tenant"("groupId");

-- 6. Alter User table (add optional departmentId column and index)
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "departmentId" TEXT;
CREATE INDEX IF NOT EXISTS "User_departmentId_idx" ON "User"("departmentId");

-- 7. Alter Role table (add level column)
ALTER TABLE "Role" ADD COLUMN IF NOT EXISTS "level" "RoleLevel" NOT NULL DEFAULT 'L4_AGENT';

-- 8. Add Foreign Key constraints
DO $$ BEGIN
    ALTER TABLE "Department" ADD CONSTRAINT "Department_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    ALTER TABLE "Tenant" ADD CONSTRAINT "Tenant_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    ALTER TABLE "User" ADD CONSTRAINT "User_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

COMMIT;
