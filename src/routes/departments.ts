import { FastifyInstance, FastifyPluginOptions } from 'fastify';
import prisma from '../lib/prisma';
import { protect } from '../middleware/auth';
import { AppError } from '../middleware/error';
import { applyTenantScope, effectiveTenantId } from '../utils/tenantScope';
import { Status } from '@prisma/client';

export default async function departmentsRoutes(fastify: FastifyInstance, options: FastifyPluginOptions) {

  // @route   GET /api/departments
  // @desc    List departments scoped to user's tenant hierarchy
  fastify.get('/', { preHandler: protect }, async (request, reply) => {
    const user = request.user!;
    const roleLevel = user.roleLevel || (user.role === 'super_admin' ? 'L0_PLATFORM' : 'L4_AGENT');

    let baseWhere: any = {};

    // If L3 or L4, restrict to their specific department if assigned
    if (roleLevel === 'L3_DEPARTMENT' || roleLevel === 'L4_AGENT') {
      if (!user.departmentId) {
        return {
          status: 'success',
          data: []
        };
      }
      baseWhere.id = user.departmentId;
    }

    const scopedWhere = applyTenantScope(baseWhere, user);

    const departments = await prisma.department.findMany({
      where: scopedWhere,
      include: {
        Tenant: {
          select: {
            id: true,
            name: true,
            slug: true
          }
        },
        _count: {
          select: {
            users: true
          }
        }
      },
      orderBy: { createdAt: 'desc' }
    });

    return {
      status: 'success',
      data: departments
    };
  });

  // @route   POST /api/departments
  // @desc    Create a new department (L1/L2 admin privilege required)
  fastify.post('/', { preHandler: protect }, async (request, reply) => {
    const user = request.user!;
    const roleLevel = user.roleLevel || (user.role === 'super_admin' ? 'L0_PLATFORM' : 'L4_AGENT');

    // Only platform (L0), group (L1), and company (L2) admins can create departments
    const allowedLevels = ['L0_PLATFORM', 'L1_GROUP', 'L2_COMPANY'];
    if (!allowedLevels.includes(roleLevel) && user.role !== 'super_admin' && user.role !== 'manager') {
      throw new AppError('Access denied: Creating departments requires Company or Group Admin privileges', 403);
    }

    const { name, tenantId: requestedTenantId, status } = request.body as any;

    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      throw new AppError('Department name is required', 400);
    }

    // Determine target tenant ID
    let targetTenantId = effectiveTenantId(user);

    if (requestedTenantId && (roleLevel === 'L0_PLATFORM' || roleLevel === 'L1_GROUP')) {
      if (roleLevel === 'L1_GROUP' && user.groupId) {
        // Validate target tenant belongs to group
        const tenantInGroup = await prisma.tenant.findFirst({
          where: { id: requestedTenantId, groupId: user.groupId }
        });
        if (!tenantInGroup) {
          throw new AppError('Target company does not belong to your group', 403);
        }
      }
      targetTenantId = requestedTenantId;
    }

    if (!targetTenantId) {
      throw new AppError('Tenant ID missing for department creation', 400);
    }

    // Check name collision within the tenant
    const existing = await prisma.department.findFirst({
      where: {
        name: name.trim(),
        tenantId: targetTenantId
      }
    });

    if (existing) {
      throw new AppError('A department with this name already exists in the company', 400);
    }

    const departmentStatus = status === 'INACTIVE' ? Status.INACTIVE : Status.ACTIVE;

    const department = await prisma.department.create({
      data: {
        name: name.trim(),
        status: departmentStatus,
        tenantId: targetTenantId
      },
      include: {
        Tenant: {
          select: { id: true, name: true, slug: true }
        },
        _count: {
          select: { users: true }
        }
      }
    });

    reply.status(201);
    return {
      status: 'success',
      data: department
    };
  });

  // @route   PUT /api/departments/:id
  // @desc    Update department name or status
  fastify.put('/:id', { preHandler: protect }, async (request, reply) => {
    const user = request.user!;
    const roleLevel = user.roleLevel || (user.role === 'super_admin' ? 'L0_PLATFORM' : 'L4_AGENT');
    const { id } = request.params as any;

    const allowedLevels = ['L0_PLATFORM', 'L1_GROUP', 'L2_COMPANY', 'L3_DEPARTMENT'];
    if (!allowedLevels.includes(roleLevel) && user.role !== 'super_admin' && user.role !== 'manager') {
      throw new AppError('Access denied: Modifying departments requires Admin privileges', 403);
    }

    const existing = await prisma.department.findFirst({
      where: applyTenantScope({ id }, user)
    });

    if (!existing) {
      throw new AppError('Department not found or outside your accessible scope', 404);
    }

    const { name, status } = request.body as any;

    let updateData: any = {};
    if (name && typeof name === 'string' && name.trim().length > 0) {
      // Check collision
      const collision = await prisma.department.findFirst({
        where: {
          name: name.trim(),
          tenantId: existing.tenantId,
          NOT: { id: existing.id }
        }
      });
      if (collision) {
        throw new AppError('Another department with this name already exists in this company', 400);
      }
      updateData.name = name.trim();
    }

    if (status) {
      updateData.status = status === 'INACTIVE' ? Status.INACTIVE : Status.ACTIVE;
    }

    const updated = await prisma.department.update({
      where: { id },
      data: updateData,
      include: {
        Tenant: {
          select: { id: true, name: true, slug: true }
        },
        _count: {
          select: { users: true }
        }
      }
    });

    return {
      status: 'success',
      data: updated
    };
  });

  // @route   DELETE /api/departments/:id
  // @desc    Delete a department
  fastify.delete('/:id', { preHandler: protect }, async (request, reply) => {
    const user = request.user!;
    const roleLevel = user.roleLevel || (user.role === 'super_admin' ? 'L0_PLATFORM' : 'L4_AGENT');
    const { id } = request.params as any;

    const allowedLevels = ['L0_PLATFORM', 'L1_GROUP', 'L2_COMPANY'];
    if (!allowedLevels.includes(roleLevel) && user.role !== 'super_admin' && user.role !== 'manager') {
      throw new AppError('Access denied: Deleting departments requires Company or Group Admin privileges', 403);
    }

    const existing = await prisma.department.findFirst({
      where: applyTenantScope({ id }, user),
      include: {
        _count: {
          select: { users: true }
        }
      }
    });

    if (!existing) {
      throw new AppError('Department not found or outside your accessible scope', 404);
    }

    if (existing._count.users > 0) {
      throw new AppError('Cannot delete department with assigned team members. Please reassign members first.', 400);
    }

    await prisma.department.delete({
      where: { id }
    });

    return {
      status: 'success',
      message: 'Department deleted successfully'
    };
  });
}
