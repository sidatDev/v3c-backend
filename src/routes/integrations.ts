import { FastifyInstance, FastifyPluginOptions } from 'fastify';
import { randomUUID } from 'crypto';
import prisma from '../lib/prisma';
import { protect } from '../middleware/auth';
import { restrictTo } from '../middleware/rbac';
import { AppError } from '../middleware/error';

export default async function integrationsRoutes(fastify: FastifyInstance, options: FastifyPluginOptions) {

  // @route   GET /api/integrations
  // @desc    Get list of registered integrations
  fastify.get('/', { preHandler: [protect, restrictTo('integrations', 'view')] }, async (request, reply) => {
    const tenantId = request.user!.tenantId;
    if (!tenantId) return { status: 'success', data: [] };

    const integrations = await prisma.integration.findMany({
      where: { tenantId },
      include: {
        IntegrationTool: true
      },
      orderBy: { createdAt: 'desc' }
    });

    return { status: 'success', data: integrations };
  });

  // @route   POST /api/integrations
  // @desc    Register a new third-party integration (Super Admin only)
  fastify.post('/', { preHandler: [protect, restrictTo('integrations', 'manage')] }, async (request, reply) => {
    const tenantId = request.user!.tenantId;
    const { name, description, baseUrl, authType, authConfig } = request.body as any;

    if (!name || !baseUrl) {
      throw new AppError('Name and Base URL are required.', 400);
    }

    const integration = await prisma.integration.create({
      data: {
        id: randomUUID(),
        tenantId: tenantId!,
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
    const tenantId = request.user!.tenantId;
    const id = (request.params as any).id;
    const { name, description, baseUrl, authType, authConfig, isActive } = request.body as any;

    const existing = await prisma.integration.findUnique({ where: { id } });
    if (!existing || (tenantId && existing.tenantId !== tenantId)) {
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
    const tenantId = request.user!.tenantId;
    const id = (request.params as any).id;

    const existing = await prisma.integration.findUnique({ where: { id } });
    if (!existing || (tenantId && existing.tenantId !== tenantId)) {
      throw new AppError('Integration not found', 404);
    }

    await prisma.integration.delete({ where: { id } });
    return { status: 'success', message: 'Integration deleted successfully.' };
  });

  // @route   GET /api/integrations/logs
  // @desc    Get integration execution logs
  fastify.get('/logs', { preHandler: [protect, restrictTo('integrations', 'view')] }, async (request, reply) => {
    const tenantId = request.user!.tenantId;
    if (!tenantId) return { status: 'success', data: [] };

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
}
