import { FastifyInstance, FastifyPluginOptions, FastifyRequest } from 'fastify';
import prisma from '../lib/prisma';
import { protect } from '../middleware/auth';
import { AppError } from '../middleware/error';
import { applyTenantScope } from '../utils/tenantScope';
import { XPayService, XPayPaymentMethod } from '../services/billing/XPayService';
import { DiscountAndInvoiceService } from '../services/billing/DiscountAndInvoiceService';

async function resolveBillingTenantId(request: FastifyRequest): Promise<string> {
  const headerTenant = request.headers['x-tenant-id'];
  const explicitTenantId = Array.isArray(headerTenant) ? headerTenant[0] : headerTenant;

  if (!request.user && (request.headers.authorization || request.cookies?.token)) {
    try {
      await protect(request, {} as any);
    } catch (_) {
      // Allow fallback to x-tenant-id if provided
    }
  }

  const tenantId =
    explicitTenantId?.trim() ||
    request.user?.activeTenantId ||
    request.user?.tenantId ||
    '8a123d29-99da-4db4-9141-8f6bb9b7233a';

  return tenantId;
}

export default async function billingRoutes(fastify: FastifyInstance, options: FastifyPluginOptions) {

  // @route   GET /api/billing/summary
  // @desc    Get subscription status, conversation limits, and accurate cost breakdown
  fastify.get('/summary', { preHandler: protect }, async (request, reply) => {
    const user = request.user!;
    const isL0 = user.roleLevel === 'L0_PLATFORM' || user.role === 'super_admin';
    const isL1 = user.roleLevel === 'L1_GROUP';

    const query = (request.query as any) || {};
    const { period, startDate, endDate, tenantId: overrideTenantId } = query;

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

    const baseFilter: any = {};
    if (Object.keys(dateFilter).length > 0) {
      baseFilter.createdAt = dateFilter;
    }

    if (overrideTenantId && overrideTenantId !== 'all') {
      baseFilter.tenantId = overrideTenantId;
    }

    const logWhere = applyTenantScope(baseFilter, user);
    const sessionWhere = applyTenantScope(baseFilter, user);

    const effectiveTenantId = (overrideTenantId && overrideTenantId !== 'all' && (isL0 || isL1))
      ? overrideTenantId
      : user.tenantId;

    const [tenant, tenantsList, sessionStats, voiceLogStats, chatLogStats, voiceSessionStats] = await Promise.all([
      effectiveTenantId
        ? prisma.tenant.findFirst({
            where: applyTenantScope({ id: effectiveTenantId }, user, 'Tenant')
          })
        : null,
      (isL0 || isL1)
        ? prisma.tenant.findMany({
            where: applyTenantScope({}, user, 'Tenant'),
            select: { id: true, name: true, slug: true }
          })
        : Promise.resolve([]),
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

    const tenantLimit = tenant ? await prisma.tenantLimit.findUnique({ where: { tenantId: tenant.id } }) : null;
    const subscription = tenant ? await prisma.subscription.findFirst({ where: { tenantId: tenant.id }, orderBy: { createdAt: 'desc' } }) : null;

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
        tenantsList,
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

  // @route   GET /api/billing/quota
  // @desc    Get Phase 5 token quota status, 80%/95%/100% alert state, bundles & XPay transactions
  fastify.get('/quota', async (request, reply) => {
    const tenantId = await resolveBillingTenantId(request);
    const data = await XPayService.getQuotaStatus(tenantId);
    return {
      status: 'success',
      data
    };
  });

  // @route   PUT /api/billing/quota
  // @desc    Update tenant monthly token limit and hard-stop enforcement setting
  fastify.put('/quota', async (request, reply) => {
    const tenantId = await resolveBillingTenantId(request);
    const body = (request.body || {}) as {
      baseTokenLimit?: number;
      hardStopEnabled?: boolean;
    };

    const data = await XPayService.updateQuotaSettings(tenantId, body);
    return {
      status: 'success',
      data
    };
  });

  // @route   POST /api/billing/xpay/create-intent
  // @desc    Create an XPay Sandbox Payment Intent (Card, JazzCash, EasyPaisa) with HMAC-SHA256 signature
  fastify.post('/xpay/create-intent', async (request, reply) => {
    const tenantId = await resolveBillingTenantId(request);
    const body = (request.body || {}) as {
      bundleId?: string;
      paymentMethod?: XPayPaymentMethod;
      customer?: { name?: string; email?: string; phone?: string };
    };

    if (!body.bundleId) {
      throw new AppError('bundleId is required', 400);
    }

    const intent = await XPayService.createPaymentIntent({
      tenantId,
      bundleId: body.bundleId,
      paymentMethod: body.paymentMethod || 'card',
      customer: body.customer
    });

    return {
      status: 'success',
      data: intent
    };
  });

  // @route   POST /api/billing/xpay/confirm-sandbox
  // @desc    Confirm an XPay Sandbox payment (Card / JazzCash / EasyPaisa) and credit bundle tokens
  fastify.post('/xpay/confirm-sandbox', async (request, reply) => {
    const tenantId = await resolveBillingTenantId(request);
    const body = (request.body || {}) as {
      paymentIntentId?: string;
      maskedAccount?: string;
    };

    if (!body.paymentIntentId) {
      throw new AppError('paymentIntentId is required', 400);
    }

    const result = await XPayService.confirmSandboxPayment({
      tenantId,
      paymentIntentId: body.paymentIntentId,
      maskedAccount: body.maskedAccount
    });

    return {
      status: 'success',
      data: result
    };
  });

  // @route   POST /api/billing/xpay/webhook
  // @desc    Verify XPay HMAC-SHA256 webhook signature and credit token bundle
  fastify.post('/xpay/webhook', async (request, reply) => {
    const signatureHeader =
      (request.headers['x-signature'] as string) ||
      (request.headers['x-xpay-signature'] as string) ||
      '';
    const payload = (request.body || {}) as Record<string, any>;
    const rawBody = JSON.stringify(payload);

    if (!XPayService.verifyWebhookSignature(rawBody, signatureHeader)) {
      throw new AppError('Invalid XPay webhook HMAC-SHA256 signature', 401);
    }

    const tenantId = payload.metadata?.tenantId || (await resolveBillingTenantId(request));
    const paymentIntentId = payload.paymentIntentId || payload.id;

    if (paymentIntentId && payload.status === 'succeeded') {
      const result = await XPayService.confirmSandboxPayment({
        tenantId,
        paymentIntentId,
        maskedAccount: payload.maskedAccount || 'XPay Webhook'
      });
      return {
        status: 'success',
        received: true,
        data: result
      };
    }

    return {
      status: 'success',
      received: true
    };
  });

  // @route   GET /api/billing/discounts-and-invoices
  // @desc    Blueprint Sec 6.3 & 6.5: Get active discounts, self-serve threshold & enterprise invoices
  fastify.get('/discounts-and-invoices', async (request, reply) => {
    const tenantId = await resolveBillingTenantId(request);
    const data = await DiscountAndInvoiceService.getOverview(tenantId);
    return { status: 'success', data };
  });

  // @route   POST /api/billing/discounts
  // @desc    Blueprint Sec 6.5: Create a discount rule (percentage, volume, loyalty, group_code, trial_credit)
  fastify.post('/discounts', async (request, reply) => {
    const tenantId = await resolveBillingTenantId(request);
    const body = (request.body || {}) as any;

    if (!body.code || !body.type) {
      throw new AppError('Discount code and type are required', 400);
    }

    const rule = await DiscountAndInvoiceService.createDiscountRule(tenantId, body);
    return { status: 'success', data: rule };
  });

  // @route   POST /api/billing/invoices/request
  // @desc    Blueprint Sec 6.3: Submit a formal Enterprise Invoice Request (> PKR 100,000 threshold)
  fastify.post('/invoices/request', async (request, reply) => {
    const tenantId = await resolveBillingTenantId(request);
    const body = (request.body || {}) as {
      requestedTokens?: number;
      grossAmountPkr?: number;
      discountCode?: string;
      notes?: string;
    };

    if (!body.requestedTokens || !body.grossAmountPkr) {
      throw new AppError('requestedTokens and grossAmountPkr are required', 400);
    }

    const invoice = await DiscountAndInvoiceService.submitEnterpriseInvoiceRequest(tenantId, {
      requestedTokens: Number(body.requestedTokens),
      grossAmountPkr: Number(body.grossAmountPkr),
      discountCode: body.discountCode,
      notes: body.notes,
    });

    return { status: 'success', data: invoice };
  });

  // @route   POST /api/billing/invoices/:invoiceId/approve-credit
  // @desc    Blueprint Sec 6.3: Sidat Super User manual token credit upon invoice payment confirmation
  fastify.post('/invoices/:invoiceId/approve-credit', async (request, reply) => {
    const tenantId = await resolveBillingTenantId(request);
    const { invoiceId } = request.params as { invoiceId: string };
    const body = (request.body || {}) as { approvedBy?: string; reason?: string };

    const result = await DiscountAndInvoiceService.approveAndCreditInvoice(
      tenantId,
      invoiceId,
      body
    );
    return { status: 'success', data: result };
  });
}
