import { FastifyInstance, FastifyPluginOptions } from 'fastify';
import { randomBytes, randomUUID } from 'crypto';
import prisma from '../lib/prisma';
import { protect } from '../middleware/auth';
import { restrictTo } from '../middleware/rbac';
import { AppError } from '../middleware/error';
import { generateEmbedding, chunkText } from '../utils/openai';

const SEARCH_SERVICE_URL = process.env.SEARCH_SERVICE_URL || 'http://localhost:3725';

export default async function aiSearchRoutes(fastify: FastifyInstance, options: FastifyPluginOptions) {

  // Check user domain lock helper
  const getUserDomainLock = async (userId: number): Promise<number | null> => {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { domainId: true }
    });
    return user?.domainId || null;
  };

  // Helper to save custom knowledgebase text as vector chunks
  const saveCustomKbText = async (domainId: number, tenantId: string | null, text: string) => {
    const url = `custom-kb://${domainId}`;

    // 1. Delete existing page and cascade delete DocumentChunks pointing to it
    const existingPage = await prisma.crawledPage.findFirst({
      where: { domainId, url }
    });

    if (existingPage) {
      await prisma.documentChunk.deleteMany({
        where: { pageId: existingPage.id }
      });
      await prisma.crawledPage.delete({
        where: { id: existingPage.id }
      });
    }

    if (!text || text.trim().length === 0) return;

    // 2. Create special custom kb CrawledPage record
    const page = await prisma.crawledPage.create({
      data: {
        domainId,
        tenantId,
        url,
        title: 'Custom Knowledgebase',
        content: text,
        status: 'COMPLETED',
        enabled: true,
        updatedAt: new Date()
      }
    });

    // 3. Chunk and embed using openai utils
    const chunks = chunkText(text);
    for (const chunk of chunks) {
      const vector = await generateEmbedding(chunk);
      if (vector && vector.length > 0) {
        await prisma.$executeRawUnsafe(`
          INSERT INTO "DocumentChunk" ("id", "content", "embedding", "pageId", "tenantId")
          VALUES ($1, $2, $3::vector, $4, $5)
        `, 
        randomUUID(), 
        chunk, 
        JSON.stringify(vector), 
        page.id, 
        tenantId
        );
      }
    }
  };

  // @route   GET /api/ai-search
  // @desc    List all domains configured for AI Search (scoped by tenant and domain RBAC)
  fastify.get('/', { preHandler: [protect, restrictTo('ai_search', 'view')] }, async (request, reply) => {
    const tenantId = request.user!.tenantId;
    const isSuperAdmin = request.user!.role === 'super_admin';
    const userDomainLock = await getUserDomainLock(request.user!.userId);

    const whereCondition: any = {};
    if (tenantId && !isSuperAdmin) {
      whereCondition.tenantId = tenantId;
    }
    if (userDomainLock) {
      whereCondition.id = userDomainLock;
    }

    const domains = await prisma.domain.findMany({
      where: whereCondition,
      orderBy: { createdAt: 'desc' },
      include: {
        Agent: true
      }
    });

    // Populate crawl statistics (count of pages) for each domain
    const formatted = await Promise.all(domains.map(async (d) => {
      const pageCount = await prisma.crawledPage.count({
        where: { domainId: d.id }
      });

      const voiceSettings = (d.Agent?.voiceSettings as any) || {};
      const crawlLimit = voiceSettings.crawlLimit || 50;

      return {
        id: d.id,
        domain: d.domain,
        publicKey: d.publicKey,
        name: d.Agent?.name || d.domain,
        crawlLimit,
        pagesCount: pageCount,
        createdAt: d.createdAt,
        tenantId: d.tenantId
      };
    }));

    return { status: 'success', data: formatted };
  });

  // @route   GET /api/ai-search/:id
  // @desc    Get detailed configuration for a single AI Search domain
  fastify.get('/:id', { preHandler: [protect, restrictTo('ai_search', 'view')] }, async (request, reply) => {
    const tenantId = request.user!.tenantId;
    const isSuperAdmin = request.user!.role === 'super_admin';
    const id = parseInt((request.params as any).id, 10);
    const userDomainLock = await getUserDomainLock(request.user!.userId);

    if (isNaN(id)) throw new AppError('Invalid Domain ID.', 400);
    if (userDomainLock && userDomainLock !== id) {
      throw new AppError('Forbidden: You do not have access to this domain.', 403);
    }

    const domain = await prisma.domain.findUnique({
      where: { id },
      include: { Agent: true }
    });

    if (!domain || (!isSuperAdmin && tenantId && domain.tenantId !== tenantId)) {
      throw new AppError('Domain not found.', 404);
    }

    // Fetch custom knowledgebase text if exists
    const customPage = await prisma.crawledPage.findFirst({
      where: { domainId: id, url: `custom-kb://${id}` }
    });
    const customKb = customPage?.content || '';

    const voiceSettings = (domain.Agent?.voiceSettings as any) || {};
    const crawlLimit = voiceSettings.crawlLimit || 50;

    // Call standalone search service to get live crawler status
    let liveStatus = { crawlerStatus: 'IDLE', pagesCrawledCount: 0, totalPagesCount: 0, pages: [] as any[] };
    try {
      const statusRes = await fetch(`${SEARCH_SERVICE_URL}/api/crawl/status/${id}`);
      if (statusRes.ok) {
        const statusData = await statusRes.json();
        if (statusData.status === 'success') {
          liveStatus = {
            crawlerStatus: statusData.data.crawlerStatus || 'IDLE',
            pagesCrawledCount: statusData.data.pagesCrawledCount || 0,
            totalPagesCount: statusData.data.totalPagesCount || 0,
            pages: statusData.data.pages || []
          };
        }
      }
    } catch (err) {
      console.warn(`[AI SEARCH BACKEND] Failed to get live crawler status from microservice:`, err);
      // Fallback: query database directly
      const dbPages = await prisma.crawledPage.findMany({
        where: { domainId: id },
        orderBy: { url: 'asc' }
      });
      liveStatus.pages = dbPages;
    }

    return {
      status: 'success',
      data: {
        id: domain.id,
        domain: domain.domain,
        publicKey: domain.publicKey,
        privateKey: domain.privateKey,
        name: domain.Agent?.name || domain.domain,
        crawlLimit,
        customKb,
        liveStatus,
        createdAt: domain.createdAt
      }
    };
  });

  // @route   POST /api/ai-search
  // @desc    Register a new domain, generate keys, and initialize its Agent settings
  fastify.post('/', { preHandler: [protect, restrictTo('ai_search', 'manage')] }, async (request, reply) => {
    const tenantId = request.user!.tenantId;
    const userDomainLock = await getUserDomainLock(request.user!.userId);
    const { domain, name, limit, customKb } = request.body as any;

    if (!domain) throw new AppError('Website URL / Domain is required.', 400);
    if (userDomainLock) {
      throw new AppError('Forbidden: Scoped users cannot create new domains.', 403);
    }

    // Verify domain name collision
    const existing = await prisma.domain.findUnique({ where: { domain } });
    if (existing) {
      throw new AppError('Domain name is already registered.', 400);
    }

    const publicKey = `pk_live_${randomBytes(16).toString('hex')}`;
    const privateKey = `sk_live_${randomBytes(24).toString('hex')}`;

    const newDomain = await prisma.$transaction(async (tx) => {
      // 1. Create Domain record
      const d = await tx.domain.create({
        data: {
          domain,
          publicKey,
          privateKey,
          packageType: 'PRO',
          expiryDate: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
          tenantId: tenantId || null,
          updatedAt: new Date()
        }
      });

      // 2. Create linked Agent containing search settings
      await tx.agent.create({
        data: {
          id: randomUUID(),
          tenantId: tenantId || 'system',
          name: name || domain,
          voice: 'alloy',
          language: 'English',
          systemPrompt: 'You are a helpful AI search assistant. Answer questions based only on the provided contexts.',
          isActive: true,
          defaultMode: 'VOICE',
          widgetMode: 'BOTH',
          accentColor: '#4F46E5',
          launcherStyle: 'orb',
          domainId: d.id,
          voiceSettings: { crawlLimit: parseInt(limit, 10) || 50 } as any,
          updatedAt: new Date()
        }
      });

      return d;
    });

    if (customKb) {
      await saveCustomKbText(newDomain.id, tenantId, customKb);
    }

    reply.status(201);
    return { status: 'success', data: newDomain };
  });

  // @route   PUT /api/ai-search/:id
  // @desc    Update Name, Domain URL, and Crawl limit settings
  fastify.put('/:id', { preHandler: [protect, restrictTo('ai_search', 'manage')] }, async (request, reply) => {
    const tenantId = request.user!.tenantId;
    const isSuperAdmin = request.user!.role === 'super_admin';
    const id = parseInt((request.params as any).id, 10);
    const userDomainLock = await getUserDomainLock(request.user!.userId);
    const { domain, name, limit, customKb } = request.body as any;

    if (isNaN(id)) throw new AppError('Invalid Domain ID.', 400);
    if (userDomainLock && userDomainLock !== id) {
      throw new AppError('Forbidden: You do not have access to manage this domain.', 403);
    }

    const existingDomain = await prisma.domain.findUnique({
      where: { id },
      include: { Agent: true }
    });

    if (!existingDomain || (!isSuperAdmin && tenantId && existingDomain.tenantId !== tenantId)) {
      throw new AppError('Domain not found.', 404);
    }

    const updated = await prisma.$transaction(async (tx) => {
      // 1. Update Domain URL
      const d = await tx.domain.update({
        where: { id },
        data: {
          domain: domain || existingDomain.domain,
          updatedAt: new Date()
        }
      });

      // 2. Update linked Agent
      if (existingDomain.Agent) {
        const currentVoiceSettings = (existingDomain.Agent.voiceSettings as any) || {};
        await tx.agent.update({
          where: { id: existingDomain.Agent.id },
          data: {
            name: name || existingDomain.Agent.name,
            voiceSettings: {
              ...currentVoiceSettings,
              crawlLimit: parseInt(limit, 10) || currentVoiceSettings.crawlLimit || 50
            } as any,
            updatedAt: new Date()
          }
        });
      }

      return d;
    });

    if (customKb !== undefined) {
      await saveCustomKbText(id, tenantId, customKb);
    }

    return { status: 'success', data: updated };
  });

  // @route   DELETE /api/ai-search/:id
  // @desc    Delete AI Search domain configuration and all of its data
  fastify.delete('/:id', { preHandler: [protect, restrictTo('ai_search', 'manage')] }, async (request, reply) => {
    const tenantId = request.user!.tenantId;
    const isSuperAdmin = request.user!.role === 'super_admin';
    const id = parseInt((request.params as any).id, 10);
    const userDomainLock = await getUserDomainLock(request.user!.userId);

    if (isNaN(id)) throw new AppError('Invalid Domain ID.', 400);
    if (userDomainLock) {
      throw new AppError('Forbidden: Scoped users cannot delete domains.', 403);
    }

    const domain = await prisma.domain.findUnique({ where: { id } });
    if (!domain || (!isSuperAdmin && tenantId && domain.tenantId !== tenantId)) {
      throw new AppError('Domain not found.', 404);
    }

    // Explicitly delete pages (which cascade deletes chunks) to avoid foreign keys issues
    await prisma.crawledPage.deleteMany({ where: { domainId: id } });
    await prisma.domain.delete({ where: { id } });
    return { status: 'success', message: 'Domain deleted successfully.' };
  });

  // @route   POST /api/ai-search/:id/crawl
  // @desc    Trigger background crawler in search microservice
  fastify.post('/:id/crawl', { preHandler: [protect, restrictTo('ai_search', 'manage')] }, async (request, reply) => {
    const tenantId = request.user!.tenantId;
    const isSuperAdmin = request.user!.role === 'super_admin';
    const id = parseInt((request.params as any).id, 10);
    const userDomainLock = await getUserDomainLock(request.user!.userId);

    if (isNaN(id)) throw new AppError('Invalid Domain ID.', 400);
    if (userDomainLock && userDomainLock !== id) {
      throw new AppError('Forbidden: You do not have access to trigger crawls.', 403);
    }

    const domain = await prisma.domain.findUnique({
      where: { id },
      include: { Agent: true }
    });

    if (!domain || (!isSuperAdmin && tenantId && domain.tenantId !== tenantId)) {
      throw new AppError('Domain not found.', 404);
    }

    const voiceSettings = (domain.Agent?.voiceSettings as any) || {};
    const crawlLimit = voiceSettings.crawlLimit || 50;

    // Contact microservice
    try {
      const crawlRes = await fetch(`${SEARCH_SERVICE_URL}/api/crawl`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: domain.domain,
          limit: crawlLimit,
          domainId: domain.id
        })
      });

      const crawlData = await crawlRes.json();
      if (!crawlRes.ok || crawlData.status !== 'success') {
        throw new AppError(crawlData.message || 'Crawler microservice failed to trigger.', crawlRes.status);
      }

      return { status: 'success', message: 'Crawl job triggered successfully.', data: crawlData.data };
    } catch (err: any) {
      throw new AppError(err.message || 'Failed to contact crawler microservice.', 500);
    }
  });

  // @route   GET /api/ai-search/:id/crawl-status
  // @desc    Fetch live crawling status from microservice
  fastify.get('/:id/crawl-status', { preHandler: [protect, restrictTo('ai_search', 'view')] }, async (request, reply) => {
    const tenantId = request.user!.tenantId;
    const isSuperAdmin = request.user!.role === 'super_admin';
    const id = parseInt((request.params as any).id, 10);
    const userDomainLock = await getUserDomainLock(request.user!.userId);

    if (isNaN(id)) throw new AppError('Invalid Domain ID.', 400);
    if (userDomainLock && userDomainLock !== id) {
      throw new AppError('Forbidden: Access denied.', 403);
    }

    const domain = await prisma.domain.findUnique({ where: { id } });
    if (!domain || (!isSuperAdmin && tenantId && domain.tenantId !== tenantId)) {
      throw new AppError('Domain not found.', 404);
    }

    try {
      const statusRes = await fetch(`${SEARCH_SERVICE_URL}/api/crawl/status/${id}`);
      const statusData = await statusRes.json();
      return statusData;
    } catch (err: any) {
      throw new AppError(err.message || 'Failed to contact crawler microservice.', 500);
    }
  });
}
