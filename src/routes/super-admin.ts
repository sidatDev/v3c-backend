import { FastifyInstance, FastifyPluginOptions } from 'fastify';
import prisma from '../lib/prisma';
import { protect } from '../middleware/auth';
import { AppError } from '../middleware/error';

export default async function superAdminRoutes(fastify: FastifyInstance, options: FastifyPluginOptions) {

  // @route   GET /api/super-admin/tenants-usage
  // @desc    Get tenant leaderboard with token usage, session volume, and API costs
  fastify.get('/tenants-usage', { preHandler: protect }, async (request, reply) => {
    if (request.user?.role !== 'super_admin') {
      throw new AppError('Access denied: Super Admin privilege required', 403);
    }

    const { startDate, endDate, period } = request.query as any;

    let dateFilter: any = {};
    const now = new Date();

    if (startDate || endDate) {
      if (startDate) dateFilter.gte = new Date(startDate);
      if (endDate) dateFilter.lte = new Date(endDate);
    } else if (period && period !== 'all') {
      let days = 30;
      if (period === '24h') days = 1;
      else if (period === '3d') days = 3;
      else if (period === '7d') days = 7;
      else if (period === '30d') days = 30;

      dateFilter.gte = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
    }

    const sessionWhere: any = {};
    const logWhere: any = {};

    if (Object.keys(dateFilter).length > 0) {
      sessionWhere.createdAt = dateFilter;
      logWhere.createdAt = dateFilter;
    }

    const [tenants, sessionGroups, logGroups] = await Promise.all([
      prisma.tenant.findMany({
        select: {
          id: true,
          name: true,
          slug: true,
          status: true,
          TenantLimit: {
            select: {
              maxConversations: true
            }
          },
          Subscription: {
            select: {
              status: true
            }
          }
        }
      }),
      prisma.visitorSession.groupBy({
        by: ['tenantId'],
        where: { ...sessionWhere, tenantId: { not: null } },
        _count: { id: true },
        _sum: { totalInputTokens: true, totalOutputTokens: true, estimatedCost: true }
      }),
      prisma.aiLog.groupBy({
        by: ['tenantId'],
        where: { ...logWhere, tenantId: { not: null } },
        _count: { id: true },
        _sum: { promptTokens: true, completionTokens: true, estimatedCost: true }
      })
    ]);

    const sessionMap = new Map(sessionGroups.map(g => [g.tenantId, g]));
    const logMap = new Map(logGroups.map(g => [g.tenantId, g]));

    const tenantUsage = tenants.map((t) => {
      const sessionStats = sessionMap.get(t.id);
      const logStats = logMap.get(t.id);

      const sessionCount = sessionStats?._count.id || 0;
      const promptTokens = (sessionStats?._sum.totalInputTokens || 0) || (logStats?._sum.promptTokens || 0);
      const completionTokens = (sessionStats?._sum.totalOutputTokens || 0) || (logStats?._sum.completionTokens || 0);
      const totalTokens = promptTokens + completionTokens;
      const totalCost = (sessionStats?._sum.estimatedCost || 0) || (logStats?._sum.estimatedCost || 0);

      const limit = t.TenantLimit?.maxConversations || 1000;
      const quotaPercentage = limit > 0 ? Math.min(100, Math.round((sessionCount / limit) * 100)) : 0;

      return {
        id: t.id,
        name: t.name,
        slug: t.slug,
        status: t.status,
        plan: t.Subscription && t.Subscription.length > 0 ? t.Subscription[0].status : 'Standard Plan',
        sessionCount,
        promptTokens,
        completionTokens,
        totalTokens,
        totalCost: Math.round(totalCost * 1000000) / 1000000,
        quotaLimit: limit,
        quotaPercentage
      };
    });

    // Sort leaderboard by total tokens descending
    tenantUsage.sort((a, b) => b.totalTokens - a.totalTokens);

    return {
      status: 'success',
      data: tenantUsage
    };
  });

  // @route   GET /api/super-admin/export-usage
  // @desc    Export usage metrics as CSV string for auditing and accounting
  fastify.get('/export-usage', { preHandler: protect }, async (request, reply) => {
    if (request.user?.role !== 'super_admin') {
      throw new AppError('Access denied: Super Admin privilege required', 403);
    }

    const { startDate, endDate, period } = request.query as any;

    let dateFilter: any = {};
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

    const logWhere: any = {};
    if (Object.keys(dateFilter).length > 0) {
      logWhere.createdAt = dateFilter;
    }

    const logs = await prisma.aiLog.findMany({
      where: logWhere,
      select: {
        id: true,
        tenantId: true,
        mode: true,
        modelUsed: true,
        promptTokens: true,
        completionTokens: true,
        estimatedCost: true,
        latencyMs: true,
        fallbackTriggered: true,
        createdAt: true
      },
      orderBy: { createdAt: 'desc' },
      take: 5000
    });

    const headers = ['Log ID', 'Tenant ID', 'Mode', 'Model', 'Prompt Tokens', 'Completion Tokens', 'Total Tokens', 'Cost (USD)', 'Latency (ms)', 'Fallback', 'Timestamp'];
    const rows = logs.map(l => [
      l.id,
      l.tenantId,
      l.mode,
      l.modelUsed,
      l.promptTokens,
      l.completionTokens,
      l.promptTokens + l.completionTokens,
      l.estimatedCost.toFixed(6),
      l.latencyMs,
      l.fallbackTriggered ? 'Yes' : 'No',
      new Date(l.createdAt).toISOString()
    ]);

    const csvContent = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');

    reply
      .header('Content-Type', 'text/csv')
      .header('Content-Disposition', `attachment; filename="v3c-usage-report-${new Date().toISOString().split('T')[0]}.csv"`)
      .send(csvContent);
  });
}
