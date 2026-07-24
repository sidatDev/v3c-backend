import { FastifyInstance, FastifyPluginOptions } from 'fastify';
import { randomUUID } from 'crypto';
import prisma from '../lib/prisma';
import { protect } from '../middleware/auth';
import { AppError } from '../middleware/error';
import { TenantConfigCache } from '../services/cache/TenantConfigCache';

export default async function agentsRoutes(fastify: FastifyInstance, options: FastifyPluginOptions) {

  // @route   GET /api/agents
  // @desc    List all agents for tenant
  fastify.get('/', { preHandler: protect }, async (request, reply) => {
    const tenantId = request.user!.tenantId;
    if (!tenantId) {
      return { status: 'success', data: [] };
    }

    const agents = await prisma.agent.findMany({
      where: { tenantId },
      include: {
        RetrievalConfig: true,
        AgentTopicLink: {
          orderBy: { displayOrder: 'asc' }
        },
        Domain: {
          select: { id: true, domain: true, publicKey: true }
        }
      },
      orderBy: { createdAt: 'desc' }
    });

    return {
      status: 'success',
      data: agents
    };
  });

  // @route   GET /api/agents/:id
  // @desc    Get agent detail
  fastify.get('/:id', { preHandler: protect }, async (request, reply) => {
    const tenantId = request.user!.tenantId;
    const { id } = request.params as { id: string };

    const agent = await prisma.agent.findFirst({
      where: { id, tenantId: tenantId || undefined },
      include: {
        RetrievalConfig: true,
        AgentTopicLink: {
          orderBy: { displayOrder: 'asc' }
        },
        Domain: true
      }
    });

    if (!agent) {
      throw new AppError('Agent not found', 404);
    }

    return {
      status: 'success',
      data: agent
    };
  });

  // @route   POST /api/agents
  // @desc    Create a new AI Agent
  fastify.post('/', { preHandler: protect }, async (request, reply) => {
    const tenantId = request.user!.tenantId;
    if (!tenantId) {
      throw new AppError('Tenant required', 400);
    }

    const body = request.body as any;
    const agentId = randomUUID();

    const agent = await prisma.agent.create({
      data: {
        id: agentId,
        tenantId,
        name: body.name || 'New AI Agent',
        description: body.description || null,
        voice: body.voice || 'alloy',
        language: body.language || 'English',
        systemPrompt: body.systemPrompt || 'You are an AI Virtual Customer Assistant.',
        initialGreetingMessage: body.initialGreetingMessage || 'Hi! How can I help you today?',
        defaultMode: body.defaultMode || 'VOICE',
        widgetMode: body.widgetMode || 'BOTH',
        accentColor: body.accentColor || '#4F46E5',
        speechSpeed: body.speechSpeed ?? 1.0,
        voiceStability: body.voiceStability ?? 0.5,
        voiceWarmth: body.voiceWarmth ?? 0.5,
        autoLanguageDetection: body.autoLanguageDetection ?? true,
        supportedLanguages: body.supportedLanguages || ['English'],
        isActive: body.isActive ?? true,
        updatedAt: new Date()
      }
    });

    // Auto-create default RetrievalConfig for agent
    await prisma.retrievalConfig.create({
      data: {
        agentId,
        tenantId,
        similarityThreshold: 0.3,
        topK: 5,
        maxContextTokens: 1000,
        fallbackMode: 'topic_suggestion',
        fallbackMessage: 'I can only answer questions about our services. Here are some topics I can help with:',
        fallbackMessageUrdu: 'میں صرف ہماری خدمات کے بارے میں سوالات کا جواب دے سکتا ہوں۔',
        maxTopicLinks: 5
      }
    });

    TenantConfigCache.invalidate(tenantId);

    return {
      status: 'success',
      data: agent
    };
  });

  // @route   PUT /api/agents/:id
  // @desc    Update agent profile & settings
  fastify.put('/:id', { preHandler: protect }, async (request, reply) => {
    const tenantId = request.user!.tenantId;
    const { id } = request.params as { id: string };
    const body = request.body as any;

    const existing = await prisma.agent.findFirst({
      where: { id, tenantId: tenantId || undefined }
    });

    if (!existing) {
      throw new AppError('Agent not found', 404);
    }

    const updated = await prisma.agent.update({
      where: { id },
      data: {
        name: body.name !== undefined ? body.name : existing.name,
        description: body.description !== undefined ? body.description : existing.description,
        voice: body.voice !== undefined ? body.voice : existing.voice,
        language: body.language !== undefined ? body.language : existing.language,
        systemPrompt: body.systemPrompt !== undefined ? body.systemPrompt : existing.systemPrompt,
        initialGreetingMessage: body.initialGreetingMessage !== undefined ? body.initialGreetingMessage : existing.initialGreetingMessage,
        defaultMode: body.defaultMode !== undefined ? body.defaultMode : existing.defaultMode,
        widgetMode: body.widgetMode !== undefined ? body.widgetMode : existing.widgetMode,
        accentColor: body.accentColor !== undefined ? body.accentColor : existing.accentColor,
        speechSpeed: body.speechSpeed !== undefined ? Number(body.speechSpeed) : existing.speechSpeed,
        voiceStability: body.voiceStability !== undefined ? Number(body.voiceStability) : existing.voiceStability,
        voiceWarmth: body.voiceWarmth !== undefined ? Number(body.voiceWarmth) : existing.voiceWarmth,
        autoLanguageDetection: body.autoLanguageDetection !== undefined ? Boolean(body.autoLanguageDetection) : existing.autoLanguageDetection,
        supportedLanguages: body.supportedLanguages !== undefined ? body.supportedLanguages : existing.supportedLanguages,
        voiceSettings: body.voiceSettings !== undefined ? body.voiceSettings : existing.voiceSettings,
        isActive: body.isActive !== undefined ? Boolean(body.isActive) : existing.isActive,
        updatedAt: new Date()
      }
    });

    if (tenantId) TenantConfigCache.invalidate(tenantId);

    return {
      status: 'success',
      data: updated
    };
  });

  // @route   DELETE /api/agents/:id
  // @desc    Delete agent
  fastify.delete('/:id', { preHandler: protect }, async (request, reply) => {
    const tenantId = request.user!.tenantId;
    const { id } = request.params as { id: string };

    const existing = await prisma.agent.findFirst({
      where: { id, tenantId: tenantId || undefined }
    });

    if (!existing) {
      throw new AppError('Agent not found', 404);
    }

    await prisma.agent.delete({ where: { id } });
    if (tenantId) TenantConfigCache.invalidate(tenantId);

    return {
      status: 'success',
      message: 'Agent deleted successfully'
    };
  });

  // @route   GET /api/agents/:id/retrieval-config
  // @desc    Get retrieval configuration for agent
  fastify.get('/:id/retrieval-config', { preHandler: protect }, async (request, reply) => {
    const tenantId = request.user!.tenantId;
    const { id: agentId } = request.params as { id: string };

    let config = await prisma.retrievalConfig.findUnique({
      where: { agentId }
    });

    if (!config && tenantId) {
      config = await prisma.retrievalConfig.create({
        data: {
          agentId,
          tenantId,
          similarityThreshold: 0.3,
          topK: 5,
          maxContextTokens: 1000,
          fallbackMode: 'topic_suggestion',
          fallbackMessage: 'I can only answer questions about our services. Here are some topics I can help with:',
          fallbackMessageUrdu: 'میں صرف ہماری خدمات کے بارے میں سوالات کا جواب دے سکتا ہوں۔',
          maxTopicLinks: 5
        }
      });
    }

    return {
      status: 'success',
      data: config
    };
  });

  // @route   PUT /api/agents/:id/retrieval-config
  // @desc    Update retrieval configuration for agent
  fastify.put('/:id/retrieval-config', { preHandler: protect }, async (request, reply) => {
    const tenantId = request.user!.tenantId;
    const { id: agentId } = request.params as { id: string };
    const body = request.body as any;

    const config = await prisma.retrievalConfig.upsert({
      where: { agentId },
      create: {
        agentId,
        tenantId: tenantId!,
        similarityThreshold: body.similarityThreshold !== undefined ? Number(body.similarityThreshold) : 0.3,
        topK: body.topK !== undefined ? Number(body.topK) : 5,
        maxContextTokens: body.maxContextTokens !== undefined ? Number(body.maxContextTokens) : 1000,
        chunkSize: body.chunkSize !== undefined ? Number(body.chunkSize) : 800,
        chunkOverlap: body.chunkOverlap !== undefined ? Number(body.chunkOverlap) : 100,
        fallbackMode: body.fallbackMode || 'topic_suggestion',
        fallbackMessage: body.fallbackMessage || 'I can only answer questions about our services.',
        fallbackMessageUrdu: body.fallbackMessageUrdu || 'میں صرف ہماری خدمات کے بارے میں سوالات کا جواب دے سکتا ہوں۔',
        maxTopicLinks: body.maxTopicLinks !== undefined ? Number(body.maxTopicLinks) : 5
      },
      update: {
        similarityThreshold: body.similarityThreshold !== undefined ? Number(body.similarityThreshold) : undefined,
        topK: body.topK !== undefined ? Number(body.topK) : undefined,
        maxContextTokens: body.maxContextTokens !== undefined ? Number(body.maxContextTokens) : undefined,
        chunkSize: body.chunkSize !== undefined ? Number(body.chunkSize) : undefined,
        chunkOverlap: body.chunkOverlap !== undefined ? Number(body.chunkOverlap) : undefined,
        fallbackMode: body.fallbackMode || undefined,
        fallbackMessage: body.fallbackMessage || undefined,
        fallbackMessageUrdu: body.fallbackMessageUrdu || undefined,
        maxTopicLinks: body.maxTopicLinks !== undefined ? Number(body.maxTopicLinks) : undefined,
        updatedAt: new Date()
      }
    });

    if (tenantId) TenantConfigCache.invalidate(tenantId);

    return {
      status: 'success',
      data: config
    };
  });

  // @route   GET /api/agents/:id/topic-links
  // @desc    Get topic links for agent
  fastify.get('/:id/topic-links', { preHandler: protect }, async (request, reply) => {
    const { id: agentId } = request.params as { id: string };

    const links = await prisma.agentTopicLink.findMany({
      where: { agentId },
      orderBy: { displayOrder: 'asc' }
    });

    return {
      status: 'success',
      data: links
    };
  });

  // @route   POST /api/agents/:id/topic-links
  // @desc    Add a topic link for agent (or bulk import from CrawledPages)
  fastify.post('/:id/topic-links', { preHandler: protect }, async (request, reply) => {
    const tenantId = request.user!.tenantId;
    const { id: agentId } = request.params as { id: string };
    const body = request.body as any;

    if (body.importFromKb) {
      // Bulk import from CrawledPage entries
      const pages = await prisma.crawledPage.findMany({
        where: { tenantId: tenantId!, enabled: true },
        take: body.limit || 5
      });

      const createdLinks = [];
      for (let i = 0; i < pages.length; i++) {
        const p = pages[i];
        const link = await prisma.agentTopicLink.create({
          data: {
            agentId,
            tenantId: tenantId!,
            crawledPageId: p.id,
            title: p.title || p.url.replace(/^https?:\/\//, ''),
            url: p.url,
            displayOrder: i,
            isActive: true
          }
        });
        createdLinks.push(link);
      }

      if (tenantId) TenantConfigCache.invalidate(tenantId);
      return { status: 'success', data: createdLinks };
    }

    if (!body.title || !body.url) {
      throw new AppError('Title and URL are required', 400);
    }

    const link = await prisma.agentTopicLink.create({
      data: {
        agentId,
        tenantId: tenantId!,
        crawledPageId: body.crawledPageId || null,
        title: body.title,
        url: body.url,
        displayOrder: body.displayOrder || 0,
        isActive: body.isActive ?? true
      }
    });

    if (tenantId) TenantConfigCache.invalidate(tenantId);

    return {
      status: 'success',
      data: link
    };
  });

  // @route   DELETE /api/agents/:id/topic-links/:linkId
  // @desc    Delete topic link
  fastify.delete('/:id/topic-links/:linkId', { preHandler: protect }, async (request, reply) => {
    const tenantId = request.user!.tenantId;
    const { linkId } = request.params as { id: string; linkId: string };

    await prisma.agentTopicLink.delete({
      where: { id: linkId }
    });

    if (tenantId) TenantConfigCache.invalidate(tenantId);

    return {
      status: 'success',
      message: 'Topic link removed'
    };
  });
}
