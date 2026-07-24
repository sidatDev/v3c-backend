import { FastifyInstance, FastifyPluginOptions } from 'fastify';
import prisma from '../lib/prisma';
import { protect } from '../middleware/auth';
import { restrictTo } from '../middleware/rbac';
import { AppError } from '../middleware/error';

export default async function rolesRoutes(fastify: FastifyInstance, options: FastifyPluginOptions) {

  // @route   GET /api/roles/permissions
  // @desc    Get list of all available system permissions
  fastify.get('/permissions', { preHandler: protect }, async (request, reply) => {
    const permissions = await prisma.permission.findMany();
    return {
      status: 'success',
      data: permissions.map(p => ({
        id: p.id,
        resource: p.resource,
        action: p.action,
        description: p.description
      }))
    };
  });

  // @route   GET /api/roles
  // @desc    Get list of available roles (System roles + tenant roles)
  fastify.get('/', { preHandler: protect }, async (request, reply) => {
    const tenantId = request.user!.tenantId;
    const isSuperAdmin = request.user!.role === 'super_admin';

    const roles = await prisma.role.findMany({
      where: {
        OR: [
          { isSystem: true }, // Built-in system roles
          ...(tenantId && !isSuperAdmin ? [{ tenantId }] : []), // Tenant-specific roles
          ...(isSuperAdmin ? [{ tenantId: { not: null } }] : []) // Super Admins can see all
        ]
      },
      include: {
        RolePermission: {
          include: { Permission: true }
        }
      }
    });

    return {
      status: 'success',
      data: roles.map(role => ({
        id: role.id,
        name: role.name,
        description: role.description,
        isSystem: role.isSystem,
        tenantId: role.tenantId,
        permissions: role.RolePermission.map(rp => `${rp.Permission.resource}:${rp.Permission.action}`)
      }))
    };
  });

  // @route   POST /api/roles
  // @desc    Create a custom tenant role
  fastify.post('/', { preHandler: [protect, restrictTo('roles', 'manage')] }, async (request, reply) => {
    const { name, description, permissions } = request.body as any;
    const isSuperAdmin = request.user!.role === 'super_admin';
    const tenantId = isSuperAdmin ? (request.body as any).tenantId : request.user!.tenantId;

    if (!name) {
      throw new AppError('Role name is required.', 400);
    }

    if (!isSuperAdmin && !tenantId) {
      throw new AppError('Managers can only create tenant-scoped custom roles.', 403);
    }

    // Verify role name collision
    const existing = await prisma.role.findFirst({
      where: { name, tenantId }
    });
    if (existing) {
      throw new AppError('A role with this name already exists in the scope.', 400);
    }

    // Pre-resolve permissions if supplied
    let targetPerms: { id: string }[] = [];
    if (permissions && Array.isArray(permissions) && permissions.length > 0) {
      targetPerms = await prisma.permission.findMany({
        where: {
          OR: permissions.map((permKey: string) => {
            const [resource, action] = permKey.split(':');
            return { resource, action };
          })
        },
        select: { id: true }
      });
    }

    const createdRole = await prisma.$transaction(async (tx) => {
      // 1. Create Role
      const role = await tx.role.create({
        data: {
          name,
          description,
          tenantId,
          isSystem: false,
          updatedAt: new Date()
        }
      });

      // 2. Bind Permissions in bulk
      if (targetPerms.length > 0) {
        await tx.rolePermission.createMany({
          data: targetPerms.map(p => ({
            roleId: role.id,
            permissionId: p.id
          })),
          skipDuplicates: true
        });
      }

      return role;
    });

    // Log action
    request.auditLog = {
      action: 'CREATE_ROLE',
      resourceType: 'Role',
      resourceId: createdRole.id,
      details: { name, tenantId }
    };

    reply.status(201);
    return {
      status: 'success',
      data: createdRole
    };
  });

  // @route   PUT /api/roles/:id/permissions
  // @desc    Update permissions mapping on a custom role
  fastify.put('/:id/permissions', { preHandler: [protect, restrictTo('roles', 'manage')] }, async (request, reply) => {
    const roleId = (request.params as any).id;
    const { permissions } = request.body as any;
    const isSuperAdmin = request.user!.role === 'super_admin';

    if (!permissions || !Array.isArray(permissions)) {
      throw new AppError('Permissions array is required.', 400);
    }

    const role = await prisma.role.findUnique({ where: { id: roleId } });
    if (!role) {
      throw new AppError('Role not found.', 404);
    }

    // Prevent modifying system built-in roles unless super admin
    if (role.isSystem && !isSuperAdmin) {
      throw new AppError('Built-in system roles cannot be modified.', 403);
    }

    // Verify tenant boundaries
    if (!isSuperAdmin && role.tenantId !== request.user!.tenantId) {
      throw new AppError('You do not have permission to modify roles outside your tenant.', 403);
    }

    // 1. Resolve all target permissions in a single query
    const targetPerms = permissions.length > 0 ? await prisma.permission.findMany({
      where: {
        OR: permissions.map((permKey: string) => {
          const [resource, action] = permKey.split(':');
          return { resource, action };
        })
      },
      select: { id: true }
    }) : [];

    await prisma.$transaction(async (tx) => {
      // 2. Delete all existing mappings for the role
      await tx.rolePermission.deleteMany({ where: { roleId } });

      // 3. Create new mappings in bulk
      if (targetPerms.length > 0) {
        await tx.rolePermission.createMany({
          data: targetPerms.map(p => ({
            roleId,
            permissionId: p.id
          })),
          skipDuplicates: true
        });
      }
    });

    // Log update
    request.auditLog = {
      action: 'UPDATE_ROLE_PERMISSIONS',
      resourceType: 'Role',
      resourceId: role.id,
      details: { permissions }
    };

    return {
      status: 'success',
      message: 'Role permissions updated successfully.'
    };
  });

  // @route   GET /api/roles/users
  // @desc    Get list of all users in the tenant
  fastify.get('/users', { preHandler: protect }, async (request, reply) => {
    const tenantId = request.user!.tenantId;
    const isSuperAdmin = request.user!.role === 'super_admin';

    const users = await prisma.user.findMany({
      where: {
        ...(tenantId && !isSuperAdmin ? { tenantId } : {})
      },
      select: {
        id: true,
        name: true,
        email: true,
        role: true
      }
    });

    return {
      status: 'success',
      data: users
    };
  });

  // @route   POST /api/roles/users/:id/assign
  // @desc    Assign a role to a user
  fastify.post('/users/:id/assign', { preHandler: [protect, restrictTo('team', 'manage')] }, async (request, reply) => {
    const userId = parseInt((request.params as any).id);
    const { roleId } = request.body as any;
    const isSuperAdmin = request.user!.role === 'super_admin';

    if (isNaN(userId)) {
      throw new AppError('Invalid User ID.', 400);
    }

    if (!roleId) {
      throw new AppError('Role ID is required.', 400);
    }

    // Verify target user exists
    const targetUser = await prisma.user.findUnique({ where: { id: userId } });
    if (!targetUser) {
      throw new AppError('User not found.', 404);
    }

    // Verify tenant boundary for user
    if (!isSuperAdmin && targetUser.tenantId !== request.user!.tenantId) {
      throw new AppError('You cannot modify users outside your tenant.', 403);
    }

    // Verify target role exists
    const targetRole = await prisma.role.findUnique({ where: { id: roleId } });
    if (!targetRole) {
      throw new AppError('Role not found.', 404);
    }

    // Verify tenant boundary for role
    if (!isSuperAdmin && targetRole.tenantId && targetRole.tenantId !== request.user!.tenantId) {
      throw new AppError('You cannot assign roles belonging to other tenants.', 403);
    }

    await prisma.$transaction(async (tx) => {
      // 1. Delete existing roles
      await tx.userRole.deleteMany({
        where: { userId }
      });

      // 2. Assign new user role mapping
      await tx.userRole.create({
        data: {
          userId,
          roleId,
          tenantId: targetUser.tenantId
        }
      });

      // 3. Update legacy User.role column for compatibility
      await tx.user.update({
        where: { id: userId },
        data: { role: targetRole.name }
      });
    });

    // Log assignment
    request.auditLog = {
      action: 'ASSIGN_ROLE',
      resourceType: 'User',
      resourceId: userId.toString(),
      details: { roleId, roleName: targetRole.name }
    };

    return {
      status: 'success',
      message: `Role '${targetRole.name}' assigned to user successfully.`
    };
  });
}
