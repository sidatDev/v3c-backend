import { FastifyInstance, FastifyPluginOptions } from 'fastify';
import prisma from '../lib/prisma';
import { protect } from '../middleware/auth';
import { AppError } from '../middleware/error';

export default async function billingRoutes(fastify: FastifyInstance, options: FastifyPluginOptions) {

  // @route   GET /api/billing/summary
  // @desc    Get subscription status, conversation limits, and accurate cost breakdown
  fastify.get('/summary', { preHandler: protect }, async (request, reply) => {
    let tenantId = request.user?.tenantId;
    const query = (request.query as any) || {};
    const { period, startDate, endDate, tenantId: overrideTenantId } = query;

    // Super admin override
    if (request.user?.role === 'super_admin' && overrideTenantId && overrideTenantId !== 'all') {
      tenantId = overrideTenantId;
    }

    if (!tenantId && request.user?.role !== 'super_admin') {
      throw new AppError('Tenant ID missing', 400);
    }

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

    const logWhere: any = tenantId ? { tenantId } : {};
    const sessionWhere: any = tenantId ? { tenantId } : {};

    if (Object.keys(dateFilter).length > 0) {
      logWhere.createdAt = dateFilter;
      sessionWhere.createdAt = dateFilter;
    }

    const [tenant, tenantLimit, subscription, sessionStats, voiceLogStats, chatLogStats, voiceSessionStats] = await Promise.all([
      tenantId ? prisma.tenant.findUnique({ where: { id: tenantId } }) : null,
      tenantId ? prisma.tenantLimit.findUnique({ where: { tenantId } }) : null,
      tenantId ? prisma.subscription.findFirst({ where: { tenantId }, orderBy: { createdAt: 'desc' } }) : null,
      prisma.visitorSession.aggregate({
        where: sessionWhere,
        _count: { id: true }
      }),
      prisma.aiLog.aggregate({
        where: { ...logWhere, mode: 'voice' },
        _count: { id: true },
        _sum: { promptTokens: true, completionTokens: true, estimatedCost: true }
      }),
      prisma.aiLog.aggregate({
        where: { ...logWhere, mode: 'chat' },
        _count: { id: true },
        _sum: { promptTokens: true, completionTokens: true, estimatedCost: true }
      }),
      prisma.visitorSession.aggregate({
        where: { ...sessionWhere, channel: 'voice' },
        _count: { id: true },
        _sum: { totalInputTokens: true, totalOutputTokens: true, estimatedCost: true }
      })
    ]);

    const sessionCount = sessionStats._count.id || 0;
    const maxConversations = tenantLimit?.maxConversations || 1000;
    const quotaPercentage = Math.min(100, Math.round((sessionCount / maxConversations) * 100));

    let voicePromptTokens = voiceLogStats._sum.promptTokens || 0;
    let voiceCompletionTokens = voiceLogStats._sum.completionTokens || 0;
    let voiceCost = voiceLogStats._sum.estimatedCost || 0;

    // Fallback to VisitorSession voice channel totals if AiLog is empty for older voice calls
    if (voicePromptTokens === 0 && voiceSessionStats._sum.totalInputTokens) {
      voicePromptTokens = voiceSessionStats._sum.totalInputTokens || 0;
      voiceCompletionTokens = voiceSessionStats._sum.totalOutputTokens || 0;
      voiceCost = voiceSessionStats._sum.estimatedCost || 0;
    }

    const chatPromptTokens = chatLogStats._sum.promptTokens || 0;
    const chatCompletionTokens = chatLogStats._sum.completionTokens || 0;
    const chatCost = chatLogStats._sum.estimatedCost || 0;

    const totalPromptTokens = voicePromptTokens + chatPromptTokens;
    const totalCompletionTokens = voiceCompletionTokens + chatCompletionTokens;
    const totalTokens = totalPromptTokens + totalCompletionTokens;
    const totalCost = voiceCost + chatCost;

    return {
      status: 'success',
      data: {
        tenant: tenant ? { id: tenant.id, name: tenant.name, slug: tenant.slug } : null,
        plan: {
          name: subscription?.status || 'Enterprise Tier',
          status: tenant?.status || 'active',
          maxConversations,
          usedConversations: sessionCount,
          quotaPercentage
        },
        billingSummary: {
          totalCost: Math.round(totalCost * 1000000) / 1000000,
          voiceCost: Math.round(voiceCost * 1000000) / 1000000,
          chatCost: Math.round(chatCost * 1000000) / 1000000,
          totalTokens,
          totalPromptTokens,
          totalCompletionTokens,
          voiceTokens: voicePromptTokens + voiceCompletionTokens,
          chatTokens: chatPromptTokens + chatCompletionTokens,
          sessionCount
        }
      }
    };
  });
}
