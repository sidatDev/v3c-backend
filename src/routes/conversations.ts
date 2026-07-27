import { FastifyInstance, FastifyPluginOptions } from 'fastify';
import prisma from '../lib/prisma';
import { protect } from '../middleware/auth';
import { restrictTo } from '../middleware/rbac';
import { parsePagination, formatPaginatedResponse } from '../utils/pagination';
import { AppError } from '../middleware/error';

export default async function conversationsRoutes(fastify: FastifyInstance, options: FastifyPluginOptions) {

  // @route   GET /api/conversations
  // @desc    Get paginated list of conversations for tenant
  fastify.get('/', { preHandler: [protect, restrictTo('conversations', 'view')] }, async (request, reply) => {
    const tenantId = request.user!.tenantId;
    if (!tenantId) {
      return formatPaginatedResponse([], 0, { page: 1, limit: 10 });
    }

    const { page, limit, skip, sortBy, sortOrder, search } = parsePagination(request, 'createdAt', 'desc');

    const whereCondition: any = { tenantId };

    if (search) {
      whereCondition.OR = [
        { message: { contains: search, mode: 'insensitive' } },
        { Lead: { name: { contains: search, mode: 'insensitive' } } },
        { Lead: { email: { contains: search, mode: 'insensitive' } } },
      ];
    }

    const [conversations, total] = await Promise.all([
      prisma.conversation.findMany({
        where: whereCondition,
        skip,
        take: limit,
        orderBy: { [sortBy]: sortOrder },
        include: {
          Lead: {
            select: { id: true, name: true, email: true, phone: true, status: true }
          },
          Agent: {
            select: { id: true, name: true }
          },
          VisitorSession: {
            select: { id: true, referrer: true, landingPage: true, startedAt: true, status: true, ipAddress: true }
          }
        }
      }),
      prisma.conversation.count({ where: whereCondition })
    ]);

    return formatPaginatedResponse(conversations, total, { page, limit });
  });

  // @route   GET /api/conversations/:id
  // @desc    Get single conversation detail with full transcript messages
  fastify.get('/:id', { preHandler: [protect, restrictTo('conversations', 'view')] }, async (request, reply) => {
    const tenantId = request.user!.tenantId;
    const conversationId = parseInt((request.params as any).id);

    if (isNaN(conversationId)) {
      throw new AppError('Invalid Conversation ID', 400);
    }

    const conversation = await prisma.conversation.findUnique({
      where: { id: conversationId },
      include: {
        Lead: true,
        Agent: true,
        Domain: true,
        Visitor: true,
        VisitorSession: true
      }
    });

    if (!conversation || (tenantId && conversation.tenantId !== tenantId)) {
      throw new AppError('Conversation not found', 404);
    }

    // Get all messages in the same visitor session or for the same lead
    let transcriptMessages: any[] = [conversation];
    if (conversation.visitorSessionId) {
      transcriptMessages = await prisma.conversation.findMany({
        where: {
          visitorSessionId: conversation.visitorSessionId,
          tenantId: conversation.tenantId
        },
        orderBy: { createdAt: 'asc' },
        include: {
          Lead: {
            select: { id: true, name: true, email: true }
          },
          Agent: {
            select: { id: true, name: true }
          }
        }
      });
    } else if (conversation.leadId) {
      transcriptMessages = await prisma.conversation.findMany({
        where: {
          leadId: conversation.leadId,
          tenantId: conversation.tenantId
        },
        orderBy: { createdAt: 'asc' },
        include: {
          Lead: {
            select: { id: true, name: true, email: true }
          },
          Agent: {
            select: { id: true, name: true }
          }
        }
      });
    }

    return {
      status: 'success',
      data: {
        conversation,
        transcript: transcriptMessages
      }
    };
  });

  // @route   DELETE /api/conversations/:id
  // @desc    Delete single conversation or entire session transcript
  fastify.delete('/:id', { preHandler: [protect, restrictTo('conversations', 'view')] }, async (request, reply) => {
    const tenantId = request.user!.tenantId;
    const conversationId = parseInt((request.params as any).id);

    if (isNaN(conversationId)) {
      throw new AppError('Invalid Conversation ID', 400);
    }

    const conversation = await prisma.conversation.findUnique({
      where: { id: conversationId }
    });

    if (!conversation || (tenantId && conversation.tenantId !== tenantId)) {
      throw new AppError('Conversation not found', 404);
    }

    if (conversation.visitorSessionId) {
      await prisma.conversation.deleteMany({
        where: {
          visitorSessionId: conversation.visitorSessionId,
          tenantId: conversation.tenantId
        }
      });
    } else {
      await prisma.conversation.delete({
        where: { id: conversationId }
      });
    }

    return {
      status: 'success',
      message: 'Conversation deleted successfully'
    };
  });
}
