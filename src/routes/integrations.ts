import { FastifyInstance, FastifyPluginOptions, FastifyRequest } from 'fastify';
import { randomUUID } from 'crypto';
import prisma from '../lib/prisma';
import { protect } from '../middleware/auth';
import { restrictTo } from '../middleware/rbac';
import { AppError } from '../middleware/error';
import { applyTenantScope } from '../utils/tenantScope';
import {
  WebhookEngineService,
  V3CWebhookEvent,
} from '../services/webhooks/WebhookEngineService';
import { WorkflowEngineService } from '../services/workflows/WorkflowEngineService';
import { OutboundCampaignService } from '../services/campaigns/OutboundCampaignService';
import {
  OmnichannelAdapterService,
  OmnichannelType,
} from '../services/gateway/OmnichannelAdapterService';
import {
  ServerProvisioningService,
  ServerNodeKey,
} from '../services/storage/ServerProvisioningService';

async function resolveIntegrationTenantId(request: FastifyRequest): Promise<string> {
  const headerTenant = request.headers['x-tenant-id'];
  const explicitTenantId = Array.isArray(headerTenant) ? headerTenant[0] : headerTenant;

  if (!request.user && (request.headers.authorization || request.cookies?.token)) {
    try {
      await protect(request, {} as any);
    } catch (_) {}
  }

  return (
    explicitTenantId?.trim() ||
    request.user?.activeTenantId ||
    request.user?.tenantId ||
    '8a123d29-99da-4db4-9141-8f6bb9b7233a'
  );
}

