import { FastifyInstance, FastifyPluginOptions } from 'fastify';
import bcrypt from 'bcrypt';
import prisma from '../lib/prisma';
import { protect } from '../middleware/auth';
import { restrictTo } from '../middleware/rbac';
import { AppError } from '../middleware/error';

export default async function teamRoutes(fastify: FastifyInstance, options: FastifyPluginOptions) {

  // @route   GET /api/team
  // @desc    Get list of team members in tenant
  fastify.get('/', { preHandler: [protect, restrictTo('team', 'view')] }, async (request, reply) => {
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
        phone: true,
        role: true,
        status: true,
        image: true,
        lastLogin: true,
        createdAt: true,
        domainId: true,
        UserRole: {
          include: {
            Role: true
          }
        }
      },
      orderBy: { createdAt: 'desc' }
    });

    const formatted = users.map(u => ({
      id: u.id,
      name: u.name,
      email: u.email,
      phone: u.phone,
      status: u.status,
      image: u.image,
      lastLogin: u.lastLogin,
      createdAt: u.createdAt,
      roleName: u.UserRole[0]?.Role.name || u.role,
      roleId: u.UserRole[0]?.roleId || null,
      domainId: u.domainId || null
    }));

    return { status: 'success', data: formatted };
  });

  // @route   POST /api/team
  // @desc    Invite / Add a new team member
  fastify.post('/', { preHandler: [protect, restrictTo('team', 'manage')] }, async (request, reply) => {
    const tenantId = request.user!.tenantId;
    const isSuperAdmin = request.user!.role === 'super_admin';
    const { name, email, password, roleId, phone, domainId } = request.body as any;

    if (!name || !email) {
      throw new AppError('Name and email are required.', 400);
    }

    const existingUser = await prisma.user.findUnique({ where: { email } });
    if (existingUser) {
      throw new AppError('A user with this email already exists.', 400);
    }

    const defaultPassword = password || 'V3cTeamUser2026!';
    const hashedPassword = await bcrypt.hash(defaultPassword, 10);

    // Verify assigned role if provided
    let targetRole = null;
    if (roleId) {
      targetRole = await prisma.role.findUnique({ where: { id: roleId } });
    }

    const roleName = targetRole?.name || 'member';

    const newUser = await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          name,
          email,
          password: hashedPassword,
          phone: phone || null,
          role: roleName,
          status: 'active',
          tenantId: tenantId || null,
          domainId: domainId ? parseInt(domainId, 10) : null,
          updatedAt: new Date()
        }
      });

      // Create TeamMember mapping record
      await tx.teamMember.create({
        data: {
          userId: user.id,
          role: roleName,
          status: 'active',
          tenantId: tenantId || null,
          domainId: domainId ? parseInt(domainId, 10) : null,
          updatedAt: new Date()
        }
      });

      // Bind UserRole if roleId provided
      if (targetRole) {
        await tx.userRole.create({
          data: {
            userId: user.id,
            roleId: targetRole.id,
            tenantId: tenantId || null
          }
        });
      }

      return user;
    });

    request.auditLog = {
      action: 'INVITE_TEAM_MEMBER',
      resourceType: 'User',
      resourceId: newUser.id.toString(),
      details: { email, role: roleName }
    };

    reply.status(201);
    return {
      status: 'success',
      data: {
        id: newUser.id,
        name: newUser.name,
        email: newUser.email,
        role: roleName,
        status: newUser.status
      }
    };
  });

  // @route   PUT /api/team/:id
  // @desc    Update team member (role or status)
  fastify.put('/:id', { preHandler: [protect, restrictTo('team', 'manage')] }, async (request, reply) => {
    const tenantId = request.user!.tenantId;
    const isSuperAdmin = request.user!.role === 'super_admin';
    const userId = parseInt((request.params as any).id);
    const { name, phone, roleId, status, domainId } = request.body as any;

    if (isNaN(userId)) throw new AppError('Invalid User ID', 400);

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user || (!isSuperAdmin && user.tenantId !== tenantId)) {
      throw new AppError('Team member not found', 404);
    }

    let roleName = user.role;
    if (roleId) {
      const targetRole = await prisma.role.findUnique({ where: { id: roleId } });
      if (targetRole) {
        roleName = targetRole.name;

        await prisma.userRole.deleteMany({ where: { userId } });
        await prisma.userRole.create({
          data: {
            userId,
            roleId: targetRole.id,
            tenantId: user.tenantId
          }
        });
      }
    }

    const updated = await prisma.user.update({
      where: { id: userId },
      data: {
        name: name || user.name,
        phone: phone !== undefined ? phone : user.phone,
        role: roleName,
        status: status || user.status,
        domainId: domainId !== undefined ? (domainId ? parseInt(domainId, 10) : null) : user.domainId,
        updatedAt: new Date()
      }
    });

    return { status: 'success', data: updated };
  });

  // @route   DELETE /api/team/:id
  // @desc    Remove / Disable a team member
  fastify.delete('/:id', { preHandler: [protect, restrictTo('team', 'manage')] }, async (request, reply) => {
    const tenantId = request.user!.tenantId;
    const isSuperAdmin = request.user!.role === 'super_admin';
    const userId = parseInt((request.params as any).id);

    if (isNaN(userId)) throw new AppError('Invalid User ID', 400);

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user || (!isSuperAdmin && user.tenantId !== tenantId)) {
      throw new AppError('Team member not found', 404);
    }

    // Disable instead of hard deleting to preserve audit trails
    await prisma.user.update({
      where: { id: userId },
      data: { status: 'disabled', updatedAt: new Date() }
    });

    return { status: 'success', message: 'Team member disabled successfully.' };
  });
}
