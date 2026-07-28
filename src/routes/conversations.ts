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
    const query = (request.query as any) || {};
    const { period, startDate, endDate, channel } = query;

    const whereCondition: any = { tenantId };

    if (search) {
      whereCondition.OR = [
        { message: { contains: search, mode: 'insensitive' } },
        { Lead: { name: { contains: search, mode: 'insensitive' } } },
        { Lead: { email: { contains: search, mode: 'insensitive' } } },
      ];
    }

    if (channel && (channel === 'chat' || channel === 'voice')) {
      whereCondition.VisitorSession = { channel };
    }

    const dateFilter: any = {};
    if (startDate || endDate) {
      if (startDate) dateFilter.gte = new Date(startDate);
      if (endDate) dateFilter.lte = new Date(endDate);
    } else if (period && period !== 'all') {
      let days = 30;
      if (period === '24h') days = 1;
      else if (period === '3d') days = 3;
      else if (period === '7d') days = 7;
      else if (period === '30d') days = 30;
      dateFilter.gte = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    }

    if (Object.keys(dateFilter).length > 0) {
      whereCondition.createdAt = dateFilter;
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
            select: { id: true, channel: true, referrer: true, landingPage: true, startedAt: true, status: true, ipAddress: true }
          }
        }
      }),
      prisma.conversation.count({ where: whereCondition })
    ]);

    return formatPaginatedResponse(conversations, total, { page, limit });
  });

  // @route   GET /api/conversations/export-csv
  // @desc    Export CSV usage report for tenant conversations with token & billing calculations
  fastify.get('/export-csv', { preHandler: [protect, restrictTo('conversations', 'view')] }, async (request, reply) => {
    const tenantId = request.user!.tenantId;
    if (!tenantId) {
      throw new AppError('Tenant not found', 400);
    }

    const query = (request.query as any) || {};
    const { period, startDate, endDate, channel } = query;

    const whereCondition: any = { tenantId };

    if (channel && (channel === 'chat' || channel === 'voice')) {
      whereCondition.VisitorSession = { channel };
    }

    const dateFilter: any = {};
    if (startDate || endDate) {
      if (startDate) dateFilter.gte = new Date(startDate);
      if (endDate) dateFilter.lte = new Date(endDate);
    } else if (period && period !== 'all') {
      let days = 30;
      if (period === '24h') days = 1;
      else if (period === '3d') days = 3;
      else if (period === '7d') days = 7;
      else if (period === '30d') days = 30;
      dateFilter.gte = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    }

    if (Object.keys(dateFilter).length > 0) {
      whereCondition.createdAt = dateFilter;
    }

    const [conversations, aiLogs] = await Promise.all([
      prisma.conversation.findMany({
        where: whereCondition,
        orderBy: { createdAt: 'desc' },
        take: 5000,
        include: {
          Lead: { select: { name: true, email: true } },
          Agent: { select: { name: true } },
          VisitorSession: { select: { channel: true } }
        }
      }),
      prisma.aiLog.findMany({
        where: { tenantId, ...(Object.keys(dateFilter).length > 0 ? { createdAt: dateFilter } : {}) },
        select: { promptTokens: true, completionTokens: true, estimatedCost: true }
      })
    ]);

    const totalPromptTokens = aiLogs.reduce((acc, l) => acc + (l.promptTokens || 0), 0);
    const totalCompletionTokens = aiLogs.reduce((acc, l) => acc + (l.completionTokens || 0), 0);
    const totalCost = aiLogs.reduce((acc, l) => acc + (l.estimatedCost || 0), 0);

    const headers = [
      'Conversation ID',
      'Timestamp',
      'Channel',
      'Sender',
      'Lead Name',
      'Lead Email',
      'Agent',
      'Message Preview'
    ];

    const rows = conversations.map(c => [
      c.id,
      new Date(c.createdAt).toISOString(),
      `"${c.VisitorSession?.channel === 'voice' ? 'Realtime Voice' : 'Text Chat'}"`,
      `"${(c.sender || '').replace(/"/g, '""')}"`,
      `"${(c.Lead?.name || '').replace(/"/g, '""')}"`,
      `"${(c.Lead?.email || '').replace(/"/g, '""')}"`,
      `"${(c.Agent?.name || '').replace(/"/g, '""')}"`,
      `"${(c.message || '').replace(/"/g, '""').replace(/\n/g, ' ')}"`
    ]);

    const summaryHeader = `\n"--- BILLING & AUDITING USAGE SUMMARY ---"`;
    const summaryRows = [
      `Total Session Volume,${conversations.length}`,
      `Total Telemetry Logs,${aiLogs.length}`,
      `Total Prompt Tokens,${totalPromptTokens}`,
      `Total Completion Tokens,${totalCompletionTokens}`,
      `Total Token Usage,${totalPromptTokens + totalCompletionTokens}`,
      `Total Cost Calculation (USD),$${totalCost.toFixed(6)}`
    ].join('\n');

    const csvContent = [headers.join(','), ...rows.map(r => r.join(',')), summaryHeader, summaryRows].join('\n');

    reply
      .header('Content-Type', 'text/csv')
      .header('Content-Disposition', `attachment; filename="v3c-conversations-usage-${new Date().toISOString().split('T')[0]}.csv"`)
      .send(csvContent);
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