export default async function integrationsRoutes(fastify: FastifyInstance, options: FastifyPluginOptions) {

  // @route   GET /api/integrations
  // @desc    Get list of registered integrations
  fastify.get('/', { preHandler: [protect, restrictTo('integrations', 'view')] }, async (request, reply) => {
    const integrations = await prisma.integration.findMany({
      where: applyTenantScope({}, request.user),
      include: {
        IntegrationTool: true
      },
      orderBy: { createdAt: 'desc' }
    });

    return { status: 'success', data: integrations };
  });

  // @route   POST /api/integrations
  // @desc    Register a new third-party integration
  fastify.post('/', { preHandler: [protect, restrictTo('integrations', 'manage')] }, async (request, reply) => {
    const tenantId = request.user!.tenantId;
    if (!tenantId) {
      throw new AppError('Tenant ID missing', 400);
    }
    const { name, description, baseUrl, authType, authConfig } = request.body as any;

    if (!name || !baseUrl) {
      throw new AppError('Name and Base URL are required.', 400);
    }

    const integration = await prisma.integration.create({
      data: {
        id: randomUUID(),
        tenantId,
        name,
        description,
        baseUrl,
        authType: authType || 'NONE',
        authConfig: authConfig || {},
        isActive: true,
        updatedAt: new Date()
      }
    });

    reply.status(201);
    return { status: 'success', data: integration };
  });

  // @route   PUT /api/integrations/:id
  fastify.put('/:id', { preHandler: [protect, restrictTo('integrations', 'manage')] }, async (request, reply) => {
    const id = (request.params as any).id;
    const { name, description, baseUrl, authType, authConfig, isActive } = request.body as any;

    const existing = await prisma.integration.findFirst({
      where: applyTenantScope({ id }, request.user)
    });
    if (!existing) {
      throw new AppError('Integration not found', 404);
    }

    const updated = await prisma.integration.update({
      where: { id },
      data: {
        name: name || existing.name,
        description: description !== undefined ? description : existing.description,
        baseUrl: baseUrl || existing.baseUrl,
        authType: authType || existing.authType,
        authConfig: authConfig || existing.authConfig,
        isActive: isActive !== undefined ? isActive : existing.isActive,
        updatedAt: new Date()
      }
    });

    return { status: 'success', data: updated };
  });

  // @route   DELETE /api/integrations/:id
  fastify.delete('/:id', { preHandler: [protect, restrictTo('integrations', 'manage')] }, async (request, reply) => {
    const id = (request.params as any).id;

    const existing = await prisma.integration.findFirst({
      where: applyTenantScope({ id }, request.user)
    });
    if (!existing) {
      throw new AppError('Integration not found', 404);
    }

    await prisma.integration.delete({ where: { id } });
    return { status: 'success', message: 'Integration deleted successfully.' };
  });

  // @route   GET /api/integrations/logs
  // @desc    Get integration execution logs
  fastify.get('/logs', async (request, reply) => {
    const tenantId = await resolveIntegrationTenantId(request);
    const logs = await prisma.integrationLog.findMany({
      where: { tenantId },
      include: {
        Integration: {
          select: { name: true }
        }
      },
      orderBy: { createdAt: 'desc' },
      take: 50
    });

    return { status: 'success', data: logs };
  });

  // @route   GET /api/integrations/marketplace
  // @desc    Phase 6: Get 5 pre-built CRM/Helpdesk Marketplace Connectors & webhook settings
  fastify.get('/marketplace', async (request, reply) => {
    const tenantId = await resolveIntegrationTenantId(request);
    const data = await WebhookEngineService.getMarketplaceOverview(tenantId);
    return { status: 'success', data };
  });

  // @route   POST /api/integrations/marketplace/:connectorKey/toggle
  // @desc    Phase 6: Toggle & configure a Marketplace Connector (HubSpot, Salesforce, Zoho, Zendesk, Sidat CRM)
  fastify.post('/marketplace/:connectorKey/toggle', async (request, reply) => {
    const tenantId = await resolveIntegrationTenantId(request);
    const { connectorKey } = request.params as { connectorKey: string };
    const body = (request.body || {}) as {
      enabled?: boolean;
      targetUrl?: string;
      hmacSecret?: string;
      events?: V3CWebhookEvent[];
      maskPii?: boolean;
    };

    const updated = await WebhookEngineService.toggleMarketplaceConnector({
      tenantId,
      connectorKey,
      enabled: body.enabled !== undefined ? Boolean(body.enabled) : true,
      targetUrl: body.targetUrl,
      hmacSecret: body.hmacSecret,
      events: body.events,
      maskPii: body.maskPii
    });

    return { status: 'success', data: updated };
  });

  // @route   POST /api/integrations/webhooks/test
  // @desc    Phase 6: Dispatch a signed outbound webhook event (with HMAC-SHA256, PII masking & 5 retries)
  fastify.post('/webhooks/test', async (request, reply) => {
    const tenantId = await resolveIntegrationTenantId(request);
    const body = (request.body || {}) as {
      event?: V3CWebhookEvent;
      integrationId?: string;
      payload?: Record<string, any>;
    };

    const event: V3CWebhookEvent = body.event || 'lead.captured';
    const samplePayload = body.payload || {
      leadId: 'lead_test_901',
      name: 'Ayesha Khan',
      email: 'ayesha.khan@example.com',
      phone: '+923001234567',
      channel: 'whatsapp',
      summary: 'Interested in enterprise AI voice + WhatsApp automation',
    };

    const results = await WebhookEngineService.dispatchOutboundEvent({
      tenantId,
      event,
      payload: samplePayload,
      integrationId: body.integrationId,
    });

    return {
      status: 'success',
      data: {
        event,
        dispatchedCount: results.length,
        deliveries: results,
      },
    };
  });

  // @route   POST /api/integrations/webhooks/inbound/:integrationId
  // @desc    Phase 6: Public Inbound Webhook endpoint per integration with HMAC-SHA256 verification
  fastify.post('/webhooks/inbound/:integrationId', async (request, reply) => {
    const { integrationId } = request.params as { integrationId: string };
    const signatureHeader =
      (request.headers['x-v3c-signature'] as string) ||
      (request.headers['x-signature'] as string) ||
      undefined;
    const payload = (request.body || {}) as Record<string, any>;

    const result = await WebhookEngineService.processInboundWebhook({
      integrationId,
      signatureHeader,
      payload,
    });

    return {
      status: 'success',
      received: true,
      data: result,
    };
  });

  // @route   POST /api/integrations/:id/tools
  // @desc    Phase 6: Register a Mid-Conversation API Action Tool for an integration
  fastify.post('/:id/tools', async (request, reply) => {
    const tenantId = await resolveIntegrationTenantId(request);
    const integrationId = (request.params as any).id;
    const body = (request.body || {}) as {
      name?: string;
      description?: string;
      method?: string;
      path?: string;
      requestCompleteMessage?: string;
      requestFailedMessage?: string;
    };

    if (!body.name || !body.path) {
      throw new AppError('Tool name and path are required', 400);
    }

    const integ = await prisma.integration.findFirst({
      where: { id: integrationId, tenantId },
    });
    if (!integ) {
      throw new AppError('Integration not found for this tenant', 404);
    }

    const tool = await prisma.integrationTool.create({
      data: {
        id: randomUUID(),
        integrationId: integ.id,
        name: body.name.trim(),
        description: body.description?.trim() || `Mid-conversation API tool: ${body.name}`,
        method: (body.method || 'POST').toUpperCase(),
        path: body.path.trim(),
        parameters: {},
        isActive: true,
        requestCompleteMessage: body.requestCompleteMessage || 'Order/CRM status retrieved successfully.',
        requestFailedMessage: body.requestFailedMessage || 'Unable to reach CRM right now; a human agent will follow up.',
        updatedAt: new Date(),
      },
    });

    return { status: 'success', data: tool };
  });

  // @route   POST /api/integrations/tools/:toolId/execute
  // @desc    Phase 6: Execute a Mid-Conversation API Tool with timeout, PII masking & fallback
  fastify.post('/tools/:toolId/execute', async (request, reply) => {
    const tenantId = await resolveIntegrationTenantId(request);
    const { toolId } = request.params as { toolId: string };
    const body = (request.body || {}) as { inputParams?: Record<string, any> };

    const result = await WebhookEngineService.executeMidConversationTool({
      tenantId,
      toolId,
      inputParams: body.inputParams,
    });

    return { status: 'success', data: result };
  });

  // @route   GET /api/integrations/workflows
  // @desc    Phase 8: List tenant workflows (Wizard & Canvas definitions, versions, governance status)
  fastify.get('/workflows', async (request, reply) => {
    const tenantId = await resolveIntegrationTenantId(request);
    const data = await WorkflowEngineService.listWorkflows(tenantId);
    return { status: 'success', data };
  });

  // @route   POST /api/integrations/workflows
  // @desc    Phase 8: Create or update a workflow (auto-increments version & syncs Canvas graph)
  fastify.post('/workflows', async (request, reply) => {
    const tenantId = await resolveIntegrationTenantId(request);
    const body = (request.body || {}) as any;

    if (!body.name || !body.triggerEvent) {
      throw new AppError('Workflow name and triggerEvent are required', 400);
    }

    const saved = await WorkflowEngineService.upsertWorkflow(tenantId, body);
    return { status: 'success', data: saved };
  });

  // @route   POST /api/integrations/workflows/:workflowId/simulate
  // @desc    Phase 8: Simulate (dry-run) or execute a workflow & test 3-failure auto-pause governance
  fastify.post('/workflows/:workflowId/simulate', async (request, reply) => {
    const tenantId = await resolveIntegrationTenantId(request);
    const { workflowId } = request.params as { workflowId: string };
    const body = (request.body || {}) as {
      payload?: Record<string, any>;
      dryRun?: boolean;
      simulateFailure?: boolean;
    };

    const result = await WorkflowEngineService.runWorkflow({
      tenantId,
      workflowId,
      payload: body.payload,
      dryRun: body.dryRun !== undefined ? Boolean(body.dryRun) : true,
      simulateFailure: Boolean(body.simulateFailure),
    });

    return { status: 'success', data: result };
  });

  // @route   DELETE /api/integrations/workflows/:workflowId
  // @desc    Phase 8: Delete a workflow
  fastify.delete('/workflows/:workflowId', async (request, reply) => {
    const tenantId = await resolveIntegrationTenantId(request);
    const { workflowId } = request.params as { workflowId: string };
    await WorkflowEngineService.deleteWorkflow(tenantId, workflowId);
    return { status: 'success', message: 'Workflow deleted' };
  });

  // @route   GET /api/integrations/campaigns
  // @desc    Phase 9: List Outbound Voice Campaigns & Company DNC Registry
  fastify.get('/campaigns', async (request, reply) => {
    const tenantId = await resolveIntegrationTenantId(request);
    const data = await OutboundCampaignService.listCampaignsAndDnc(tenantId);
    return { status: 'success', data };
  });

  // @route   POST /api/integrations/campaigns
  // @desc    Phase 9: Create Outbound Voice Campaign with CSV E.164 normalization, dedupe & DNC scrub
  fastify.post('/campaigns', async (request, reply) => {
    const tenantId = await resolveIntegrationTenantId(request);
    const body = (request.body || {}) as any;

    if (!body.name || !body.csvContent) {
      throw new AppError('Campaign name and csvContent are required', 400);
    }

    const campaign = await OutboundCampaignService.createCampaignWithCsv(tenantId, body);
    return { status: 'success', data: campaign };
  });

  // @route   POST /api/integrations/campaigns/:campaignId/dial
  // @desc    Phase 9: Run concurrency-limited dialer batch & disposition/retry engine
  fastify.post('/campaigns/:campaignId/dial', async (request, reply) => {
    const tenantId = await resolveIntegrationTenantId(request);
    const { campaignId } = request.params as { campaignId: string };
    const body = (request.body || {}) as { forceDispositions?: any[] };

    const result = await OutboundCampaignService.runDialerBatch(tenantId, campaignId, body);
    return { status: 'success', data: result };
  });

  // @route   POST /api/integrations/campaigns/dnc
  // @desc    Phase 9: Add phone to Company DNC Registry (verbal, dtmf, manual) & auto-scrub active queues
  fastify.post('/campaigns/dnc', async (request, reply) => {
    const tenantId = await resolveIntegrationTenantId(request);
    const body = (request.body || {}) as {
      phone?: string;
      source?: 'verbal' | 'dtmf' | 'manual';
      reason?: string;
    };

    if (!body.phone) {
      throw new AppError('Phone number is required for DNC registration', 400);
    }

    const result = await OutboundCampaignService.addDncEntry(tenantId, {
      phone: body.phone,
      source: body.source || 'manual',
      reason: body.reason,
    });
    return { status: 'success', data: result };
  });

  // @route   DELETE /api/integrations/campaigns/dnc/:phone
  // @desc    Phase 9: Remove phone from Company DNC Registry
  fastify.delete('/campaigns/dnc/:phone', async (request, reply) => {
    const tenantId = await resolveIntegrationTenantId(request);
    const { phone } = request.params as { phone: string };
    await OutboundCampaignService.removeDncEntry(tenantId, decodeURIComponent(phone));
    return { status: 'success', message: 'Removed from Company DNC list' };
  });

  // @route   GET /api/integrations/omnichannel
  // @desc    Phase 10: List Instagram, Facebook Messenger & Mobile SDK Channel Adapter configs
  fastify.get('/omnichannel', async (request, reply) => {
    const tenantId = await resolveIntegrationTenantId(request);
    const data = await OmnichannelAdapterService.getChannelsConfig(tenantId);
    return { status: 'success', data };
  });

  // @route   POST /api/integrations/omnichannel/:channel/config
  // @desc    Phase 10: Update channel adapter configuration (Instagram / Messenger / Mobile SDK)
  fastify.post('/omnichannel/:channel/config', async (request, reply) => {
    const tenantId = await resolveIntegrationTenantId(request);
    const { channel } = request.params as { channel: OmnichannelType };
    const body = (request.body || {}) as any;

    const updated = await OmnichannelAdapterService.updateChannelConfig(tenantId, channel, body);
    return { status: 'success', data: updated };
  });

  // @route   POST /api/integrations/omnichannel/:channel/inbound
  // @desc    Phase 10: Unified Inbound Gateway & Simulator for Instagram, Messenger & Mobile SDK
  fastify.post('/omnichannel/:channel/inbound', async (request, reply) => {
    const tenantId = await resolveIntegrationTenantId(request);
    const { channel } = request.params as { channel: OmnichannelType };
    const body = (request.body || {}) as {
      senderId?: string;
      senderName?: string;
      text?: string;
      language?: string;
      metadata?: Record<string, any>;
    };

    if (!body.text) {
      throw new AppError('Message text is required', 400);
    }

    const signatureHeader =
      (request.headers['x-hub-signature-256'] as string) ||
      (request.headers['x-v3c-sdk-key'] as string) ||
      undefined;

    const result = await OmnichannelAdapterService.handleInboundChannelMessage(tenantId, {
      channel,
      senderId: body.senderId || `${channel}_user_101`,
      senderName: body.senderName || 'Customer',
      text: body.text,
      language: body.language,
      signatureHeader,
      metadata: body.metadata,
    });

    return { status: 'success', data: result };
  });

  // @route   GET /api/integrations/provisioning
  // @desc    Phase 11: Get Server 2 (KB Vector) & Server 3 (Conversations/Audit) Provisioning Topology
  fastify.get('/provisioning', async (request, reply) => {
    const tenantId = await resolveIntegrationTenantId(request);
    const data = await ServerProvisioningService.getProvisioningState(tenantId);
    return { status: 'success', data };
  });

  // @route   POST /api/integrations/provisioning/:node/config
  // @desc    Phase 11: Update Server 2 or Server 3 placement, encrypted tunnel, KMS & degraded mode policy
  fastify.post('/provisioning/:node/config', async (request, reply) => {
    const tenantId = await resolveIntegrationTenantId(request);
    const { node } = request.params as { node: ServerNodeKey };
    const body = (request.body || {}) as any;

    const updated = await ServerProvisioningService.updateNodeConfig(tenantId, node, body);
    return { status: 'success', data: updated };
  });

  // @route   POST /api/integrations/provisioning/:node/probe
  // @desc    Phase 11: Probe Server 2 / Server 3 tunnel latency & test degraded failover policy
  fastify.post('/provisioning/:node/probe', async (request, reply) => {
    const tenantId = await resolveIntegrationTenantId(request);
    const { node } = request.params as { node: ServerNodeKey };
    const body = (request.body || {}) as { simulateTunnelTimeout?: boolean };

    const result = await ServerProvisioningService.probeNodeHealth(tenantId, node, {
      simulateTunnelTimeout: Boolean(body.simulateTunnelTimeout),
    });
    return { status: 'success', data: result };
  });

  // @route   POST /api/integrations/provisioning/server3/audit-chain
  // @desc    Phase 11: Append & cryptographically verify a SHA-256 hash-chained audit record on Server 3
  fastify.post('/provisioning/server3/audit-chain', async (request, reply) => {
    const tenantId = await resolveIntegrationTenantId(request);
    const body = (request.body || {}) as {
      action?: string;
      actor?: string;
      payloadSummary?: string;
    };

    const result = await ServerProvisioningService.appendAndVerifyImmutableAudit(tenantId, {
      action: body.action || 'CONVERSATION_PII_MASKED_ARCHIVE',
      actor: body.actor || 'compliance-officer@v3c.ai',
      payloadSummary:
        body.payloadSummary || 'Archived PII-masked session transcript + voice recording to Server 3',
    });
    return { status: 'success', data: result };
  });
}
