import { FastifyInstance, FastifyPluginOptions, FastifyRequest, FastifyReply } from 'fastify';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import prisma from '../lib/prisma';
import { protect } from '../middleware/auth';
import { applyTenantScope } from '../utils/tenantScope';
import { TenantConfigCache } from '../services/cache/TenantConfigCache';
import { EscalationService } from '../services/escalation/EscalationService';
import { DocumentProcessorService } from '../services/kb/DocumentProcessorService';

export const VALID_AGENT_TYPES = ['primary', 'sales', 'support', 'complaint', 'general'] as const;
export type AgentType = typeof VALID_AGENT_TYPES[number];

function getTenantId(req: FastifyRequest): string {
  const headerVal = req.headers['x-tenant-id'];
  const tenantId = Array.isArray(headerVal) ? headerVal[0] : headerVal;
  if (!tenantId || tenantId.trim() === '') {
    console.warn('[DASHBOARD] x-tenant-id header missing; falling back to 8a123d29-99da-4db4-9141-8f6bb9b7233a');
    return '8a123d29-99da-4db4-9141-8f6bb9b7233a';
  }
  return tenantId.trim();
}

export default async function dashboardRoutes(fastify: FastifyInstance, options: FastifyPluginOptions) {

  // @route   GET /api/dashboard/stats
  // @desc    Get dashboard metrics (conversations, active agents, leads, quota usage)
  fastify.get('/stats', { preHandler: protect }, async (request, reply) => {
    const user = request.user!;

    // 1. Get counts from DB scoped to tenant hierarchy
    const [conversationsCount, activeAgentsCount, leadsCount] = await Promise.all([
      prisma.conversation.count({ where: applyTenantScope({}, user) }),
      prisma.agent.count({ where: applyTenantScope({ isActive: true }, user) }),
      prisma.lead.count({ where: applyTenantScope({}, user) })
    ]);

    // 2. Get active subscription plan profile
    const subscription = await prisma.adminProfile.findFirst({
      where: applyTenantScope({}, user),
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
    const user = request.user!;

    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    thirtyDaysAgo.setHours(0, 0, 0, 0);

    // Fetch conversation times for the past 30 days scoped to hierarchy
    const conversations = await prisma.conversation.findMany({
      where: applyTenantScope({
        createdAt: {
          gte: thirtyDaysAgo
        }
      }, user),
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

  // @route   GET /api/dashboard/agents
  // @desc    List all agents belonging to the tenant
  fastify.get('/agents', async (request: FastifyRequest, reply: FastifyReply) => {
    const tenantId = getTenantId(request);
    const agents = await prisma.agent.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'desc' }
    });
    return {
      status: 'success',
      data: agents
    };
  });

  // @route   POST /api/dashboard/agents
  // @desc    Create a new tenant-specific agent
  fastify.post('/agents', async (request: FastifyRequest, reply: FastifyReply) => {
    const tenantId = getTenantId(request);
    const body = (request.body as any) || {};
    const { name, type, systemPrompt, isActive = true, isDefault = false, description, voice, language } = body;

    if (!name || typeof name !== 'string' || name.trim() === '') {
      return reply.status(400).send({
        status: 'error',
        message: 'Name is required'
      });
    }

    if (!type || !VALID_AGENT_TYPES.includes(type)) {
      return reply.status(400).send({
        status: 'error',
        message: `Invalid type. Must be one of: ${VALID_AGENT_TYPES.join(', ')}`
      });
    }

    if (!systemPrompt || typeof systemPrompt !== 'string' || systemPrompt.trim() === '') {
      return reply.status(400).send({
        status: 'error',
        message: 'systemPrompt is required'
      });
    }

    const isDefaultBool = Boolean(isDefault);
    const isActiveBool = isActive === undefined ? true : Boolean(isActive);

    let validatedKbId: string | null = null;
    if (body.knowledgeBaseId) {
      const kb = await prisma.knowledgeBase.findUnique({
        where: { id: body.knowledgeBaseId }
      });
      if (!kb) {
        return reply.status(404).send({
          status: 'error',
          message: 'Knowledge base not found'
        });
      }
      if (kb.tenantId !== tenantId) {
        return reply.status(403).send({
          status: 'error',
          message: 'Forbidden: Cannot link agent to a Knowledge base belonging to another tenant'
        });
      }
      validatedKbId = kb.id;
    }

    const newAgent = await prisma.$transaction(async (tx) => {
      if (isDefaultBool) {
        await tx.agent.updateMany({
          where: { tenantId },
          data: { isDefault: false }
        });
      }

      return tx.agent.create({
        data: {
          id: randomUUID(),
          name: name.trim(),
          tenantId,
          type,
          systemPrompt: systemPrompt.trim(),
          description: description || null,
          voice: voice || 'alloy',
          language: language || 'English',
          isActive: isActiveBool,
          isDefault: isDefaultBool,
          knowledgeBaseId: validatedKbId,
          updatedAt: new Date()
        }
      });
    });

    TenantConfigCache.invalidate(tenantId);

    return reply.status(200).send({
      status: 'success',
      data: newAgent
    });
  });

  // @route   PATCH /api/dashboard/agents/:id
  // @desc    Update an existing agent
  fastify.patch('/agents/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    const tenantId = getTenantId(request);
    const { id } = request.params as { id: string };
    const body = (request.body as any) || {};

    const existingAgent = await prisma.agent.findUnique({
      where: { id }
    });

    if (!existingAgent) {
      return reply.status(404).send({
        status: 'error',
        message: 'Agent not found'
      });
    }

    if (existingAgent.tenantId !== tenantId) {
      return reply.status(403).send({
        status: 'error',
        message: 'Forbidden: Cannot modify an agent belonging to another tenant'
      });
    }

    if (body.type !== undefined && !VALID_AGENT_TYPES.includes(body.type)) {
      return reply.status(400).send({
        status: 'error',
        message: `Invalid type. Must be one of: ${VALID_AGENT_TYPES.join(', ')}`
      });
    }

    const updateData: any = {};
    if (body.name !== undefined) updateData.name = String(body.name).trim();
    if (body.type !== undefined) updateData.type = body.type;
    if (body.systemPrompt !== undefined) updateData.systemPrompt = String(body.systemPrompt).trim();
    if (body.isActive !== undefined) updateData.isActive = Boolean(body.isActive);
    if (body.description !== undefined) updateData.description = body.description;
    if (body.voice !== undefined) updateData.voice = body.voice;
    if (body.language !== undefined) updateData.language = body.language;

    if (body.knowledgeBaseId !== undefined) {
      if (body.knowledgeBaseId === null || body.knowledgeBaseId === '') {
        updateData.knowledgeBaseId = null;
      } else {
        const kb = await prisma.knowledgeBase.findUnique({
          where: { id: body.knowledgeBaseId }
        });
        if (!kb) {
          return reply.status(404).send({
            status: 'error',
            message: 'Knowledge base not found'
          });
        }
        if (kb.tenantId !== tenantId) {
          return reply.status(403).send({
            status: 'error',
            message: 'Forbidden: Cannot link to a Knowledge base belonging to another tenant'
          });
        }
        updateData.knowledgeBaseId = body.knowledgeBaseId;
      }
    }

    const willBeDefault = body.isDefault !== undefined ? Boolean(body.isDefault) : false;

    let updatedAgent;
    if (willBeDefault) {
      updatedAgent = await prisma.$transaction(async (tx) => {
        await tx.agent.updateMany({
          where: { tenantId },
          data: { isDefault: false }
        });
        return tx.agent.update({
          where: { id },
          data: {
            ...updateData,
            isDefault: true,
            updatedAt: new Date()
          }
        });
      });
    } else {
      if (body.isDefault !== undefined) {
        updateData.isDefault = Boolean(body.isDefault);
      }
      updateData.updatedAt = new Date();
      updatedAgent = await prisma.agent.update({
        where: { id },
        data: updateData
      });
    }

    TenantConfigCache.invalidate(tenantId);

    return reply.status(200).send({
      status: 'success',
      data: updatedAgent
    });
  });

  // @route   DELETE /api/dashboard/agents/:id
  // @desc    Soft-delete / deactivate an agent
  fastify.delete('/agents/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    const tenantId = getTenantId(request);
    const { id } = request.params as { id: string };

    const existingAgent = await prisma.agent.findUnique({
      where: { id }
    });

    if (!existingAgent) {
      return reply.status(404).send({
        status: 'error',
        message: 'Agent not found'
      });
    }

    if (existingAgent.tenantId !== tenantId) {
      return reply.status(403).send({
        status: 'error',
        message: 'Forbidden: Cannot delete an agent belonging to another tenant'
      });
    }

    await prisma.agent.update({
      where: { id },
      data: {
        isActive: false,
        updatedAt: new Date()
      }
    });

    TenantConfigCache.invalidate(tenantId);

    return reply.status(200).send({
      status: 'success',
      message: 'Agent deactivated'
    });
  });

  // @route   GET /api/dashboard/escalations
  // @desc    List all escalation tickets for the tenant
  fastify.get('/escalations', async (request: FastifyRequest, reply: FastifyReply) => {
    const tenantId = getTenantId(request);
    const escalations = await EscalationService.getEscalations(tenantId);
    return {
      status: 'success',
      data: escalations
    };
  });

  // @route   PATCH /api/dashboard/escalations/:id
  // @desc    Update an escalation ticket status and notes
  fastify.patch('/escalations/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    const tenantId = getTenantId(request);
    const { id } = request.params as { id: string };
    const body = (request.body as any) || {};
    const { status, notes } = body;

    const VALID_ESCALATION_STATUSES = ['pending', 'in_progress', 'resolved'] as const;

    if (status !== undefined && !VALID_ESCALATION_STATUSES.includes(status)) {
      return reply.status(400).send({
        status: 'error',
        message: `Invalid status. Must be one of: ${VALID_ESCALATION_STATUSES.join(', ')}`
      });
    }

    const updated = await EscalationService.updateEscalationStatus(id, tenantId, status, notes);

    return reply.status(200).send({
      status: 'success',
      data: updated
    });
  });

  // @route   GET /api/dashboard/knowledge-bases
  // @desc    List all knowledge bases for the tenant
  fastify.get('/knowledge-bases', async (request: FastifyRequest, reply: FastifyReply) => {
    const tenantId = getTenantId(request);
    const kbs = await prisma.knowledgeBase.findMany({
      where: { tenantId },
      include: {
        _count: {
          select: { documents: true, agents: true }
        }
      },
      orderBy: { createdAt: 'desc' }
    });
    return {
      status: 'success',
      data: kbs
    };
  });

  // @route   POST /api/dashboard/knowledge-bases
  // @desc    Create a new knowledge base for the tenant
  fastify.post('/knowledge-bases', async (request: FastifyRequest, reply: FastifyReply) => {
    const tenantId = getTenantId(request);
    const body = (request.body as any) || {};
    const { name, description } = body;

    if (!name || typeof name !== 'string' || name.trim() === '') {
      return reply.status(400).send({
        status: 'error',
        message: 'Name is required'
      });
    }

    const newKb = await prisma.knowledgeBase.create({
      data: {
        id: randomUUID(),
        name: name.trim(),
        description: description ? String(description).trim() : null,
        tenantId,
        updatedAt: new Date()
      }
    });

    return reply.status(201).send({
      status: 'success',
      data: newKb
    });
  });

  // @route   PATCH /api/dashboard/knowledge-bases/:id
  // @desc    Update a knowledge base
  fastify.patch('/knowledge-bases/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    const tenantId = getTenantId(request);
    const { id } = request.params as { id: string };
    const body = (request.body as any) || {};

    const existingKb = await prisma.knowledgeBase.findUnique({
      where: { id }
    });

    if (!existingKb) {
      return reply.status(404).send({
        status: 'error',
        message: 'Knowledge base not found'
      });
    }

    if (existingKb.tenantId !== tenantId) {
      return reply.status(403).send({
        status: 'error',
        message: 'Forbidden: Cannot modify a Knowledge base belonging to another tenant'
      });
    }

    const updateData: any = { updatedAt: new Date() };
    if (body.name !== undefined) updateData.name = String(body.name).trim();
    if (body.description !== undefined) updateData.description = body.description ? String(body.description).trim() : null;

    const updatedKb = await prisma.knowledgeBase.update({
      where: { id },
      data: updateData
    });

    return reply.status(200).send({
      status: 'success',
      data: updatedKb
    });
  });

  // @route   DELETE /api/dashboard/knowledge-bases/:id
  // @desc    Delete a knowledge base
  fastify.delete('/knowledge-bases/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    const tenantId = getTenantId(request);
    const { id } = request.params as { id: string };

    const existingKb = await prisma.knowledgeBase.findUnique({
      where: { id }
    });

    if (!existingKb) {
      return reply.status(404).send({
        status: 'error',
        message: 'Knowledge base not found'
      });
    }

    if (existingKb.tenantId !== tenantId) {
      return reply.status(403).send({
        status: 'error',
        message: 'Forbidden: Cannot delete a Knowledge base belonging to another tenant'
      });
    }

    await prisma.knowledgeBase.delete({
      where: { id }
    });

    return reply.status(200).send({
      status: 'success',
      message: 'Knowledge base deleted'
    });
  });

  // @route   POST /api/dashboard/knowledge-bases/:kbId/documents
  // @desc    Add a content source document to a knowledge base
  fastify.post('/knowledge-bases/:kbId/documents', async (request: FastifyRequest, reply: FastifyReply) => {
    const tenantId = getTenantId(request);
    const { kbId } = request.params as { kbId: string };
    const body = (request.body as any) || {};
    const { type = 'url', source } = body;

    const existingKb = await prisma.knowledgeBase.findUnique({
      where: { id: kbId }
    });

    if (!existingKb) {
      return reply.status(404).send({
        status: 'error',
        message: 'Knowledge base not found'
      });
    }

    if (existingKb.tenantId !== tenantId) {
      return reply.status(403).send({
        status: 'error',
        message: 'Forbidden: Cannot add documents to a Knowledge base belonging to another tenant'
      });
    }

    if (!source || typeof source !== 'string' || source.trim() === '') {
      return reply.status(400).send({
        status: 'error',
        message: 'Source content/URL is required'
      });
    }

    const VALID_DOC_TYPES = ['url', 'text', 'txt', 'pdf'] as const;
    if (!VALID_DOC_TYPES.includes(type)) {
      return reply.status(400).send({
        status: 'error',
        message: `Invalid document type. Must be one of: ${VALID_DOC_TYPES.join(', ')}`
      });
    }

    const document = await prisma.document.create({
      data: {
        id: randomUUID(),
        kbId,
        type,
        source: source.trim(),
        status: 'pending',
        createdAt: new Date()
      }
    });

    return reply.status(201).send({
      status: 'success',
      data: document
    });
  });

  // @route   POST /api/dashboard/knowledge-bases/:kbId/documents/upload
  // @desc    Upload a Base64-encoded file (txt or pdf) to a knowledge base
  fastify.post('/knowledge-bases/:kbId/documents/upload', async (request: FastifyRequest, reply: FastifyReply) => {
    const tenantId = getTenantId(request);
    const { kbId } = request.params as { kbId: string };
    const body = (request.body as any) || {};
    const { filename, type, content } = body;

    const existingKb = await prisma.knowledgeBase.findUnique({
      where: { id: kbId }
    });

    if (!existingKb) {
      return reply.status(404).send({
        status: 'error',
        message: 'Knowledge base not found'
      });
    }

    if (existingKb.tenantId !== tenantId) {
      return reply.status(403).send({
        status: 'error',
        message: 'Forbidden: Cannot upload documents to a Knowledge base belonging to another tenant'
      });
    }

    if (!filename || typeof filename !== 'string' || filename.trim() === '') {
      return reply.status(400).send({
        status: 'error',
        message: 'filename is required'
      });
    }

    const VALID_UPLOAD_TYPES = ['txt', 'pdf'] as const;
    if (!type || !VALID_UPLOAD_TYPES.includes(type)) {
      return reply.status(400).send({
        status: 'error',
        message: `Invalid file type. Must be one of: ${VALID_UPLOAD_TYPES.join(', ')}`
      });
    }

    if (!content || typeof content !== 'string' || content.trim() === '') {
      return reply.status(400).send({
        status: 'error',
        message: 'content (base64 encoded file content) is required'
      });
    }

    const uploadsDir = path.resolve(__dirname, '../../uploads');
    await fs.promises.mkdir(uploadsDir, { recursive: true });

    const safeFilename = path.basename(filename.trim());
    const storedFileName = `${tenantId}_${kbId}_${safeFilename}`;
    const absoluteFilePath = path.join(uploadsDir, storedFileName);

    const base64Data = content.includes(';base64,') ? content.split(';base64,').pop()! : content.trim();
    const fileBuffer = Buffer.from(base64Data, 'base64');
    await fs.promises.writeFile(absoluteFilePath, fileBuffer);

    const document = await prisma.document.create({
      data: {
        id: randomUUID(),
        kbId,
        type,
        source: absoluteFilePath,
        status: 'pending',
        createdAt: new Date()
      }
    });

    return reply.status(200).send({
      status: 'success',
      documentId: document.id,
      message: 'File uploaded successfully'
    });
  });

  // @route   GET /api/dashboard/knowledge-bases/:kbId/documents
  // @desc    List all documents for a knowledge base
  fastify.get('/knowledge-bases/:kbId/documents', async (request: FastifyRequest, reply: FastifyReply) => {
    const tenantId = getTenantId(request);
    const { kbId } = request.params as { kbId: string };

    const existingKb = await prisma.knowledgeBase.findUnique({
      where: { id: kbId }
    });

    if (!existingKb) {
      return reply.status(404).send({
        status: 'error',
        message: 'Knowledge base not found'
      });
    }

    if (existingKb.tenantId !== tenantId) {
      return reply.status(403).send({
        status: 'error',
        message: 'Forbidden: Cannot view documents for a Knowledge base belonging to another tenant'
      });
    }

    const documents = await prisma.document.findMany({
      where: { kbId },
      orderBy: { createdAt: 'desc' }
    });

    return reply.status(200).send({
      status: 'success',
      data: documents
    });
  });

  // @route   POST /api/dashboard/knowledge-bases/:kbId/documents/:documentId/process
  // @desc    Trigger processing of a document (chunking, embedding, saving)
  fastify.post('/knowledge-bases/:kbId/documents/:documentId/process', async (request: FastifyRequest, reply: FastifyReply) => {
    const tenantId = getTenantId(request);
    const { kbId, documentId } = request.params as { kbId: string; documentId: string };

    const existingKb = await prisma.knowledgeBase.findUnique({
      where: { id: kbId }
    });

    if (!existingKb) {
      return reply.status(404).send({
        status: 'error',
        message: 'Knowledge base not found'
      });
    }

    if (existingKb.tenantId !== tenantId) {
      return reply.status(403).send({
        status: 'error',
        message: 'Forbidden: Cannot process documents for a Knowledge base belonging to another tenant'
      });
    }

    try {
      await DocumentProcessorService.processDocument(documentId, tenantId);
      const updatedDoc = await prisma.document.findUnique({
        where: { id: documentId }
      });

      if (updatedDoc?.status === 'failed' && updatedDoc?.type === 'pdf') {
        return reply.status(200).send({
          status: 'failed',
          documentStatus: 'failed',
          message: 'No text extracted from PDF',
          note: 'No text extracted from PDF'
        });
      }

      return reply.status(200).send({
        status: 'success',
        documentStatus: updatedDoc?.status || 'ready',
        message: 'Document processing initiated'
      });
    } catch (err: any) {
      const statusCode = err.statusCode || (err.message?.includes('Forbidden') ? 403 : 500);
      return reply.status(statusCode).send({
        status: 'error',
        message: err.message || 'Internal server error while processing document'
      });
    }
  });

  // @route   GET /api/dashboard/usage
  // @desc    Get monthly LLM token usage breakdown per model and agent for the tenant
  fastify.get('/usage', async (request: FastifyRequest, reply: FastifyReply) => {
    const headerVal = request.headers['x-tenant-id'];
    const rawHeaderTenantId = Array.isArray(headerVal) ? headerVal[0] : headerVal;
    const tenantId = rawHeaderTenantId && rawHeaderTenantId.trim() !== ''
      ? rawHeaderTenantId.trim()
      : getTenantId(request);

    if (request.user?.tenantId && request.user.tenantId !== tenantId) {
      return reply.status(403).send({
        status: 'error',
        message: 'Forbidden: Tenant mismatch'
      });
    }

    const existingTenant = await prisma.tenant.findUnique({
      where: { id: tenantId }
    });

    if (!existingTenant) {
      return reply.status(403).send({
        status: 'error',
        message: 'Forbidden: Invalid or unauthorized tenant ID'
      });
    }

    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);

    const usage = await prisma.usage.groupBy({
      by: ['model', 'agentId'],
      where: {
        tenantId,
        createdAt: { gte: startOfMonth }
      },
      _sum: {
        promptTokens: true,
        completionTokens: true,
        totalTokens: true
      }
    });

    const totalTokens = usage.reduce((sum, item) => sum + (item._sum.totalTokens || 0), 0);

    return reply.status(200).send({
      status: 'success',
      data: {
        totalTokens,
        breakdown: usage
      }
    });
  });
}
