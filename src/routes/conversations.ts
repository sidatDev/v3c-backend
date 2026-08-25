import { FastifyInstance, FastifyPluginOptions } from 'fastify';
import prisma from '../lib/prisma';
import { protect } from '../middleware/auth';
import { restrictTo } from '../middleware/rbac';
import { parsePagination, formatPaginatedResponse } from '../utils/pagination';
import { AppError } from '../middleware/error';

export default async function conversationsRoutes(fastify: FastifyInstance, options: FastifyPluginOptions) {

  // @route   GET /api/conversations
  // @desc    Get paginated list of aggregated visitor sessions for tenant
  fastify.get('/', { preHandler: [protect, restrictTo('conversations', 'view')] }, async (request, reply) => {
    const tenantId = request.user!.tenantId;
    if (!tenantId) {
      return formatPaginatedResponse([], 0, { page: 1, limit: 10 });
    }

    const { page, limit, skip, sortBy, sortOrder, search } = parsePagination(request, 'createdAt', 'desc');
    const query = (request.query as any) || {};
    const { period, startDate, endDate, channel } = query;

    const whereCondition: any = {
      tenantId,
      // Only include sessions that have exchanged messages
      Conversation: { some: {} }
    };

    if (search) {
      whereCondition.OR = [
        { Lead: { some: { name: { contains: search, mode: 'insensitive' } } } },
        { Lead: { some: { email: { contains: search, mode: 'insensitive' } } } },
        { Conversation: { some: { message: { contains: search, mode: 'insensitive' } } } },
      ];
    }

    if (channel && (channel === 'chat' || channel === 'voice')) {
      whereCondition.channel = channel;
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

    const [sessions, total] = await Promise.all([
      prisma.visitorSession.findMany({
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
          Conversation: {
            take: 1,
            orderBy: { createdAt: 'desc' },
            select: { id: true, message: true, createdAt: true, sender: true }
          }
        }
      }),
      prisma.visitorSession.count({ where: whereCondition })
    ]);

    // Map sessions to formatted conversation items
    const conversations = sessions.map(session => {
      const latestMsg = session.Conversation[0];
      const primaryLead = session.Lead[0] || null;

      return {
        id: session.id,
        message: latestMsg?.message || 'No messages',
        sender: latestMsg?.sender || 'visitor',
        createdAt: latestMsg?.createdAt || session.createdAt,
        Lead: primaryLead,
        Agent: session.Agent || null,
        VisitorSession: {
          id: session.id,
          channel: session.channel || 'chat',
          referrer: session.referrer,
          landingPage: session.landingPage,
          startedAt: session.startedAt,
          status: session.status,
          ipAddress: session.ipAddress
        }
      };
    });

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

    const whereCondition: any = {
      tenantId,
      Conversation: { some: {} }
    };

    if (channel && (channel === 'chat' || channel === 'voice')) {
      whereCondition.channel = channel;
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

    const [sessions, aiLogs] = await Promise.all([
      prisma.visitorSession.findMany({
        where: whereCondition,
        orderBy: { createdAt: 'desc' },
        take: 5000,
        include: {
          Lead: { select: { name: true, email: true } },
          Agent: { select: { name: true } },
          Conversation: {
            take: 1,
            orderBy: { createdAt: 'desc' },
            select: { message: true, sender: true }
          }
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
      'Session ID',
      'Timestamp',
      'Channel',
      'Latest Sender',
      'Lead Name',
      'Lead Email',
      'Agent',
      'Latest Message'
    ];

    const rows = sessions.map(s => [
      s.id,
      new Date(s.createdAt).toISOString(),
      `"${s.channel === 'voice' ? 'Realtime Voice' : 'Text Chat'}"`,
      `"${(s.Conversation[0]?.sender || 'visitor').replace(/"/g, '""')}"`,
      `"${(s.Lead[0]?.name || '').replace(/"/g, '""')}"`,
      `"${(s.Lead[0]?.email || '').replace(/"/g, '""')}"`,
      `"${(s.Agent?.name || '').replace(/"/g, '""')}"`,
      `"${(s.Conversation[0]?.message || '').replace(/"/g, '""').replace(/\n/g, ' ')}"`
    ]);

    const summaryHeader = `\n"--- BILLING & AUDITING USAGE SUMMARY ---"`;
    const summaryRows = [
      `Total Session Volume,${sessions.length}`,
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
  // @desc    Get single conversation/session detail with full transcript messages
  fastify.get('/:id', { preHandler: [protect, restrictTo('conversations', 'view')] }, async (request, reply) => {
    const tenantId = request.user!.tenantId;
    const paramId = parseInt((request.params as any).id);

    if (isNaN(paramId)) {
      throw new AppError('Invalid Conversation ID', 400);
    }

    // Try finding VisitorSession first by ID
    let session = await prisma.visitorSession.findUnique({
      where: { id: paramId },
      include: {
        Lead: true,
        Agent: true,
        Domain: true
      }
    });

    let conversation: any = null;

    if (session && (!tenantId || session.tenantId === tenantId)) {
      const latestConv = await prisma.conversation.findFirst({
        where: { visitorSessionId: session.id },
        orderBy: { createdAt: 'desc' },
        include: { Lead: true, Agent: true, Domain: true }
      });

      conversation = latestConv
        ? {
            ...latestConv,
            Agent: latestConv.Agent || session.Agent || null,
            Lead: latestConv.Lead || session.Lead[0] || null,
            VisitorSession: {
              id: session.id,
              channel: session.channel || 'chat',
              referrer: session.referrer,
              landingPage: session.landingPage,
              startedAt: session.startedAt,
              status: session.status,
              ipAddress: session.ipAddress
            }
          }
        : {
            id: session.id,
            message: 'Session started',
            sender: 'visitor',
            createdAt: session.createdAt,
            tenantId: session.tenantId,
            Lead: session.Lead[0] || null,
            Agent: session.Agent || null,
            VisitorSession: {
              id: session.id,
              channel: session.channel || 'chat',
              referrer: session.referrer,
              landingPage: session.landingPage,
              startedAt: session.startedAt,
              status: session.status,
              ipAddress: session.ipAddress
            }
          };
    } else {
      // Fallback: try finding Conversation record by ID
      conversation = await prisma.conversation.findUnique({
        where: { id: paramId },
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
      session = conversation.VisitorSession as any;
    }

    const visitorSessionId = session?.id || conversation.visitorSessionId;

    let transcriptMessages: any[] = [];
    if (visitorSessionId) {
      transcriptMessages = await prisma.conversation.findMany({
        where: {
          visitorSessionId,
          ...(tenantId ? { tenantId } : {})
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
    } else {
      transcriptMessages = [conversation];
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
  // @desc    Delete single session or conversation transcript
  fastify.delete('/:id', { preHandler: [protect, restrictTo('conversations', 'view')] }, async (request, reply) => {
    const tenantId = request.user!.tenantId;
    const paramId = parseInt((request.params as any).id);

    if (isNaN(paramId)) {
      throw new AppError('Invalid Conversation ID', 400);
    }

    // Try deleting VisitorSession and all its messages
    const session = await prisma.visitorSession.findUnique({
      where: { id: paramId }
    });

    if (session && (!tenantId || session.tenantId === tenantId)) {
      await prisma.conversation.deleteMany({
        where: { visitorSessionId: session.id }
      });
      await prisma.visitorSession.delete({
        where: { id: session.id }
      });
    } else {
      const conversation = await prisma.conversation.findUnique({
        where: { id: paramId }
      });

      if (!conversation || (tenantId && conversation.tenantId !== tenantId)) {
        throw new AppError('Conversation not found', 404);
      }

      if (conversation.visitorSessionId) {
        await prisma.conversation.deleteMany({
          where: {
            visitorSessionId: conversation.visitorSessionId,
            ...(tenantId ? { tenantId } : {})
          }
        });
        await prisma.visitorSession.delete({
          where: { id: conversation.visitorSessionId }
        }).catch(() => {});
      } else {
        await prisma.conversation.delete({
          where: { id: paramId }
        });
      }
    }

    return {
      status: 'success',
      message: 'Conversation deleted successfully'
    };
  });
}
