import { FastifyInstance, FastifyPluginOptions } from 'fastify';
import prisma from '../lib/prisma';
import { protect } from '../middleware/auth';
import { parsePagination, formatPaginatedResponse } from '../utils/pagination';
import { AppError } from '../middleware/error';

export default async function inboxRoutes(fastify: FastifyInstance, options: FastifyPluginOptions) {

  // @route   GET /api/inbox
  // @desc    Get CRM Conversation Inbox sessions with filtering & pagination
  fastify.get('/', { preHandler: protect }, async (request, reply) => {
    const tenantId = request.user!.tenantId;
    if (!tenantId) {
      return formatPaginatedResponse([], 0, { page: 1, limit: 10 });
    }

    const query = request.query as any;
    const { page, limit, skip, sortBy, sortOrder } = parsePagination(request, 'createdAt', 'desc');

    const whereCondition: any = { tenantId };

    if (query.status) {
      whereCondition.conversationStatus = query.status;
    }

    if (query.channel) {
      whereCondition.channel = query.channel;
    }

    if (query.agentId) {
      whereCondition.aiAgentId = query.agentId;
    }

    if (query.fallbackOnly === 'true') {
      whereCondition.fallbackTriggered = true;
    }

    if (query.search) {
      whereCondition.OR = [
        { Lead: { some: { name: { contains: query.search, mode: 'insensitive' } } } },
        { Conversation: { some: { message: { contains: query.search, mode: 'insensitive' } } } }
      ];
    }

    const [sessions, total] = await Promise.all([
      prisma.visitorSession.findMany({
        where: whereCondition,
        skip,
        take: limit,
        orderBy: { [sortBy]: sortOrder },
        include: {
          Agent: { select: { id: true, name: true, voice: true } },
          Lead: { select: { id: true, name: true, email: true, phone: true } },
          Conversation: {
            take: 1,
            orderBy: { createdAt: 'desc' },
            select: { message: true, createdAt: true, sender: true }
          }
        }
      }),
      prisma.visitorSession.count({ where: whereCondition })
    ]);

    return formatPaginatedResponse(sessions, total, { page, limit });
  });

  // @route   GET /api/inbox/:sessionId
  // @desc    Get detailed conversation session with full transcript & metadata
  fastify.get('/:sessionId', { preHandler: protect }, async (request, reply) => {
    const tenantId = request.user!.tenantId;
    const sessionId = parseInt((request.params as any).sessionId);

    if (isNaN(sessionId)) {
      throw new AppError('Invalid Session ID', 400);
    }

    const session = await prisma.visitorSession.findFirst({
      where: { id: sessionId, tenantId: tenantId || undefined },
      include: {
        Agent: true,
        Lead: true,
        Domain: true,
        User: { select: { id: true, name: true, email: true } },
        Conversation: {
          orderBy: { createdAt: 'asc' },
          include: {
            Lead: { select: { name: true } }
          }
        },
        AiLog: {
          orderBy: { createdAt: 'desc' },
          take: 10
        }
      }
    });

    if (!session) {
      throw new AppError('Conversation session not found', 404);
    }

    return {
      status: 'success',
      data: session
    };
  });

  // @route   PUT /api/inbox/:sessionId
  // @desc    Update session CRM attributes (status, tags, notes, assignment)
  fastify.put('/:sessionId', { preHandler: protect }, async (request, reply) => {
    const tenantId = request.user!.tenantId;
    const sessionId = parseInt((request.params as any).sessionId);
    const body = request.body as any;

    if (isNaN(sessionId)) {
      throw new AppError('Invalid Session ID', 400);
    }

    const session = await prisma.visitorSession.findFirst({
      where: { id: sessionId, tenantId: tenantId || undefined }
    });

    if (!session) {
      throw new AppError('Session not found', 404);
    }

    const updated = await prisma.visitorSession.update({
      where: { id: sessionId },
      data: {
        conversationStatus: body.status || session.conversationStatus,
        tags: body.tags || session.tags,
        humanNotes: body.humanNotes !== undefined ? body.humanNotes : session.humanNotes,
        assignedUserId: body.assignedUserId !== undefined ? body.assignedUserId : session.assignedUserId,
        escalated: body.escalated !== undefined ? Boolean(body.escalated) : session.escalated,
        updatedAt: new Date()
      }
    });

    return {
      status: 'success',
      data: updated
    };
  });
}
