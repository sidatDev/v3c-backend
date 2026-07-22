import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcrypt';
import { randomUUID } from 'crypto';

const prisma = new PrismaClient();

async function main() {
  console.log('Ensuring Super Admin account exists...');

  const email = 'admin@v3c.com';
  const rawPassword = 'SuperAdmin2026!';
  const hashedPassword = await bcrypt.hash(rawPassword, 10);

  // Get or create super_admin role
  let superAdminRole = await prisma.role.findFirst({
    where: { name: 'super_admin', isSystem: true }
  });

  if (!superAdminRole) {
    superAdminRole = await prisma.role.create({
      data: {
        name: 'super_admin',
        description: 'Platform level super administrator with full permissions',
        isSystem: true
      }
    });
  }

  // Get or create default tenant for Super Admin
  let tenant = await prisma.tenant.findFirst({
    where: { slug: 'v3c-system-tenant' }
  });

  if (!tenant) {
    tenant = await prisma.tenant.create({
      data: {
        id: randomUUID(),
        name: 'V3C Platform Administration',
        slug: 'v3c-system-tenant',
        status: 'active',
        updatedAt: new Date()
      }
    });
  }

  // Upsert user
  const user = await prisma.user.upsert({
    where: { email },
    update: {
      name: 'Platform Super Admin',
      password: hashedPassword,
      role: 'super_admin',
      status: 'active',
      tenantId: tenant.id,
      updatedAt: new Date()
    },
    create: {
      email,
      name: 'Platform Super Admin',
      password: hashedPassword,
      role: 'super_admin',
      status: 'active',
      tenantId: tenant.id,
      updatedAt: new Date()
    }
  });

  // Bind UserRole mapping
  await prisma.userRole.upsert({
    where: {
      userId_roleId_tenantId: {
        userId: user.id,
        roleId: superAdminRole.id,
        tenantId: tenant.id
      }
    },
    update: {},
    create: {
      userId: user.id,
      roleId: superAdminRole.id,
      tenantId: tenant.id
    }
  });

  console.log('\n=============================================');
  console.log('🎉 Super Admin Credentials Configured:');
  console.log(`   Email:    ${email}`);
  console.log(`   Password: ${rawPassword}`);
  console.log('=============================================\n');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
