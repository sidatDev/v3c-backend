import { FastifyInstance, FastifyPluginOptions } from 'fastify';
import prisma from '../lib/prisma';
import { protect } from '../middleware/auth';
import { parsePagination, formatPaginatedResponse } from '../utils/pagination';
import { AppError } from '../middleware/error';

export default async function leadsRoutes(fastify: FastifyInstance, options: FastifyPluginOptions) {

  // @route   GET /api/leads/interested
  // @desc    Get paginated list of Interested Clients for the authenticated tenant (or all for super_admin)
  fastify.get('/interested', { preHandler: [protect] }, async (request, reply) => {
    const user = request.user!;
    const isSuperAdmin = user.role === 'super_admin';
    const query = (request.query as any) || {};

    const { page, limit, skip, sortBy, sortOrder, search } = parsePagination(request, 'createdAt', 'desc');

    const whereCondition: any = {};

    // Filter by tenant unless super_admin with no specific tenant filter
    if (!isSuperAdmin) {
      if (query.slug && query.slug !== 'all') {
        const t = await prisma.tenant.findFirst({ where: { slug: query.slug } });
        if (t) {
          whereCondition.tenantId = t.id;
        } else if (user.tenantId) {
          whereCondition.tenantId = user.tenantId;
        }
      } else if (user.tenantId) {
        whereCondition.tenantId = user.tenantId;
      } else {
        return formatPaginatedResponse([], 0, { page: 1, limit: 10 });
      }
    } else if (query.tenantId && query.tenantId !== 'all') {
      whereCondition.tenantId = query.tenantId;
    } else if (query.slug && query.slug !== 'all') {
      const t = await prisma.tenant.findFirst({ where: { slug: query.slug } });
      if (t) whereCondition.tenantId = t.id;
    }

    if (search) {
      whereCondition.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { email: { contains: search, mode: 'insensitive' } },
        { phone: { contains: search, mode: 'insensitive' } },
        { message: { contains: search, mode: 'insensitive' } },
        { ipAddress: { contains: search, mode: 'insensitive' } },
      ];
    }

    const [total, items] = await Promise.all([
      prisma.interestedClient.count({ where: whereCondition }),
      prisma.interestedClient.findMany({
        where: whereCondition,
        skip,
        take: limit,
        orderBy: { [sortBy]: sortOrder },
        include: {
          PotentialClient: {
            select: {
              id: true,
              confidenceScore: true,
              summary: true,
              evaluatedAt: true,
            }
          },
          VisitorSession: {
            select: {
              id: true,
              channel: true,
              startedAt: true,
              endedAt: true,
            }
          },
          _count: {
            select: { Conversation: true }
          }
        }
      })
    ]);

    return formatPaginatedResponse(items, total, { page, limit });
  });

  // @route   GET /api/leads/potential
  // @desc    Get paginated list of Potential Clients (AI Qualified) for tenant (or all for super_admin)
  fastify.get('/potential', { preHandler: [protect] }, async (request, reply) => {
    const user = request.user!;
    const isSuperAdmin = user.role === 'super_admin';
    const query = (request.query as any) || {};

    const { page, limit, skip, sortBy, sortOrder, search } = parsePagination(request, 'confidenceScore', 'desc');

    const whereCondition: any = {};

    if (!isSuperAdmin) {
      if (query.slug && query.slug !== 'all') {
        const t = await prisma.tenant.findFirst({ where: { slug: query.slug } });
        if (t) {
          whereCondition.tenantId = t.id;
        } else if (user.tenantId) {
          whereCondition.tenantId = user.tenantId;
        }
      } else if (user.tenantId) {
        whereCondition.tenantId = user.tenantId;
      } else {
        return formatPaginatedResponse([], 0, { page: 1, limit: 10 });
      }
    } else if (query.tenantId && query.tenantId !== 'all') {
      whereCondition.tenantId = query.tenantId;
    } else if (query.slug && query.slug !== 'all') {
      const t = await prisma.tenant.findFirst({ where: { slug: query.slug } });
      if (t) whereCondition.tenantId = t.id;
    }

    if (search) {
      whereCondition.OR = [
        { summary: { contains: search, mode: 'insensitive' } },
        { reasoning: { contains: search, mode: 'insensitive' } },
        { InterestedClient: { name: { contains: search, mode: 'insensitive' } } },
        { InterestedClient: { email: { contains: search, mode: 'insensitive' } } },
        { InterestedClient: { phone: { contains: search, mode: 'insensitive' } } },
      ];
    }

    const [total, items] = await Promise.all([
      prisma.potentialClient.count({ where: whereCondition }),
      prisma.potentialClient.findMany({
        where: whereCondition,
        skip,
        take: limit,
        orderBy: { [sortBy]: sortOrder },
        include: {
          InterestedClient: {
            include: {
              VisitorSession: {
                select: {
                  id: true,
                  channel: true,
                  startedAt: true,
                  endedAt: true,
                }
              },
              _count: {
                select: { Conversation: true }
              }
            }
          }
        }
      })
    ]);

    return formatPaginatedResponse(items, total, { page, limit });
  });

  // @route   GET /api/leads/:id/conversations
  // @desc    Get full chat history transcript for an Interested Client
  fastify.get('/:id/conversations', { preHandler: [protect] }, async (request, reply) => {
    const user = request.user!;
    const isSuperAdmin = user.role === 'super_admin';

    const { id } = request.params as { id: string };
    const clientId = parseInt(id, 10);

    if (isNaN(clientId)) {
      throw new AppError('Invalid client ID', 400);
    }

    const client = await prisma.interestedClient.findFirst({
      where: isSuperAdmin ? { id: clientId } : { id: clientId, ...(user.tenantId ? { tenantId: user.tenantId } : {}) },
      include: {
        PotentialClient: true,
        VisitorSession: true,
      }
    });

    if (!client) {
      throw new AppError('Client not found', 404);
    }

    // Query messages linked directly to interestedClientId OR through visitorSessionId
    const messages = await prisma.conversation.findMany({
      where: {
        OR: [
          { interestedClientId: client.id },
          ...(client.visitorSessionId ? [{ visitorSessionId: client.visitorSessionId }] : [])
        ]
      },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        sender: true,
        message: true,
        createdAt: true,
      }
    });

    return {
      status: 'success',
      data: {
        client,
        conversations: messages
      }
    };
  });

  // @route   DELETE /api/leads/interested/:id
  // @desc    Delete an Interested Client and its associated PotentialClient qualification
  fastify.delete('/interested/:id', { preHandler: [protect] }, async (request, reply) => {
    const user = request.user!;
    const isSuperAdmin = user.role === 'super_admin';
    const { id } = request.params as { id: string };
    const clientId = parseInt(id, 10);

    if (isNaN(clientId)) {
      throw new AppError('Invalid client ID', 400);
    }

    const whereCondition: any = { id: clientId };
    if (!isSuperAdmin) {
      if (!user.tenantId) {
        throw new AppError('Tenant unauthorized', 403);
      }
      whereCondition.tenantId = user.tenantId;
    }

    const existing = await prisma.interestedClient.findFirst({
      where: whereCondition
    });

    if (!existing) {
      throw new AppError('Client record not found or access denied', 404);
    }

    await prisma.$transaction(async (tx) => {
      // Unlink conversations so no foreign key constraint prevents deletion
      await tx.conversation.updateMany({
        where: { interestedClientId: clientId },
        data: { interestedClientId: null }
      });

      // Delete associated PotentialClient
      await tx.potentialClient.deleteMany({
        where: { interestedClientId: clientId }
      });

      // Delete the InterestedClient record
      await tx.interestedClient.delete({
        where: { id: clientId }
      });
    });

    return {
      status: 'success',
      message: 'Interested client removed successfully',
      data: { id: clientId }
    };
  });

  // @route   DELETE /api/leads/potential/:id
  // @desc    Delete a Potential Client qualification record
  fastify.delete('/potential/:id', { preHandler: [protect] }, async (request, reply) => {
    const user = request.user!;
    const isSuperAdmin = user.role === 'super_admin';
    const { id } = request.params as { id: string };
    const potentialClientId = parseInt(id, 10);

    if (isNaN(potentialClientId)) {
      throw new AppError('Invalid potential client ID', 400);
    }

    const whereCondition: any = { id: potentialClientId };
    if (!isSuperAdmin) {
      if (!user.tenantId) {
        throw new AppError('Tenant unauthorized', 403);
      }
      whereCondition.tenantId = user.tenantId;
    }

    const existing = await prisma.potentialClient.findFirst({
      where: whereCondition
    });

    if (!existing) {
      throw new AppError('Potential client record not found or access denied', 404);
    }

    await prisma.potentialClient.delete({
      where: { id: potentialClientId }
    });

    return {
      status: 'success',
      message: 'Potential client qualification removed successfully',
      data: { id: potentialClientId }
    };
  });
}
