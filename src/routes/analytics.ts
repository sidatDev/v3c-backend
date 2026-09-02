import { FastifyInstance, FastifyPluginOptions } from 'fastify';
import prisma from '../lib/prisma';
import { protect } from '../middleware/auth';

function buildWhereConditions(user: any, queryParams: any) {
  const { tenantId: targetTenantId, period, startDate: reqStart, endDate: reqEnd } = queryParams;

  let whereTenant: any = {};
  
  // Super Admin can view all tenants or filter by specific target tenant
  if (user.role === 'super_admin') {
    if (targetTenantId && targetTenantId !== 'all') {
      whereTenant = { tenantId: targetTenantId };
    }
  } else {
    // Regular Tenant Admin is strictly scoped to their assigned tenant
    whereTenant = { tenantId: user.tenantId };
  }

  let dateFilter: any = {};
  const now = new Date();

  if (reqStart || reqEnd) {
    if (reqStart) dateFilter.gte = new Date(reqStart);
    if (reqEnd) dateFilter.lte = new Date(reqEnd);
  } else if (period && period !== 'all') {
    let days = 30;
    if (period === '24h') days = 1;
    else if (period === '3d') days = 3;
    else if (period === '7d') days = 7;
    else if (period === '30d') days = 30;

    const start = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
    dateFilter.gte = start;
  }

  const sessionWhere = { ...whereTenant };
  const logWhere = { ...whereTenant };

  if (Object.keys(dateFilter).length > 0) {
    sessionWhere.createdAt = dateFilter;
    logWhere.createdAt = dateFilter;
  }

  return { sessionWhere, logWhere, whereTenant, dateFilter };
}

