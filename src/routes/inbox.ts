import { FastifyInstance, FastifyPluginOptions, FastifyRequest } from 'fastify';
import { randomUUID } from 'crypto';
import WebSocket from 'ws';
import prisma from '../lib/prisma';
import { protect } from '../middleware/auth';
import { parsePagination, formatPaginatedResponse } from '../utils/pagination';
import { AppError } from '../middleware/error';
import { applyTenantScope } from '../utils/tenantScope';
import { RealtimeHub } from '../services/realtime/RealtimeHub';
import { ChatService } from '../services/ai/ChatService';
import { ConversationService } from '../services/ai/ConversationService';

async function resolveSessionAndTenant(request: FastifyRequest, sessionId: number) {
  const headerTenant = request.headers['x-tenant-id'];
  const explicitTenantId = Array.isArray(headerTenant) ? headerTenant[0] : headerTenant;

  // If JWT auth header/cookie is present and request.user isn't populated yet, try protect
  if (!request.user && (request.headers.authorization || request.cookies?.token)) {
    try {
      await protect(request, {} as any);
    } catch (_) {
      // Allow fallback to x-tenant-id if provided
    }
  }

  const effectiveTenantId =
    explicitTenantId?.trim() ||
    request.user?.activeTenantId ||
    request.user?.tenantId ||
    '';

  if (!effectiveTenantId) {
    throw new AppError('Authentication or x-tenant-id header is required', 401);
  }

  const session = await prisma.visitorSession.findUnique({
    where: { id: sessionId },
    include: {
      Agent: true
    }
  });

  if (!session) {
    throw new AppError('Conversation session not found', 404);
  }

  if (session.tenantId && session.tenantId !== effectiveTenantId) {
    throw new AppError('Forbidden: Session belongs to another tenant', 403);
  }

  return { session, tenantId: session.tenantId || effectiveTenantId };
}

