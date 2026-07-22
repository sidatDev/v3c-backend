import { PrismaClient } from '@prisma/client';
import { DEFAULT_PERMISSIONS, RESOURCES, ACTIONS } from '../src/constants/permissions';

const prisma = new PrismaClient();

async function main() {
  console.log('Seeding default permissions...');
  
  // 1. Seed Permissions
  const permissionMap = new Map<string, string>(); // 'resource:action' -> id
  for (const perm of DEFAULT_PERMISSIONS) {
    const existing = await prisma.permission.findFirst({
      where: { resource: perm.resource, action: perm.action }
    });
    
    if (existing) {
      console.log(`Permission ${perm.resource}:${perm.action} already exists.`);
      permissionMap.set(`${perm.resource}:${perm.action}`, existing.id);
    } else {
      const created = await prisma.permission.create({
        data: {
          resource: perm.resource,
          action: perm.action,
          description: perm.description,
        }
      });
      console.log(`Created permission ${perm.resource}:${perm.action}`);
      permissionMap.set(`${perm.resource}:${perm.action}`, created.id);
    }
  }

  console.log('Seeding default roles...');

  // 2. Seed System Roles
  const roles = [
    { name: 'super_admin', description: 'Platform level super administrator with full permissions' },
    { name: 'manager', description: 'Tenant level administrator' },
    { name: 'member', description: 'Support agent with access to conversations and leads' }
  ];

  const roleMap = new Map<string, string>(); // name -> id
  for (const roleDef of roles) {
    const existing = await prisma.role.findFirst({
      where: { name: roleDef.name, isSystem: true }
    });

    if (existing) {
      console.log(`System role ${roleDef.name} already exists.`);
      roleMap.set(roleDef.name, existing.id);
    } else {
      const created = await prisma.role.create({
        data: {
          name: roleDef.name,
          description: roleDef.description,
          isSystem: true
        }
      });
      console.log(`Created system role ${roleDef.name}`);
      roleMap.set(roleDef.name, created.id);
    }
  }

  // 3. Bind Permissions to Roles (RolePermission)
  console.log('Mapping permissions to roles...');

  // Super Admin: gets all permissions
  const superAdminRoleId = roleMap.get('super_admin')!;
  for (const [key, permId] of permissionMap.entries()) {
    const existing = await prisma.rolePermission.findUnique({
      where: { roleId_permissionId: { roleId: superAdminRoleId, permissionId: permId } }
    });
    if (!existing) {
      await prisma.rolePermission.create({
        data: { roleId: superAdminRoleId, permissionId: permId }
      });
    }
  }
  console.log('Mapped all permissions to super_admin.');

  // Manager: gets all permissions except integrations
  const managerRoleId = roleMap.get('manager')!;
  for (const [key, permId] of permissionMap.entries()) {
    const [resource] = key.split(':');
    if (resource === RESOURCES.INTEGRATIONS) continue; // Exclude integrations
    
    const existing = await prisma.rolePermission.findUnique({
      where: { roleId_permissionId: { roleId: managerRoleId, permissionId: permId } }
    });
    if (!existing) {
      await prisma.rolePermission.create({
        data: { roleId: managerRoleId, permissionId: permId }
      });
    }
  }
  console.log('Mapped permissions to manager (excluding integrations).');

  // Member: dashboard (view), conversations (view, manage), agent_inbox (manage), leads (view, create, edit, manage), account (view, edit), notifications (view, manage)
  const memberRoleId = roleMap.get('member')!;
  const memberAllowedKeys = [
    `${RESOURCES.DASHBOARD}:${ACTIONS.VIEW}`,
    `${RESOURCES.CONVERSATIONS}:${ACTIONS.VIEW}`,
    `${RESOURCES.CONVERSATIONS}:${ACTIONS.MANAGE}`,
    `${RESOURCES.LEADS}:${ACTIONS.VIEW}`,
    `${RESOURCES.LEADS}:${ACTIONS.CREATE}`,
    `${RESOURCES.LEADS}:${ACTIONS.EDIT}`,
    `${RESOURCES.LEADS}:${ACTIONS.MANAGE}`,
    `${RESOURCES.ACCOUNT}:${ACTIONS.VIEW}`,
    `${RESOURCES.ACCOUNT}:${ACTIONS.EDIT}`,
    `${RESOURCES.NOTIFICATIONS}:${ACTIONS.VIEW}`,
    `${RESOURCES.NOTIFICATIONS}:${ACTIONS.MANAGE}`,
  ];

  for (const key of memberAllowedKeys) {
    const permId = permissionMap.get(key);
    if (!permId) continue;

    const existing = await prisma.rolePermission.findUnique({
      where: { roleId_permissionId: { roleId: memberRoleId, permissionId: permId } }
    });
    if (!existing) {
      await prisma.rolePermission.create({
        data: { roleId: memberRoleId, permissionId: permId }
      });
    }
  }
  console.log('Mapped selected permissions to member.');

  // 4. Migrate existing User.role to UserRole
  console.log('Migrating existing users to UserRole table...');
  const users = await prisma.user.findMany();
  let migratedCount = 0;

  for (const user of users) {
    // Map text role to system role ID
    let targetRoleName = 'member';
    const userRoleLower = user.role.toLowerCase();
    
    if (userRoleLower === 'super_admin' || userRoleLower === 'superadmin') {
      targetRoleName = 'super_admin';
    } else if (userRoleLower === 'manager' || userRoleLower === 'admin') {
      targetRoleName = 'manager';
    } else {
      targetRoleName = 'member';
    }

    const roleId = roleMap.get(targetRoleName);
    if (!roleId) continue;

    // Check if mapping already exists
    const existingUserRole = await prisma.userRole.findUnique({
      where: {
        userId_roleId_tenantId: {
          userId: user.id,
          roleId: roleId,
          tenantId: user.tenantId
        }
      }
    });

    if (!existingUserRole) {
      await prisma.userRole.create({
        data: {
          userId: user.id,
          roleId: roleId,
          tenantId: user.tenantId
        }
      });
      migratedCount++;
    }
  }

  console.log(`Migrated ${migratedCount} users to the UserRole schema.`);
  console.log('Seeding completed successfully!');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