export default async function analyticsRoutes(fastify: FastifyInstance, options: FastifyPluginOptions) {

  // @route   GET /api/analytics/overview
  // @desc    Get high-level platform & token analytics metrics
  fastify.get('/overview', { preHandler: protect }, async (request, reply) => {
    const user = request.user!;
    const query = request.query as any;
    const { sessionWhere, logWhere } = buildWhereConditions(user, query);

    const [
      sessionAggregate,
      sessionChannelCounts,
      fallbackLogsCount,
      logAggregate,
      logsForModels,
      timeseriesLogs
    ] = await Promise.all([
      prisma.visitorSession.aggregate({
        where: sessionWhere,
        _count: { id: true },
        _sum: { estimatedCost: true, totalInputTokens: true, totalOutputTokens: true }
      }),
      prisma.visitorSession.groupBy({
        by: ['channel'],
        where: sessionWhere,
        _count: { id: true }
      }),
      prisma.aiLog.count({ where: { ...logWhere, fallbackTriggered: true } }),
      prisma.aiLog.aggregate({
        where: logWhere,
        _count: { id: true },
        _avg: { latencyMs: true },
        _sum: { estimatedCost: true, promptTokens: true, completionTokens: true }
      }),
      prisma.aiLog.groupBy({
        by: ['modelUsed'],
        where: logWhere,
        _sum: { promptTokens: true, completionTokens: true, estimatedCost: true },
        _count: { id: true }
      }),
      prisma.aiLog.findMany({
        where: logWhere,
        select: { promptTokens: true, completionTokens: true, estimatedCost: true, createdAt: true },
        orderBy: { createdAt: 'asc' },
        take: 1000
      })
    ]);

    const totalSessions = sessionAggregate._count.id || 0;
    const chatSessions = sessionChannelCounts.find(c => c.channel === 'chat')?._count.id || 0;
    const voiceSessions = sessionChannelCounts.find(c => c.channel === 'voice')?._count.id || 0;
    const totalLogsCount = logAggregate._count.id || 0;

    // Fallback rate calculation
    const fallbackRate = totalLogsCount > 0 ? Math.round((fallbackLogsCount / totalLogsCount) * 1000) / 10 : 0;
    
    // Combine session and log tokens/costs
    const promptTokens = (sessionAggregate._sum.totalInputTokens || 0) || (logAggregate._sum.promptTokens || 0);
    const completionTokens = (sessionAggregate._sum.totalOutputTokens || 0) || (logAggregate._sum.completionTokens || 0);
    const totalTokens = promptTokens + completionTokens;
    
    const totalCost = (sessionAggregate._sum.estimatedCost || 0) || (logAggregate._sum.estimatedCost || 0);
    const avgLatencyMs = Math.round(logAggregate._avg.latencyMs || 0);

    // Format model breakdown
    const modelBreakdown = logsForModels.map(m => ({
      model: m.modelUsed || 'gpt-4o-mini',
      promptTokens: m._sum.promptTokens || 0,
      completionTokens: m._sum.completionTokens || 0,
      totalTokens: (m._sum.promptTokens || 0) + (m._sum.completionTokens || 0),
      cost: Math.round((m._sum.estimatedCost || 0) * 1000000) / 1000000,
      count: m._count.id
    }));

    // Group timeseries by date
    const timeseriesMap: { [date: string]: { inputTokens: number; outputTokens: number; cost: number; requests: number } } = {};
    for (const log of timeseriesLogs) {
      const dateStr = new Date(log.createdAt).toISOString().split('T')[0];
      if (!timeseriesMap[dateStr]) {
        timeseriesMap[dateStr] = { inputTokens: 0, outputTokens: 0, cost: 0, requests: 0 };
      }
      timeseriesMap[dateStr].inputTokens += log.promptTokens || 0;
      timeseriesMap[dateStr].outputTokens += log.completionTokens || 0;
      timeseriesMap[dateStr].cost += log.estimatedCost || 0;
      timeseriesMap[dateStr].requests += 1;
    }

    const timeseriesData = Object.entries(timeseriesMap).map(([date, data]) => ({
      date,
      inputTokens: data.inputTokens,
      outputTokens: data.outputTokens,
      totalTokens: data.inputTokens + data.outputTokens,
      cost: Math.round(data.cost * 10000) / 10000,
      requests: data.requests
    }));

    return {
      status: 'success',
      data: {
        totalSessions,
        chatSessions,
        voiceSessions,
        fallbackRate,
        promptTokens,
        completionTokens,
        totalTokens,
        totalCost: Math.round(totalCost * 1000000) / 1000000,
        avgLatencyMs,
        modelBreakdown,
        timeseriesData
      }
    };
  });

  // @route   GET /api/analytics/top-questions
  // @desc    Get top asked questions aggregated from AI logs
  fastify.get('/top-questions', { preHandler: protect }, async (request, reply) => {
    const user = request.user!;
    const query = request.query as any;
    const { logWhere } = buildWhereConditions(user, query);

    const logs = await prisma.aiLog.findMany({
      where: { ...logWhere, userQuery: { not: null } },
      select: { userQuery: true, fallbackTriggered: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
      take: 200
    });

    const frequencyMap: { [q: string]: { count: number; fallbackCount: number } } = {};
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
      .map(([queryStr, stats]) => ({
        query: queryStr,
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
  // @desc    Get per-agent performance & token analytics
  fastify.get('/agents', { preHandler: protect }, async (request, reply) => {
    const user = request.user!;
    const query = request.query as any;
    const { sessionWhere, logWhere, whereTenant } = buildWhereConditions(user, query);

    const [agents, sessionGroups, logGroups] = await Promise.all([
      prisma.agent.findMany({
        where: whereTenant,
        select: { id: true, name: true, voice: true, isActive: true }
      }),
      prisma.visitorSession.groupBy({
        by: ['aiAgentId'],
        where: { ...sessionWhere, aiAgentId: { not: null } },
        _count: { id: true }
      }),
      prisma.aiLog.groupBy({
        by: ['agentId'],
        where: { ...logWhere, agentId: { not: null } },
        _avg: { latencyMs: true },
        _sum: { estimatedCost: true, promptTokens: true, completionTokens: true }
      })
    ]);

    const sessionMap = new Map(sessionGroups.map(g => [g.aiAgentId, g._count.id]));
    const logMap = new Map(logGroups.map(g => [g.agentId, g]));

    const agentStats = agents.map((agent) => {
      const sessionCount = sessionMap.get(agent.id) || 0;
      const logStats = logMap.get(agent.id);

      const promptTokens = logStats?._sum.promptTokens || 0;
      const completionTokens = logStats?._sum.completionTokens || 0;

      return {
        id: agent.id,
        name: agent.name,
        voice: agent.voice,
        isActive: agent.isActive,
        sessionCount,
        promptTokens,
        completionTokens,
        totalTokens: promptTokens + completionTokens,
        avgLatencyMs: Math.round(logStats?._avg?.latencyMs || 0),
        totalCost: Math.round((logStats?._sum?.estimatedCost || 0) * 1000000) / 1000000
      };
    });

    return {
      status: 'success',
      data: agentStats
    };
  });
}