export default async function inboxRoutes(fastify: FastifyInstance, options: FastifyPluginOptions) {

  // @route   WS /api/inbox/ws
  // @desc    Real-time WebSocket stream for tenant escalation alerts, takeover events & live messages
  fastify.get('/ws', { websocket: true }, (connection: any, req: any) => {
    const socket: WebSocket = connection.socket || connection;
    const query = (req.query || {}) as { tenantId?: string };
    const headerTenant = req.headers?.['x-tenant-id'];
    const tenantId =
      query.tenantId?.trim() ||
      (Array.isArray(headerTenant) ? headerTenant[0] : headerTenant)?.trim() ||
      '8a123d29-99da-4db4-9141-8f6bb9b7233a';

    RealtimeHub.registerClient(tenantId, socket);
  });

  // @route   GET /api/inbox
  // @desc    Get CRM Conversation Inbox sessions with filtering & pagination
  fastify.get('/', { preHandler: protect }, async (request, reply) => {
    const user = request.user!;
    const query = request.query as any;
    const { page, limit, skip, sortBy, sortOrder } = parsePagination(request, 'createdAt', 'desc');

    const whereCondition: any = {};

    if (query.status) {
      whereCondition.conversationStatus = query.status;
    }

    if (query.channel) {
      whereCondition.channel = query.channel;
    }

    if (query.agentId) {
      whereCondition.aiAgentId = query.agentId;
    }

    if (query.fallbackOnly === 'true') {
      whereCondition.fallbackTriggered = true;
    }

    if (query.search) {
      whereCondition.OR = [
        { Lead: { some: { name: { contains: query.search, mode: 'insensitive' } } } },
        { Conversation: { some: { message: { contains: query.search, mode: 'insensitive' } } } }
      ];
    }

    const scopedWhere = applyTenantScope(whereCondition, user);

    const [sessions, total] = await Promise.all([
      prisma.visitorSession.findMany({
        where: scopedWhere,
        skip,
        take: limit,
        orderBy: { [sortBy]: sortOrder },
        include: {
          Agent: { select: { id: true, name: true, voice: true } },
          Lead: { select: { id: true, name: true, email: true, phone: true } },
          Conversation: {
            take: 1,
            orderBy: { createdAt: 'desc' },
            select: { message: true, createdAt: true, sender: true }
          },
          ConversationEvaluation: {
            take: 1,
            orderBy: { createdAt: 'desc' }
          }
        }
      }),
      prisma.visitorSession.count({ where: scopedWhere })
    ]);

    return formatPaginatedResponse(sessions, total, { page, limit });
  });

  // @route   GET /api/inbox/:sessionId
  // @desc    Get detailed conversation session with full transcript & metadata
  fastify.get('/:sessionId', { preHandler: protect }, async (request, reply) => {
    const user = request.user!;
    const sessionId = parseInt((request.params as any).sessionId);

    if (isNaN(sessionId)) {
      throw new AppError('Invalid Session ID', 400);
    }

    const session = await prisma.visitorSession.findFirst({
      where: applyTenantScope({ id: sessionId }, user),
      include: {
        Agent: true,
        Lead: true,
        Domain: true,
        User: { select: { id: true, name: true, email: true } },
        Conversation: {
          orderBy: { createdAt: 'asc' },
          include: {
            Lead: { select: { name: true } }
          }
        },
        ConversationEvaluation: {
          orderBy: { createdAt: 'desc' },
          take: 5
        },
        AiLog: {
          orderBy: { createdAt: 'desc' },
          take: 10
        }
      }
    });

    if (!session) {
      throw new AppError('Conversation session not found', 404);
    }

    return {
      status: 'success',
      data: session
    };
  });

  // @route   PUT /api/inbox/:sessionId
  // @desc    Update session CRM attributes (status, tags, notes, assignment)
  fastify.put('/:sessionId', { preHandler: protect }, async (request, reply) => {
    const user = request.user!;
    const sessionId = parseInt((request.params as any).sessionId);
    const body = request.body as any;

    if (isNaN(sessionId)) {
      throw new AppError('Invalid Session ID', 400);
    }

    const session = await prisma.visitorSession.findFirst({
      where: applyTenantScope({ id: sessionId }, user)
    });

    if (!session) {
      throw new AppError('Session not found', 404);
    }

    const updated = await prisma.visitorSession.update({
      where: { id: sessionId },
      data: {
        conversationStatus: body.status || session.conversationStatus,
        tags: body.tags || session.tags,
        humanNotes: body.humanNotes !== undefined ? body.humanNotes : session.humanNotes,
        assignedUserId: body.assignedUserId !== undefined ? body.assignedUserId : session.assignedUserId,
        escalated: body.escalated !== undefined ? Boolean(body.escalated) : session.escalated,
        updatedAt: new Date()
      }
    });

    return {
      status: 'success',
      data: updated
    };
  });

  // @route   POST /api/inbox/:sessionId/takeover
  // @desc    Switch session from AI control to Live Human Takeover (status = 'HUMAN')
  fastify.post('/:sessionId/takeover', async (request, reply) => {
    const sessionId = parseInt((request.params as any).sessionId, 10);
    if (isNaN(sessionId)) {
      throw new AppError('Invalid Session ID', 400);
    }

    const { session, tenantId } = await resolveSessionAndTenant(request, sessionId);

    const updated = await prisma.visitorSession.update({
      where: { id: session.id },
      data: {
        status: 'HUMAN',
        escalated: true,
        conversationStatus: 'escalated',
        updatedAt: new Date()
      }
    });

    RealtimeHub.broadcast(tenantId, 'session_takeover', {
      sessionId: updated.id,
      status: updated.status,
      conversationStatus: updated.conversationStatus
    });

    return {
      status: 'success',
      data: updated,
      message: 'Human takeover activated; AI is now in silent-listener mode.'
    };
  });

  // @route   POST /api/inbox/:sessionId/handback
  // @desc    Hand conversation back to AI control (status = 'AI')
  fastify.post('/:sessionId/handback', async (request, reply) => {
    const sessionId = parseInt((request.params as any).sessionId, 10);
    if (isNaN(sessionId)) {
      throw new AppError('Invalid Session ID', 400);
    }

    const { session, tenantId } = await resolveSessionAndTenant(request, sessionId);

    const updated = await prisma.visitorSession.update({
      where: { id: session.id },
      data: {
        status: 'AI',
        escalated: false,
        conversationStatus: 'open',
        updatedAt: new Date()
      }
    });

    RealtimeHub.broadcast(tenantId, 'session_handback', {
      sessionId: updated.id,
      status: updated.status,
      conversationStatus: updated.conversationStatus
    });

    return {
      status: 'success',
      data: updated,
      message: 'Session handed back to AI assistant.'
    };
  });

  // @route   POST /api/inbox/:sessionId/reply
  // @desc    Send a direct human agent reply in the session transcript
  fastify.post('/:sessionId/reply', async (request, reply) => {
    const sessionId = parseInt((request.params as any).sessionId, 10);
    if (isNaN(sessionId)) {
      throw new AppError('Invalid Session ID', 400);
    }

    const body = (request.body || {}) as { message?: string };
    if (!body.message || !body.message.trim()) {
      throw new AppError('Reply message text is required', 400);
    }

    const { session, tenantId } = await resolveSessionAndTenant(request, sessionId);

    // Ensure an agentId exists for Conversation FK
    let agentId = session.aiAgentId;
    if (!agentId) {
      const fallbackAgent = await prisma.agent.findFirst({ where: { tenantId } });
      agentId = fallbackAgent?.id || null;
    }

    if (!agentId) {
      throw new AppError('No agent configured for this tenant session', 400);
    }

    await ConversationService.saveMessage({
      tenantId,
      agentId,
      sessionId: session.id,
      visitorId: session.visitorId,
      sender: 'human_agent',
      message: body.message.trim()
    });

    return {
      status: 'success',
      data: {
        sessionId: session.id,
        sender: 'human_agent',
        message: body.message.trim(),
        createdAt: new Date().toISOString()
      }
    };
  });

  // @route   POST /api/inbox/:sessionId/suggest
  // @desc    Generate an AI silent-listener suggested reply for the human operator
  fastify.post('/:sessionId/suggest', async (request, reply) => {
    const sessionId = parseInt((request.params as any).sessionId, 10);
    if (isNaN(sessionId)) {
      throw new AppError('Invalid Session ID', 400);
    }

    const { session, tenantId } = await resolveSessionAndTenant(request, sessionId);
    const result = await ChatService.generateSilentSuggestion(session.id, tenantId);

    return {
      status: 'success',
      data: result
    };
  });

  // @route   GET /api/inbox/:sessionId/csat
  // @desc    Get CSAT evaluations for a conversation session
  fastify.get('/:sessionId/csat', async (request, reply) => {
    const sessionId = parseInt((request.params as any).sessionId, 10);
    if (isNaN(sessionId)) {
      throw new AppError('Invalid Session ID', 400);
    }

    const { session, tenantId } = await resolveSessionAndTenant(request, sessionId);

    const evaluations = await prisma.conversationEvaluation.findMany({
      where: { visitorSessionId: session.id, tenantId },
      orderBy: { createdAt: 'desc' }
    });

    return {
      status: 'success',
      data: evaluations
    };
  });

  // @route   POST /api/inbox/:sessionId/csat
  // @desc    Submit CSAT rating (1-5) and feedback for a conversation session
  fastify.post('/:sessionId/csat', async (request, reply) => {
    const sessionId = parseInt((request.params as any).sessionId, 10);
    if (isNaN(sessionId)) {
      throw new AppError('Invalid Session ID', 400);
    }

    const body = (request.body || {}) as {
      rating?: number;
      customerSatisfaction?: number;
      resolutionQuality?: number;
      answerRelevance?: number;
      feedback?: string;
    };

    const rating = Number(body.rating ?? body.customerSatisfaction);
    if (isNaN(rating) || rating < 1 || rating > 5) {
      throw new AppError('rating (or customerSatisfaction) must be a number between 1 and 5', 400);
    }

    const { session, tenantId } = await resolveSessionAndTenant(request, sessionId);

    const resQuality = body.resolutionQuality !== undefined ? Number(body.resolutionQuality) : rating;
    const ansRelevance = body.answerRelevance !== undefined ? Number(body.answerRelevance) : rating;
    const overallScore = Number(((rating + resQuality + ansRelevance) / 3).toFixed(2));

    const evaluation = await prisma.conversationEvaluation.create({
      data: {
        id: randomUUID(),
        visitorSessionId: session.id,
        tenantId,
        customerSatisfaction: rating,
        resolutionQuality: resQuality,
        answerRelevance: ansRelevance,
        overallScore,
        feedback: body.feedback ? body.feedback.trim() : null
      }
    });

    RealtimeHub.broadcast(tenantId, 'csat_submitted', {
      sessionId: session.id,
      evaluation
    });

    return {
      status: 'success',
      data: evaluation
    };
  });
}
