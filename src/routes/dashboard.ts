import { FastifyInstance, FastifyPluginOptions } from 'fastify';
import prisma from '../lib/prisma';
import { protect } from '../middleware/auth';

export default async function dashboardRoutes(fastify: FastifyInstance, options: FastifyPluginOptions) {

  // @route   GET /api/dashboard/stats
  // @desc    Get dashboard metrics (conversations, active agents, leads, quota usage)
  fastify.get('/stats', { preHandler: protect }, async (request, reply) => {
    const tenantId = request.user!.tenantId;

    if (!tenantId) {
      return {
        status: 'success',
        data: {
          conversationsCount: 0,
          activeAgentsCount: 0,
          leadsCount: 0,
          subscription: null
        }
      };
    }

    // 1. Get counts from DB
    const [conversationsCount, activeAgentsCount, leadsCount] = await Promise.all([
      prisma.conversation.count({ where: { tenantId } }),
      prisma.agent.count({ where: { tenantId, isActive: true } }),
      prisma.lead.count({ where: { tenantId } })
    ]);

    // 2. Get active subscription plan profile
    const subscription = await prisma.adminProfile.findFirst({
      where: { tenantId },
      orderBy: { createdAt: 'desc' }
    });

    return {
      status: 'success',
      data: {
        conversationsCount,
        activeAgentsCount,
        leadsCount,
        subscription: subscription ? {
          packagePlan: subscription.packagePlan,
          price: subscription.price,
          nextBillingDate: subscription.nextBillingDate,
          conversationsIncluded: subscription.conversationsIncluded,
          conversationsUsed: subscription.conversationsUsed,
          leadsIncluded: subscription.leadsIncluded,
          leadsUsed: subscription.leadsUsed,
          storage: subscription.storage
        } : null
      }
    };
  });

  // @route   GET /api/dashboard/visitors
  // @desc    Get visitors count / daily conversations count over the last 30 days
  fastify.get('/visitors', { preHandler: protect }, async (request, reply) => {
    const tenantId = request.user!.tenantId;

    if (!tenantId) {
      return {
        status: 'success',
        data: []
      };
    }

    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    thirtyDaysAgo.setHours(0, 0, 0, 0);

    // Fetch conversation times for the past 30 days
    const conversations = await prisma.conversation.findMany({
      where: {
        tenantId,
        createdAt: {
          gte: thirtyDaysAgo
        }
      },
      select: {
        createdAt: true
      },
      orderBy: {
        createdAt: 'asc'
      }
    });

    // Post-process to group by date
    const dailyMap: { [dateStr: string]: number } = {};
    
    // Pre-populate last 30 days with 0 counts to ensure complete graph data
    for (let i = 0; i < 30; i++) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const dateStr = d.toISOString().split('T')[0];
      dailyMap[dateStr] = 0;
    }

    // Accumulate actual counts
    conversations.forEach((conv) => {
      const dateStr = conv.createdAt.toISOString().split('T')[0];
      // Only record inside past 30 days window
      if (dailyMap[dateStr] !== undefined) {
        dailyMap[dateStr]++;
      }
    });

    // Format as list of objects sorted chronologically
    const chartData = Object.entries(dailyMap)
      .map(([date, count]) => ({ date, count }))
      .sort((a, b) => a.date.localeCompare(b.date));

    return {
      status: 'success',
      data: chartData
    };
  });
}
