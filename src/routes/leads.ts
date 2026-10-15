import { FastifyInstance, FastifyPluginOptions } from 'fastify';
import prisma from '../lib/prisma';
import { protect } from '../middleware/auth';
import { parsePagination, formatPaginatedResponse } from '../utils/pagination';
import { AppError } from '../middleware/error';
import { applyTenantScope } from '../utils/tenantScope';

export default async function leadsRoutes(fastify: FastifyInstance, options: FastifyPluginOptions) {

  // @route   GET /api/leads/interested
  // @desc    Get paginated list of Interested Clients for the authenticated tenant (or all for super_admin)
  fastify.get('/interested', { preHandler: [protect] }, async (request, reply) => {
    const user = request.user!;
    const query = (request.query as any) || {};

    const { page, limit, skip, sortBy, sortOrder, search } = parsePagination(request, 'createdAt', 'desc');

    const whereCondition: any = { isDeleted: false };

    // Optional query-based tenant filter (for super_admin or group narrowing)
    if (query.tenantId && query.tenantId !== 'all') {
      whereCondition.tenantId = query.tenantId;
    } else if (query.slug && query.slug !== 'all') {
      const t = await prisma.tenant.findFirst({ where: { slug: query.slug } });
      if (t) whereCondition.tenantId = t.id;
    }

    // Field-specific filtering
    if (query.client) {
      whereCondition.OR = [
        { name: { contains: query.client, mode: 'insensitive' } },
        { email: { contains: query.client, mode: 'insensitive' } },
        { phone: { contains: query.client, mode: 'insensitive' } },
      ];
    }

    if (query.message) {
      whereCondition.message = { contains: query.message, mode: 'insensitive' };
    }

    if (query.ip) {
      whereCondition.OR = [
        { ipAddress: { contains: query.ip, mode: 'insensitive' } },
        { VisitorSession: { channel: { contains: query.ip, mode: 'insensitive' } } },
      ];
    }

    if (query.status) {
      const statusLower = query.status.toLowerCase().trim();
      if (statusLower === 'qualified' || statusLower === 'qual') {
        whereCondition.PotentialClient = { isNot: null, isDeleted: false };
      } else if (statusLower === 'unqualified' || statusLower === 'in review' || statusLower === 'unqual') {
        whereCondition.OR = [
          { PotentialClient: null },
          { PotentialClient: { isDeleted: true } }
        ];
      } else if (!isNaN(parseInt(statusLower, 10))) {
        whereCondition.PotentialClient = {
          isDeleted: false,
          confidenceScore: { gte: parseInt(statusLower, 10) }
        };
      } else {
        whereCondition.PotentialClient = {
          isDeleted: false,
          summary: { contains: query.status, mode: 'insensitive' }
        };
      }
    }

    if (query.startDate || query.endDate) {
      whereCondition.createdAt = {};
      if (query.startDate) {
        whereCondition.createdAt.gte = new Date(query.startDate);
      }
      if (query.endDate) {
        const end = new Date(query.endDate);
        if (query.endDate.length <= 10) {
          end.setHours(23, 59, 59, 999);
        }
        whereCondition.createdAt.lte = end;
      }
    }

    if (search && !query.client && !query.message && !query.ip && !query.status) {
      whereCondition.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { email: { contains: search, mode: 'insensitive' } },
        { phone: { contains: search, mode: 'insensitive' } },
        { message: { contains: search, mode: 'insensitive' } },
        { ipAddress: { contains: search, mode: 'insensitive' } },
      ];
    }

    const scopedWhere = applyTenantScope(whereCondition, user);

    const [total, items] = await Promise.all([
      prisma.interestedClient.count({ where: scopedWhere }),
      prisma.interestedClient.findMany({
        where: scopedWhere,
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
              isDeleted: true,
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

    const sanitizedItems = items.map(item => ({
      ...item,
      PotentialClient: item.PotentialClient?.isDeleted ? null : item.PotentialClient
    }));

    return formatPaginatedResponse(sanitizedItems, total, { page, limit });
  });

  // @route   GET /api/leads/potential
  // @desc    Get paginated list of Potential Clients (AI Qualified) for tenant (or all for super_admin)
  fastify.get('/potential', { preHandler: [protect] }, async (request, reply) => {
    const user = request.user!;
    const query = (request.query as any) || {};

    const { page, limit, skip, sortBy, sortOrder, search } = parsePagination(request, 'confidenceScore', 'desc');

    const whereCondition: any = { isDeleted: false };

    // Optional query-based tenant filter (for super_admin or group narrowing)
    if (query.tenantId && query.tenantId !== 'all') {
      whereCondition.tenantId = query.tenantId;
    } else if (query.slug && query.slug !== 'all') {
      const t = await prisma.tenant.findFirst({ where: { slug: query.slug } });
      if (t) whereCondition.tenantId = t.id;
    }

    // Base InterestedClient filter to ensure parent isn't soft-deleted
    whereCondition.InterestedClient = { isDeleted: false };

    // Field-specific filtering for potential leads
    if (query.client) {
      whereCondition.InterestedClient.OR = [
        { name: { contains: query.client, mode: 'insensitive' } },
        { email: { contains: query.client, mode: 'insensitive' } },
        { phone: { contains: query.client, mode: 'insensitive' } },
      ];
    }

    if (query.message) {
      whereCondition.InterestedClient.message = { contains: query.message, mode: 'insensitive' };
    }

    if (query.ip) {
      whereCondition.InterestedClient.OR = [
        { ipAddress: { contains: query.ip, mode: 'insensitive' } },
        { VisitorSession: { channel: { contains: query.ip, mode: 'insensitive' } } },
      ];
    }

    if (query.status) {
      const statusLower = query.status.toLowerCase().trim();
      if (statusLower === 'high' || statusLower === 'high intent') {
        whereCondition.confidenceScore = { gte: 80 };
      } else if (statusLower === 'moderate' || statusLower === 'moderate intent') {
        whereCondition.confidenceScore = { gte: 65, lt: 80 };
      } else if (statusLower === 'warm' || statusLower === 'warm lead') {
        whereCondition.confidenceScore = { lt: 65 };
      } else if (!isNaN(parseInt(statusLower, 10))) {
        whereCondition.confidenceScore = { gte: parseInt(statusLower, 10) };
      } else {
        whereCondition.OR = [
          { summary: { contains: query.status, mode: 'insensitive' } },
          { reasoning: { contains: query.status, mode: 'insensitive' } }
        ];
      }
    }

    if (query.startDate || query.endDate) {
      whereCondition.createdAt = {};
      if (query.startDate) {
        whereCondition.createdAt.gte = new Date(query.startDate);
      }
      if (query.endDate) {
        const end = new Date(query.endDate);
        if (query.endDate.length <= 10) {
          end.setHours(23, 59, 59, 999);
        }
        whereCondition.createdAt.lte = end;
      }
    }

    if (search && !query.client && !query.message && !query.ip && !query.status) {
      whereCondition.OR = [
        { summary: { contains: search, mode: 'insensitive' } },
        { reasoning: { contains: search, mode: 'insensitive' } },
        { InterestedClient: { isDeleted: false, name: { contains: search, mode: 'insensitive' } } },
        { InterestedClient: { isDeleted: false, email: { contains: search, mode: 'insensitive' } } },
        { InterestedClient: { isDeleted: false, phone: { contains: search, mode: 'insensitive' } } },
      ];
    }

    const scopedWhere = applyTenantScope(whereCondition, user);

    const [total, items] = await Promise.all([
      prisma.potentialClient.count({ where: scopedWhere }),
      prisma.potentialClient.findMany({
        where: scopedWhere,
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

    const { id } = request.params as { id: string };
    const clientId = parseInt(id, 10);

    if (isNaN(clientId)) {
      throw new AppError('Invalid client ID', 400);
    }

    const scopedWhere = applyTenantScope({ id: clientId, isDeleted: false }, user);

    const client = await prisma.interestedClient.findFirst({
      where: scopedWhere,
      include: {
        PotentialClient: true,
        VisitorSession: true,
      }
    });

    if (!client) {
      throw new AppError('Client not found', 404);
    }

    // Hide PotentialClient if soft-deleted
    if (client.PotentialClient?.isDeleted) {
      (client as any).PotentialClient = null;
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
  // @desc    Soft delete an Interested Client and cascade to associated PotentialClient
  fastify.delete('/interested/:id', { preHandler: [protect] }, async (request, reply) => {
    const user = request.user!;
    const { id } = request.params as { id: string };
    const clientId = parseInt(id, 10);

    if (isNaN(clientId)) {
      throw new AppError('Invalid client ID', 400);
    }

    const scopedWhere = applyTenantScope({ id: clientId, isDeleted: false }, user);

    const existing = await prisma.interestedClient.findFirst({
      where: scopedWhere
    });

    if (!existing) {
      throw new AppError('Client record not found or access denied', 404);
    }

    await prisma.$transaction(async (tx) => {
      // Soft-delete associated PotentialClient
      await tx.potentialClient.updateMany({
        where: { interestedClientId: clientId, isDeleted: false },
        data: { isDeleted: true }
      });

      // Soft-delete the InterestedClient record
      await tx.interestedClient.update({
        where: { id: clientId },
        data: { isDeleted: true }
      });
    });

    return {
      status: 'success',
      message: 'Interested client removed successfully',
      data: { id: clientId }
    };
  });

  // @route   DELETE /api/leads/potential/:id
  // @desc    Soft delete a Potential Client qualification record
  fastify.delete('/potential/:id', { preHandler: [protect] }, async (request, reply) => {
    const user = request.user!;
    const { id } = request.params as { id: string };
    const potentialClientId = parseInt(id, 10);

    if (isNaN(potentialClientId)) {
      throw new AppError('Invalid potential client ID', 400);
    }

    const scopedWhere = applyTenantScope({ id: potentialClientId, isDeleted: false }, user);

    const existing = await prisma.potentialClient.findFirst({
      where: scopedWhere
    });

    if (!existing) {
      throw new AppError('Potential client record not found or access denied', 404);
    }

    await prisma.potentialClient.update({
      where: { id: potentialClientId },
      data: { isDeleted: true }
    });

    return {
      status: 'success',
      message: 'Potential client qualification removed successfully',
      data: { id: potentialClientId }
    };
  });
}
