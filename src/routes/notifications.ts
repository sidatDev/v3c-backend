import { FastifyInstance, FastifyPluginOptions } from 'fastify';
import prisma from '../lib/prisma';
import { protect } from '../middleware/auth';
import { AppError } from '../middleware/error';

export default async function notificationsRoutes(fastify: FastifyInstance, options: FastifyPluginOptions) {

  // @route   GET /api/notifications
  fastify.get('/', { preHandler: protect }, async (request, reply) => {
    const tenantId = request.user!.tenantId;
    const userId = request.user!.userId;

    const notifications = await prisma.notification.findMany({
      where: {
        OR: [
          { userId },
          ...(tenantId ? [{ tenantId }] : [])
        ]
      },
      orderBy: { createdAt: 'desc' },
      take: 50
    });

    const unreadCount = await prisma.notification.count({
      where: {
        isRead: false,
        OR: [
          { userId },
          ...(tenantId ? [{ tenantId }] : [])
        ]
      }
    });

    return {
      status: 'success',
      data: {
        notifications,
        unreadCount
      }
    };
  });

  // @route   PUT /api/notifications/:id/read
  fastify.put('/:id/read', { preHandler: protect }, async (request, reply) => {
    const id = (request.params as any).id;

    await prisma.notification.update({
      where: { id },
      data: { isRead: true }
    });

    return { status: 'success', message: 'Notification marked as read.' };
  });

  // @route   PUT /api/notifications/read-all
  fastify.put('/read-all', { preHandler: protect }, async (request, reply) => {
    const tenantId = request.user!.tenantId;
    const userId = request.user!.userId;

    await prisma.notification.updateMany({
      where: {
        isRead: false,
        OR: [
          { userId },
          ...(tenantId ? [{ tenantId }] : [])
        ]
      },
      data: { isRead: true }
    });

    return { status: 'success', message: 'All notifications marked as read.' };
  });

  // @route   GET /api/notifications/stream
  // @desc    Real-time SSE Notification Stream
  fastify.get('/stream', { preHandler: protect }, async (request, reply) => {
    reply.raw.setHeader('Content-Type', 'text/event-stream');
    reply.raw.setHeader('Cache-Control', 'no-cache');
    reply.raw.setHeader('Connection', 'keep-alive');
    reply.raw.setHeader('Access-Control-Allow-Origin', '*');

    reply.raw.write(`data: ${JSON.stringify({ type: 'CONNECTED', timestamp: new Date() })}\n\n`);

    const interval = setInterval(() => {
      reply.raw.write(`: heartbeat\n\n`);
    }, 15000);

    request.raw.on('close', () => {
      clearInterval(interval);
    });
  });
}
