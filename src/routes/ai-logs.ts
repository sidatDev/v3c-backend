import { FastifyInstance, FastifyPluginOptions } from 'fastify';
import prisma from '../lib/prisma';
import { protect } from '../middleware/auth';
import { parsePagination, formatPaginatedResponse } from '../utils/pagination';
import { AppError } from '../middleware/error';

export default async function aiLogsRoutes(fastify: FastifyInstance, options: FastifyPluginOptions) {

  // @route   GET /api/ai-logs
  // @desc    Get paginated AI logs for AI Observability & Audit
  fastify.get('/', { preHandler: protect }, async (request, reply) => {
    const tenantId = request.user!.tenantId;
    if (!tenantId) {
      return formatPaginatedResponse([], 0, { page: 1, limit: 10 });
    }

    const query = request.query as any;
    const { page, limit, skip, sortBy, sortOrder } = parsePagination(request, 'createdAt', 'desc');

    const whereCondition: any = { tenantId };

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
    const tenantId = request.user!.tenantId;
    const { id } = request.params as { id: string };

    const log = await prisma.aiLog.findFirst({
      where: { id, tenantId: tenantId || undefined },
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
