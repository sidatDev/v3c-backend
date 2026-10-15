import prisma from '../src/lib/prisma';
import { RoleLevel, Status } from '@prisma/client';
import bcrypt from 'bcrypt';
import { randomUUID } from 'crypto';

interface RoleDefinition {
  name: string;
  level: RoleLevel;
  isSystem: boolean;
  aliases: string[];
}

interface UserDefinition {
  level: RoleLevel;
  roleKey: string;
  userRole: string;
  name: string;
  email: string;
  rawPassword: string;
  tenantSlug: string;
  departmentKey: string | null;
}

async function main() {
  console.log('\n============================================================');
  console.log('🚀 Starting Hierarchical Multi-Tenancy Seed (L0 to L4)');
  console.log('============================================================\n');

  // -------------------------------------------------------------------------
  // 1. Roles (L0_PLATFORM to L4_AGENT)
  // -------------------------------------------------------------------------
  console.log('--- [1/5] Roles Setup ---');
  const roleDefs: RoleDefinition[] = [
    { name: 'Super Admin', level: RoleLevel.L0_PLATFORM, isSystem: true, aliases: ['super_admin'] },
    { name: 'Group Manager', level: RoleLevel.L1_GROUP, isSystem: false, aliases: ['group_manager'] },
    { name: 'Company Admin', level: RoleLevel.L2_COMPANY, isSystem: false, aliases: ['company_admin'] },
    { name: 'Department Manager', level: RoleLevel.L3_DEPARTMENT, isSystem: false, aliases: ['dept_manager'] },
    { name: 'Agent', level: RoleLevel.L4_AGENT, isSystem: false, aliases: ['agent'] }
  ];

  const roles: Record<string, any> = {};

  for (const def of roleDefs) {
    const existing = await prisma.role.findFirst({
      where: {
        OR: [
          { name: def.name },
          { name: { in: def.aliases } }
        ],
        tenantId: null
      }
    });

    let role;
    if (!existing) {
      role = await prisma.role.create({
        data: {
          id: randomUUID(),
          name: def.name,
          level: def.level,
          isSystem: def.isSystem,
          description: `${def.name} role for ${def.level} hierarchy level`,
          updatedAt: new Date()
        }
      });
      console.log(`✅ Created Role: ${role.name} (${role.level}) [ID: ${role.id}]`);
    } else {
      role = await prisma.role.update({
        where: { id: existing.id },
        data: {
          name: def.name,
          level: def.level,
          isSystem: def.isSystem,
          updatedAt: new Date()
        }
      });
      console.log(`🔁 Updated/Preserved Role: ${role.name} (${role.level}) [ID: ${role.id}]`);
    }
    roles[def.name] = role;
    // Map aliases too for lookup flexibility
    for (const alias of def.aliases) {
      roles[alias] = role;
    }
  }

  // -------------------------------------------------------------------------
  // 2. Test Group (L1)
  // -------------------------------------------------------------------------
  console.log('\n--- [2/5] Group Setup ---');
  const groupSlug = 'test-group';
  const existingGroup = await prisma.group.findUnique({
    where: { slug: groupSlug }
  });

  let group;
  if (!existingGroup) {
    group = await prisma.group.create({
      data: {
        id: randomUUID(),
        name: 'Test Group',
        slug: groupSlug,
        status: Status.ACTIVE
      }
    });
    console.log(`✅ Created Group: ${group.name} (${group.slug}) [ID: ${group.id}]`);
  } else {
    group = await prisma.group.update({
      where: { slug: groupSlug },
      data: {
        name: 'Test Group',
        status: Status.ACTIVE
      }
    });
    console.log(`🔁 Preserved Group: ${group.name} (${group.slug}) [ID: ${group.id}]`);
  }

  // -------------------------------------------------------------------------
  // 3. Test Tenants (L2) under Test Group
  // -------------------------------------------------------------------------
  console.log('\n--- [3/5] Tenants Setup (under Test Group) ---');
  const tenantDefs = [
    { name: 'Test Company A', slug: 'test-company-a' },
    { name: 'Test Company B', slug: 'test-company-b' }
  ];

  const tenants: Record<string, any> = {};

  for (const tDef of tenantDefs) {
    const existing = await prisma.tenant.findUnique({
      where: { slug: tDef.slug }
    });

    let tenant;
    if (!existing) {
      tenant = await prisma.tenant.create({
        data: {
          id: randomUUID(),
          name: tDef.name,
          slug: tDef.slug,
          status: 'ACTIVE',
          groupId: group.id,
          updatedAt: new Date()
        }
      });
      console.log(`✅ Created Tenant: ${tenant.name} (${tenant.slug}) [ID: ${tenant.id}]`);
    } else {
      tenant = await prisma.tenant.update({
        where: { slug: tDef.slug },
        data: {
          name: tDef.name,
          status: 'ACTIVE',
          groupId: group.id,
          updatedAt: new Date()
        }
      });
      console.log(`🔁 Preserved Tenant: ${tenant.name} (${tenant.slug}) [ID: ${tenant.id}]`);
    }
    tenants[tDef.slug] = tenant;

    // Ensure tenant limits exist
    const existingLimit = await prisma.tenantLimit.findUnique({
      where: { tenantId: tenant.id }
    });
    if (!existingLimit) {
      await prisma.tenantLimit.create({
        data: {
          id: randomUUID(),
          tenantId: tenant.id,
          maxLeads: 100,
          maxConversations: 1000,
          maxStorage: BigInt(104857600),
          updatedAt: new Date()
        }
      });
    }
  }

  // -------------------------------------------------------------------------
  // 4. Test Departments (L3) under Tenant A
  // -------------------------------------------------------------------------
  console.log('\n--- [4/5] Departments Setup (under Test Company A) ---');
  const tenantA = tenants['test-company-a'];
  const deptDefs = [
    { key: 'sales', name: 'Sales Department' },
    { key: 'support', name: 'Support Department' }
  ];

  const departments: Record<string, any> = {};

  for (const dDef of deptDefs) {
    const existing = await prisma.department.findFirst({
      where: {
        name: dDef.name,
        tenantId: tenantA.id
      }
    });

    let dept;
    if (!existing) {
      dept = await prisma.department.create({
        data: {
          id: randomUUID(),
          name: dDef.name,
          tenantId: tenantA.id,
          status: Status.ACTIVE
        }
      });
      console.log(`✅ Created Department: ${dept.name} [ID: ${dept.id}]`);
    } else {
      dept = await prisma.department.update({
        where: { id: existing.id },
        data: {
          status: Status.ACTIVE
        }
      });
      console.log(`🔁 Preserved Department: ${dept.name} [ID: ${dept.id}]`);
    }
    departments[dDef.key] = dept;
  }

  // -------------------------------------------------------------------------
  // 5. Test Users (L0 to L4)
  // -------------------------------------------------------------------------
  console.log('\n--- [5/5] Users & UserRole Setup (L0 through L4) ---');
  const userDefs: UserDefinition[] = [
    {
      level: RoleLevel.L0_PLATFORM,
      roleKey: 'Super Admin',
      userRole: 'super_admin',
      name: 'Platform Admin',
      email: 'platform@test.com',
      rawPassword: 'Platform@123',
      tenantSlug: 'test-company-a',
      departmentKey: null
    },
    {
      level: RoleLevel.L1_GROUP,
      roleKey: 'Group Manager',
      userRole: 'group_manager',
      name: 'Group Manager',
      email: 'group@test.com',
      rawPassword: 'Group@123',
      tenantSlug: 'test-company-a',
      departmentKey: null
    },
    {
      level: RoleLevel.L2_COMPANY,
      roleKey: 'Company Admin',
      userRole: 'company_admin',
      name: 'Company Admin',
      email: 'company@test.com',
      rawPassword: 'Company@123',
      tenantSlug: 'test-company-a',
      departmentKey: null
    },
    {
      level: RoleLevel.L3_DEPARTMENT,
      roleKey: 'Department Manager',
      userRole: 'dept_manager',
      name: 'Sales Manager',
      email: 'sales@test.com',
      rawPassword: 'Sales@123',
      tenantSlug: 'test-company-a',
      departmentKey: 'sales'
    },
    {
      level: RoleLevel.L4_AGENT,
      roleKey: 'Agent',
      userRole: 'agent',
      name: 'Support Agent',
      email: 'support@test.com',
      rawPassword: 'Support@123',
      tenantSlug: 'test-company-a',
      departmentKey: 'support'
    }
  ];

  const credentialsTable: Array<{
    Level: string;
    Role: string;
    Name: string;
    Email: string;
    Password: string;
    Tenant: string;
    Department: string;
  }> = [];

  for (const uDef of userDefs) {
    const hashedPassword = await bcrypt.hash(uDef.rawPassword, 10);
    const assignedTenant = tenants[uDef.tenantSlug];
    const assignedDeptId = uDef.departmentKey ? departments[uDef.departmentKey].id : null;
    const assignedRole = roles[uDef.roleKey];

    const existingUser = await prisma.user.findUnique({
      where: { email: uDef.email }
    });

    let user;
    if (!existingUser) {
      user = await prisma.user.create({
        data: {
          name: uDef.name,
          email: uDef.email,
          password: hashedPassword,
          role: uDef.userRole,
          status: 'active',
          tenantId: assignedTenant.id,
          departmentId: assignedDeptId,
          updatedAt: new Date()
        }
      });
      console.log(`✅ Created User: ${user.name} (${user.email}) [Level: ${uDef.level}]`);
    } else {
      user = await prisma.user.update({
        where: { email: uDef.email },
        data: {
          name: uDef.name,
          password: hashedPassword,
          role: uDef.userRole,
          status: 'active',
          tenantId: assignedTenant.id,
          departmentId: assignedDeptId,
          updatedAt: new Date()
        }
      });
      console.log(`🔁 Preserved/Updated User: ${user.name} (${user.email}) [Level: ${uDef.level}]`);
    }

    // Upsert UserRole mapping
    await prisma.userRole.upsert({
      where: {
        userId_roleId_tenantId: {
          userId: user.id,
          roleId: assignedRole.id,
          tenantId: assignedTenant.id
        }
      },
      update: {},
      create: {
        id: randomUUID(),
        userId: user.id,
        roleId: assignedRole.id,
        tenantId: assignedTenant.id
      }
    });

    credentialsTable.push({
      Level: uDef.level,
      Role: uDef.roleKey,
      Name: uDef.name,
      Email: uDef.email,
      Password: uDef.rawPassword,
      Tenant: assignedTenant.name,
      Department: uDef.departmentKey ? departments[uDef.departmentKey].name : 'None'
    });
  }

  // -------------------------------------------------------------------------
  // Summary Credentials Table
  // -------------------------------------------------------------------------
  console.log('\n📋 =================== TEST CREDENTIALS SUMMARY ===================');
  console.table(credentialsTable);
  console.log('====================================================================\n');
  console.log('✨ Hierarchical multi-tenancy seeding completed successfully!\n');
}

main()
  .catch((e) => {
    console.error('❌ Seeding failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
