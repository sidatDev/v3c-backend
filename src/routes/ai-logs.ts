import { FastifyInstance, FastifyPluginOptions } from 'fastify';
import prisma from '../lib/prisma';
import { protect } from '../middleware/auth';
import { parsePagination, formatPaginatedResponse } from '../utils/pagination';
import { AppError } from '../middleware/error';

export default async function aiLogsRoutes(fastify: FastifyInstance, options: FastifyPluginOptions) {

  // @route   GET /api/ai-logs
  // @desc    Get paginated AI logs for AI Observability & Audit
  fastify.get('/', { preHandler: protect }, async (request, reply) => {
    const user = request.user!;
    const query = request.query as any;
    const { page, limit, skip, sortBy, sortOrder } = parsePagination(request, 'createdAt', 'desc');

    const whereCondition: any = {};

    if (user.role === 'super_admin') {
      if (query.tenantId && query.tenantId !== 'all') {
        whereCondition.tenantId = query.tenantId;
      }
    } else {
      whereCondition.tenantId = user.tenantId;
    }

    if (query.startDate || query.endDate) {
      whereCondition.createdAt = {};
      if (query.startDate) whereCondition.createdAt.gte = new Date(query.startDate);
      if (query.endDate) whereCondition.createdAt.lte = new Date(query.endDate);
    } else if (query.period && query.period !== 'all') {
      let days = 30;
      if (query.period === '24h') days = 1;
      else if (query.period === '3d') days = 3;
      else if (query.period === '7d') days = 7;
      else if (query.period === '30d') days = 30;

      whereCondition.createdAt = { gte: new Date(Date.now() - days * 24 * 60 * 60 * 1000) };
    }

    if (query.mode) {
      whereCondition.mode = query.mode;
    }

    if (query.fallbackTriggered === 'true') {
      whereCondition.fallbackTriggered = true;
    }

    if (query.agentId) {
      whereCondition.agentId = query.agentId;
    }

    if (query.search) {
      whereCondition.OR = [
        { userQuery: { contains: query.search, mode: 'insensitive' } },
        { modelUsed: { contains: query.search, mode: 'insensitive' } }
      ];
    }

    const [logs, total] = await Promise.all([
      prisma.aiLog.findMany({
        where: whereCondition,
        skip,
        take: limit,
        orderBy: { [sortBy]: sortOrder },
        include: {
          VisitorSession: {
            select: { id: true, channel: true, conversationStatus: true }
          }
        }
      }),
      prisma.aiLog.count({ where: whereCondition })
    ]);

    return formatPaginatedResponse(logs, total, { page, limit });
  });

  // @route   GET /api/ai-logs/:id
  // @desc    Get detailed AI log telemetry record
  fastify.get('/:id', { preHandler: protect }, async (request, reply) => {
    const user = request.user!;
    const { id } = request.params as { id: string };

    const where: any = { id };
    if (user.role !== 'super_admin') {
      where.tenantId = user.tenantId;
    }

    const log = await prisma.aiLog.findFirst({
      where,
      include: {
        VisitorSession: true
      }
    });

    if (!log) {
      throw new AppError('AI log entry not found', 404);
    }

    return {
      status: 'success',
      data: log
    };
  });
}
