import { FastifyInstance, FastifyPluginOptions } from 'fastify';
import { randomBytes, randomUUID } from 'crypto';
import prisma from '../lib/prisma';
import { protect } from '../middleware/auth';
import { restrictTo } from '../middleware/rbac';
import { AppError } from '../middleware/error';
import { uploadFileToS3 } from '../utils/s3';

export default async function domainRoutes(fastify: FastifyInstance, options: FastifyPluginOptions) {

  // @route   GET /api/domain
  // @desc    Get tenant branding and website keys list
  fastify.get('/', { preHandler: [protect, restrictTo('domain', 'view')] }, async (request, reply) => {
    const tenantId = request.user!.tenantId;
    if (!tenantId) {
      return { status: 'success', data: { branding: {}, websites: [] } };
    }

    const [configs, websites] = await Promise.all([
      prisma.configuration.findMany({ where: { tenantId } }),
      prisma.domain.findMany({
        where: { tenantId },
        orderBy: { createdAt: 'desc' }
      })
    ]);

    const branding: Record<string, string> = {};
    configs.forEach(c => {
      if (c.value) branding[c.key] = c.value;
    });

    return {
      status: 'success',
      data: {
        branding: {
          companyName: branding.brand_company_name || 'V3C Platform',
          logoUrl: branding.brand_logo_url || null,
          faviconUrl: branding.brand_favicon_url || null,
          accentColor: branding.brand_accent_color || '#4F46E5'
        },
        websites
      }
    };
  });

  // @route   PUT /api/domain/branding
  // @desc    Update tenant branding (Company Name, Accent Color, SeaweedFS Logo/Favicon Upload)
  fastify.put('/branding', { preHandler: [protect, restrictTo('domain', 'manage')] }, async (request, reply) => {
    const tenantId = request.user!.tenantId;
    if (!tenantId) throw new AppError('Tenant ID missing', 400);

    const isMultipart = request.isMultipart();

    let companyName: string | undefined;
    let accentColor: string | undefined;
    let logoUrl: string | undefined;
    let faviconUrl: string | undefined;

    if (isMultipart) {
      const parts = request.parts();
      for await (const part of parts) {
        if (part.type === 'file') {
          const buffer = await part.toBuffer();
          const ext = part.filename.split('.').pop() || 'png';
          const fileKey = `branding/${tenantId}/${part.fieldname}-${randomUUID()}.${ext}`;
          const s3Url = await uploadFileToS3(buffer, fileKey, part.mimetype);

          if (part.fieldname === 'logo') logoUrl = s3Url;
          if (part.fieldname === 'favicon') faviconUrl = s3Url;
        } else {
          if (part.fieldname === 'companyName') companyName = part.value as string;
          if (part.fieldname === 'accentColor') accentColor = part.value as string;
        }
      }
    } else {
      const body = request.body as any;
      companyName = body.companyName;
      accentColor = body.accentColor;
    }

    const updates = [
      { key: 'brand_company_name', val: companyName },
      { key: 'brand_accent_color', val: accentColor },
      { key: 'brand_logo_url', val: logoUrl },
      { key: 'brand_favicon_url', val: faviconUrl }
    ];

    for (const item of updates) {
      if (item.val !== undefined && item.val !== null) {
        await prisma.configuration.upsert({
          where: { key_domainId: { key: item.key, domainId: 0 } },
          update: { value: item.val, tenantId, updatedAt: new Date() },
          create: { key: item.key, value: item.val, tenantId, domainId: 0, updatedAt: new Date() }
        });
      }
    }

    return { status: 'success', message: 'Branding settings updated successfully.' };
  });

  // @route   POST /api/domain/websites
  // @desc    Add a new website / domain and generate API keys
  fastify.post('/websites', { preHandler: [protect, restrictTo('domain', 'manage')] }, async (request, reply) => {
    const tenantId = request.user!.tenantId;
    const { domain, packageType } = request.body as any;

    if (!domain) throw new AppError('Domain name is required.', 400);

    const existing = await prisma.domain.findUnique({ where: { domain } });
    if (existing) {
      throw new AppError('Domain is already registered in the system.', 400);
    }

    const publicKey = `pk_live_${randomBytes(16).toString('hex')}`;
    const privateKey = `sk_live_${randomBytes(24).toString('hex')}`;

    const newDomain = await prisma.domain.create({
      data: {
        domain,
        publicKey,
        privateKey,
        packageType: packageType || 'PRO',
        expiryDate: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
        tenantId,
        updatedAt: new Date()
      }
    });

    reply.status(201);
    return { status: 'success', data: newDomain };
  });

  // @route   POST /api/domain/websites/:id/regenerate-keys
  // @desc    Regenerate public and private keys for a domain
  fastify.post('/websites/:id/regenerate-keys', { preHandler: [protect, restrictTo('domain', 'manage')] }, async (request, reply) => {
    const tenantId = request.user!.tenantId;
    const id = parseInt((request.params as any).id);

    if (isNaN(id)) throw new AppError('Invalid Domain ID', 400);

    const existing = await prisma.domain.findUnique({ where: { id } });
    if (!existing || (tenantId && existing.tenantId !== tenantId)) {
      throw new AppError('Domain not found', 404);
    }

    const newPublicKey = `pk_live_${randomBytes(16).toString('hex')}`;
    const newPrivateKey = `sk_live_${randomBytes(24).toString('hex')}`;

    const updated = await prisma.domain.update({
      where: { id },
      data: {
        publicKey: newPublicKey,
        privateKey: newPrivateKey,
        updatedAt: new Date()
      }
    });

    return { status: 'success', data: updated };
  });

  // @route   DELETE /api/domain/websites/:id
  fastify.delete('/websites/:id', { preHandler: [protect, restrictTo('domain', 'manage')] }, async (request, reply) => {
    const tenantId = request.user!.tenantId;
    const id = parseInt((request.params as any).id);

    if (isNaN(id)) throw new AppError('Invalid Domain ID', 400);

    const existing = await prisma.domain.findUnique({ where: { id } });
    if (!existing || (tenantId && existing.tenantId !== tenantId)) {
      throw new AppError('Domain not found', 404);
    }

    await prisma.domain.delete({ where: { id } });
    return { status: 'success', message: 'Domain deleted successfully.' };
  });
}
