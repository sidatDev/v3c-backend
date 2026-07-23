import { FastifyInstance, FastifyPluginOptions } from 'fastify';
import prisma from '../lib/prisma';
import { protect } from '../middleware/auth';

export default async function analyticsRoutes(fastify: FastifyInstance, options: FastifyPluginOptions) {

  // @route   GET /api/analytics/overview
  // @desc    Get high-level platform analytics metrics
  fastify.get('/overview', { preHandler: protect }, async (request, reply) => {
    const tenantId = request.user!.tenantId;
    if (!tenantId) {
      return {
        status: 'success',
        data: {
          totalSessions: 0,
          chatSessions: 0,
          voiceSessions: 0,
          fallbackRate: 0,
          totalCost: 0,
          avgLatencyMs: 0
        }
      };
    }

    const [totalSessions, chatSessions, voiceSessions, fallbackLogsCount, totalLogsCount, costAggregate, latencyAggregate] = await Promise.all([
      prisma.visitorSession.count({ where: { tenantId } }),
      prisma.visitorSession.count({ where: { tenantId, channel: 'chat' } }),
      prisma.visitorSession.count({ where: { tenantId, channel: 'voice' } }),
      prisma.aiLog.count({ where: { tenantId, fallbackTriggered: true } }),
      prisma.aiLog.count({ where: { tenantId } }),
      prisma.aiLog.aggregate({ where: { tenantId }, _sum: { estimatedCost: true } }),
      prisma.aiLog.aggregate({ where: { tenantId }, _avg: { latencyMs: true } })
    ]);

    const fallbackRate = totalLogsCount > 0 ? Math.round((fallbackLogsCount / totalLogsCount) * 1000) / 10 : 0;
    const totalCost = costAggregate._sum.estimatedCost || 0;
    const avgLatencyMs = Math.round(latencyAggregate._avg.latencyMs || 0);

    return {
      status: 'success',
      data: {
        totalSessions,
        chatSessions,
        voiceSessions,
        fallbackRate,
        totalCost: Math.round(totalCost * 10000) / 10000,
        avgLatencyMs
      }
    };
  });

  // @route   GET /api/analytics/top-questions
  // @desc    Get top asked questions aggregated from AI logs
  fastify.get('/top-questions', { preHandler: protect }, async (request, reply) => {
    const tenantId = request.user!.tenantId;
    if (!tenantId) {
      return { status: 'success', data: [] };
    }

    const logs = await prisma.aiLog.findMany({
      where: { tenantId, userQuery: { not: null } },
      select: { userQuery: true, fallbackTriggered: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
      take: 100
    });

    const frequencyMap: { [query: string]: { count: number; fallbackCount: number } } = {};
    for (const log of logs) {
      if (!log.userQuery) continue;
      const q = log.userQuery.trim().toLowerCase();
      if (!frequencyMap[q]) {
        frequencyMap[q] = { count: 0, fallbackCount: 0 };
      }
      frequencyMap[q].count++;
      if (log.fallbackTriggered) {
        frequencyMap[q].fallbackCount++;
      }
    }

    const topQuestions = Object.entries(frequencyMap)
      .map(([query, stats]) => ({
        query,
        count: stats.count,
        fallbackCount: stats.fallbackCount
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    return {
      status: 'success',
      data: topQuestions
    };
  });

  // @route   GET /api/analytics/agents
  // @desc    Get per-agent performance analytics
  fastify.get('/agents', { preHandler: protect }, async (request, reply) => {
    const tenantId = request.user!.tenantId;
    if (!tenantId) {
      return { status: 'success', data: [] };
    }

    const agents = await prisma.agent.findMany({
      where: { tenantId },
      select: { id: true, name: true, voice: true, isActive: true }
    });

    const agentStats = await Promise.all(agents.map(async (agent) => {
      const [sessionCount, logStats] = await Promise.all([
        prisma.visitorSession.count({ where: { tenantId, aiAgentId: agent.id } }),
        prisma.aiLog.aggregate({
          where: { tenantId, agentId: agent.id },
          _avg: { latencyMs: true },
          _sum: { estimatedCost: true, promptTokens: true, completionTokens: true }
        })
      ]);

      return {
        id: agent.id,
        name: agent.name,
        voice: agent.voice,
        isActive: agent.isActive,
        sessionCount,
        avgLatencyMs: Math.round(logStats._avg.latencyMs || 0),
        totalCost: Math.round((logStats._sum.estimatedCost || 0) * 10000) / 10000,
        totalTokens: (logStats._sum.promptTokens || 0) + (logStats._sum.completionTokens || 0)
      };
    }));

    return {
      status: 'success',
      data: agentStats
    };
  });
}
