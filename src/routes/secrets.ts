import { FastifyInstance, FastifyPluginOptions, FastifyRequest } from 'fastify';
import prisma from '../lib/prisma';
import { protect } from '../middleware/auth';
import { AppError } from '../middleware/error';
import { encrypt, decrypt } from '../lib/crypto';
import { logAudit } from '../lib/audit';
import { ByokRouterService } from '../services/ai/ByokRouterService';

function maskSecretValue(val: string): string {
  if (!val) return '';
  if (val.length <= 8) return '••••••••';
  return `${val.slice(0, 6)}••••••••${val.slice(-4)}`;
}

export default async function secretsRoutes(fastify: FastifyInstance, options: FastifyPluginOptions) {
  // Helper to resolve and validate target tenantId based on user role or x-tenant-id header
  const resolveTargetTenantId = async (request: FastifyRequest, requestedTenantId?: string): Promise<string> => {
    if (!request.user && (request.headers.authorization || request.cookies?.token)) {
      try {
        await protect(request, {} as any);
      } catch (_) {
        // Fallback to x-tenant-id if provided
      }
    }

    const headerTenant = request.headers['x-tenant-id'];
    const explicitHeaderTenant = Array.isArray(headerTenant) ? headerTenant[0] : headerTenant;
    const user = request.user;

    let targetTenantId =
      requestedTenantId ||
      explicitHeaderTenant?.trim() ||
      user?.activeTenantId ||
      user?.tenantId;

    if (!targetTenantId) {
      throw new AppError('Tenant ID is required.', 400);
    }

    // Role-based validation when authenticated user is present
    if (user && requestedTenantId && requestedTenantId !== user.tenantId) {
      if (user.roleLevel === 'L0_PLATFORM') {
        return targetTenantId;
      }
      if (user.roleLevel === 'L1_GROUP' && user.groupId) {
        const tenant = await prisma.tenant.findFirst({
          where: { id: requestedTenantId, groupId: user.groupId },
          select: { id: true },
        });
        if (!tenant) {
          throw new AppError('Unauthorized: Target tenant does not belong to your group.', 403);
        }
        return targetTenantId;
      }
      throw new AppError('Unauthorized to manage secrets for another tenant.', 403);
    }

    return targetTenantId;
  };

  // @route   GET /api/secrets
  // @desc    List configured BYOK secrets (masked) and active routing status for tenant
  fastify.get('/', async (request, reply) => {
    const query = (request.query || {}) as { tenantId?: string };
    const tenantId = await resolveTargetTenantId(request, query.tenantId);

    const secrets = await prisma.secret.findMany({
      where: { tenantId },
      orderBy: { updatedAt: 'desc' },
    });

    const items = secrets.map((s) => {
      let maskedValue = '••••••••';
      try {
        const raw = decrypt(s.encryptedValue, s.iv, s.authTag);
        maskedValue = s.keyName === 'BYOK_DEFAULT_MODEL' ? raw : maskSecretValue(raw);
      } catch (_) {}
      return {
        id: s.id,
        keyName: s.keyName,
        maskedValue,
        updatedAt: s.updatedAt,
      };
    });

    const routed = await ByokRouterService.resolveCompletionClient(tenantId);

    return {
      status: 'success',
      data: {
        tenantId,
        activeKeySource: routed.keySource,
        activeModel: routed.model,
        isByokActive: routed.isByok,
        secrets: items,
      },
    };
  });

  // @route   POST /api/secrets
  // @desc    Upsert an encrypted secret (BYOK)
  fastify.post('/', async (request, reply) => {
    const { keyName, value, tenantId: requestedTenantId } = request.body as any;

    if (!keyName || typeof keyName !== 'string' || !value || typeof value !== 'string') {
      throw new AppError('Please provide both keyName and value strings.', 400);
    }

    const tenantId = await resolveTargetTenantId(request, requestedTenantId);

    // Envelope encryption using AES-256-GCM
    const { encryptedValue, iv, authTag } = encrypt(value.trim());

    const secret = await prisma.secret.upsert({
      where: {
        tenantId_keyName: {
          tenantId,
          keyName: keyName.trim(),
        },
      },
      create: {
        tenantId,
        keyName: keyName.trim(),
        encryptedValue,
        iv,
        authTag,
      },
      update: {
        encryptedValue,
        iv,
        authTag,
      },
    });

    // Invalidate BYOK cache so AiGateway immediately uses the updated secret
    ByokRouterService.invalidateCache(tenantId);

    if (request.user?.userId) {
      await logAudit(
        prisma,
        request.user.userId,
        'SECRET_UPSERTED',
        'Secret',
        secret.id,
        { keyName, tenantId },
        request.ip || null
      );
    }

    return {
      status: 'success',
      data: {
        id: secret.id,
        tenantId: secret.tenantId,
        keyName: secret.keyName,
        updatedAt: secret.updatedAt,
      },
    };
  });

  // @route   GET /api/secrets/:keyName
  // @desc    Retrieve and decrypt a secret
  fastify.get('/:keyName', async (request, reply) => {
    const { keyName } = request.params as { keyName: string };
    const { tenantId: requestedTenantId } = request.query as { tenantId?: string };

    const tenantId = await resolveTargetTenantId(request, requestedTenantId);

    const secret = await prisma.secret.findUnique({
      where: {
        tenantId_keyName: {
          tenantId,
          keyName,
        },
      },
    });

    if (!secret) {
      throw new AppError(`Secret '${keyName}' not found for this tenant.`, 404);
    }

    let decryptedValue: string;
    try {
      decryptedValue = decrypt(secret.encryptedValue, secret.iv, secret.authTag);
    } catch (err: any) {
      console.error('[SECRET DECRYPT ERROR]:', err?.message || err);
      throw new AppError('Failed to decrypt secret. Master key may have changed or data was corrupted.', 500);
    }

    if (request.user?.userId) {
      await logAudit(
        prisma,
        request.user.userId,
        'SECRET_ACCESSED',
        'Secret',
        secret.id,
        { keyName: secret.keyName, tenantId },
        request.ip || null
      );
    }

    return {
      status: 'success',
      data: {
        keyName: secret.keyName,
        value: decryptedValue,
        updatedAt: secret.updatedAt,
      },
    };
  });

  // @route   DELETE /api/secrets/:keyName
  // @desc    Delete a BYOK secret and revert to platform default key
  fastify.delete('/:keyName', async (request, reply) => {
    const { keyName } = request.params as { keyName: string };
    const { tenantId: requestedTenantId } = (request.query || {}) as { tenantId?: string };

    const tenantId = await resolveTargetTenantId(request, requestedTenantId);

    const existing = await prisma.secret.findUnique({
      where: {
        tenantId_keyName: {
          tenantId,
          keyName,
        },
      },
    });

    if (!existing) {
      throw new AppError(`Secret '${keyName}' not found for this tenant.`, 404);
    }

    await prisma.secret.delete({
      where: { id: existing.id },
    });

    ByokRouterService.invalidateCache(tenantId);

    return {
      status: 'success',
      message: `Secret '${keyName}' removed; reverted to platform default.`,
    };
  });
}
