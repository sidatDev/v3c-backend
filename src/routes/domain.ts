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
    const isSuperAdmin = request.user!.role === 'super_admin';

    const configWhere = isSuperAdmin
      ? {}
      : tenantId
      ? { tenantId }
      : {};

    const domainWhere = isSuperAdmin
      ? {}
      : tenantId
      ? { OR: [{ tenantId }, { tenantId: null }] }
      : {};

    const [configs, websites] = await Promise.all([
      prisma.configuration.findMany({ where: configWhere }),
      prisma.domain.findMany({
        where: domainWhere,
        orderBy: { createdAt: 'desc' }
      })
    ]);

    const branding: Record<string, string> = {};
    configs.forEach(c => {
      if (c.value) branding[c.key] = c.value;
    });

    const companyName = branding.brand_company_name || 'V3C Platform';
    const pageTitle = branding.brand_page_title || `${companyName}'s Workspace`;

    return {
      status: 'success',
      data: {
        branding: {
          companyName,
          pageTitle,
          logoUrl: branding.brand_logo_url || null,
          faviconUrl: branding.brand_favicon_url || null,
          accentColor: branding.theme_accent_color || branding.brand_accent_color || '#4F46E5'
        },
        theme: {
          primaryColor: branding.theme_primary_color || '#4f46e5',
          sidebarColor: branding.theme_sidebar_color || '#FFFFFF',
          sidebarActiveColor: branding.theme_sidebar_active_color || '#4f46e5',
          sidebarActiveTextColor: branding.theme_sidebar_active_text_color || '#FFFFFF',
          accentColor: branding.theme_accent_color || branding.brand_accent_color || '#f59e0b',
          textColor: branding.theme_text_color || '#0f172a',
          textHoverColor: branding.theme_text_hover_color || '#4f46e5',
          borderRadius: branding.theme_border_radius || '0.625rem'
        },
        websites
      }
    };
  });

  // @route   PUT /api/domain/branding
  // @desc    Update tenant branding (Company Name, Page Title, Accent Color, SeaweedFS Logo/Favicon Upload & Delete)
  fastify.put('/branding', { preHandler: [protect, restrictTo('domain', 'manage')] }, async (request, reply) => {
    const tenantId = request.user!.tenantId;
    const isSuperAdmin = request.user!.role === 'super_admin';
    if (!tenantId && !isSuperAdmin) throw new AppError('Tenant ID missing', 400);

    const isMultipart = request.isMultipart();

    let companyName: string | undefined;
    let pageTitle: string | undefined;
    let accentColor: string | undefined;
    let logoUrl: string | undefined;
    let faviconUrl: string | undefined;
    let targetDomainId: string | number | undefined;
    let deleteLogo = false;
    let deleteFavicon = false;
    let resetTitle = false;

    if (isMultipart) {
      const pendingUploads: Promise<void>[] = [];
      const parts = request.parts();
      for await (const part of parts) {
        if (part.type === 'file') {
          const buffer = await part.toBuffer();
          const ext = part.filename.split('.').pop() || 'png';
          const fieldname = part.fieldname;
          const mimetype = part.mimetype;
          const fileKey = `branding/${tenantId || 'global'}/${fieldname}-${randomUUID()}.${ext}`;

          pendingUploads.push(
            uploadFileToS3(buffer, fileKey, mimetype).then(s3Url => {
              if (fieldname === 'logo') logoUrl = s3Url;
              if (fieldname === 'favicon') faviconUrl = s3Url;
            })
          );
        } else {
          if (part.fieldname === 'companyName') companyName = part.value as string;
          if (part.fieldname === 'pageTitle') pageTitle = part.value as string;
          if (part.fieldname === 'accentColor') accentColor = part.value as string;
          if (part.fieldname === 'domainId') targetDomainId = part.value as string;
          if (part.fieldname === 'deleteLogo') deleteLogo = part.value === 'true';
          if (part.fieldname === 'deleteFavicon') deleteFavicon = part.value === 'true';
          if (part.fieldname === 'resetTitle') resetTitle = part.value === 'true';
        }
      }
      await Promise.all(pendingUploads);
    } else {
      const body = request.body as any;
      companyName = body.companyName;
      pageTitle = body.pageTitle;
      accentColor = body.accentColor;
      targetDomainId = body.domainId;
      deleteLogo = !!body.deleteLogo;
      deleteFavicon = !!body.deleteFavicon;
      resetTitle = !!body.resetTitle;
    }

    let effectiveTenantId = tenantId;
    if (targetDomainId) {
      const domainRec = await prisma.domain.findUnique({ where: { id: Number(targetDomainId) } });
      if (domainRec && domainRec.tenantId) {
        effectiveTenantId = domainRec.tenantId;
      }
    }

    if (!effectiveTenantId && !isSuperAdmin) {
      throw new AppError('Tenant ID missing', 400);
    }

    if (deleteLogo) logoUrl = '';
    if (deleteFavicon) faviconUrl = '';
    if (resetTitle) pageTitle = '';

    const updates = [
      { key: 'brand_company_name', val: companyName },
      { key: 'brand_page_title', val: pageTitle },
      { key: 'brand_accent_color', val: accentColor },
      { key: 'brand_logo_url', val: logoUrl },
      { key: 'brand_favicon_url', val: faviconUrl }
    ];

    for (const item of updates) {
      if (item.val !== undefined && item.val !== null) {
        const existingConfig = await prisma.configuration.findFirst({
          where: { key: item.key, tenantId: effectiveTenantId }
        });

        if (existingConfig) {
          await prisma.configuration.update({
            where: { id: existingConfig.id },
            data: { value: item.val, updatedAt: new Date() }
          });
        } else {
          await prisma.configuration.create({
            data: {
              key: item.key,
              value: item.val,
              tenantId: effectiveTenantId,
              updatedAt: new Date()
            }
          });
        }
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
    const isSuperAdmin = request.user!.role === 'super_admin';
    const id = parseInt((request.params as any).id);

    if (isNaN(id)) throw new AppError('Invalid Domain ID', 400);

    const existing = await prisma.domain.findUnique({ where: { id } });
    if (!existing || (!isSuperAdmin && tenantId && existing.tenantId !== tenantId)) {
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
    const isSuperAdmin = request.user!.role === 'super_admin';
    const id = parseInt((request.params as any).id);

    if (isNaN(id)) throw new AppError('Invalid Domain ID', 400);

    const existing = await prisma.domain.findUnique({ where: { id } });
    if (!existing || (!isSuperAdmin && tenantId && existing.tenantId !== tenantId)) {
      throw new AppError('Domain not found', 404);
    }

    await prisma.domain.delete({ where: { id } });
    return { status: 'success', message: 'Domain deleted successfully.' };
  });

  // @route   GET /api/domain/theme
  // @desc    Get tenant theme customization
  fastify.get('/theme', { preHandler: [protect] }, async (request, reply) => {
    const tenantId = request.user!.tenantId || null;

    const configs = await prisma.configuration.findMany({
      where: tenantId
        ? { OR: [{ tenantId }, { tenantId: null }] }
        : { tenantId: null }
    });

    const map: Record<string, string> = {};
    // Load global configs first
    configs.forEach((c) => {
      if (c.tenantId === null && c.value) map[c.key] = c.value;
    });
    // Override with tenant configs
    configs.forEach((c) => {
      if (c.tenantId && c.value) map[c.key] = c.value;
    });

    return {
      status: 'success',
      data: {
        primaryColor: map.theme_primary_color || '#4f46e5',
        sidebarColor: map.theme_sidebar_color || '#FFFFFF',
        sidebarActiveColor: map.theme_sidebar_active_color || '#4f46e5',
        sidebarActiveTextColor: map.theme_sidebar_active_text_color || '#FFFFFF',
        accentColor: map.theme_accent_color || map.brand_accent_color || '#f59e0b',
        textColor: map.theme_text_color || '#0f172a',
        textHoverColor: map.theme_text_hover_color || '#4f46e5',
        borderRadius: map.theme_border_radius || '0.625rem'
      }
    };
  });

  // @route   PUT /api/domain/theme
  // @desc    Update tenant theme customization
  fastify.put('/theme', { preHandler: [protect] }, async (request, reply) => {
    const tenantId = request.user!.tenantId || null;
    const isSuperAdmin = request.user!.role === 'super_admin';
    if (!tenantId && !isSuperAdmin) throw new AppError('Tenant ID missing', 400);

    const {
      primaryColor,
      sidebarColor,
      sidebarActiveColor,
      sidebarActiveTextColor,
      accentColor,
      textColor,
      textHoverColor,
      borderRadius,
    } = request.body as {
      primaryColor?: string;
      sidebarColor?: string;
      sidebarActiveColor?: string;
      sidebarActiveTextColor?: string;
      accentColor?: string;
      textColor?: string;
      textHoverColor?: string;
      borderRadius?: string;
    };

    const updates = [
      { key: 'theme_primary_color', val: primaryColor },
      { key: 'theme_sidebar_color', val: sidebarColor },
      { key: 'theme_sidebar_active_color', val: sidebarActiveColor },
      { key: 'theme_sidebar_active_text_color', val: sidebarActiveTextColor },
      { key: 'theme_accent_color', val: accentColor },
      { key: 'brand_accent_color', val: accentColor },
      { key: 'theme_text_color', val: textColor },
      { key: 'theme_text_hover_color', val: textHoverColor },
      { key: 'theme_border_radius', val: borderRadius }
    ];

    for (const item of updates) {
      if (item.val !== undefined && item.val !== null) {
        const existingConfig = await prisma.configuration.findFirst({
          where: { key: item.key, tenantId: tenantId }
        });

        if (existingConfig) {
          await prisma.configuration.update({
            where: { id: existingConfig.id },
            data: { value: item.val, updatedAt: new Date() }
          });
        } else {
          await prisma.configuration.create({
            data: {
              key: item.key,
              value: item.val,
              tenantId: tenantId,
              updatedAt: new Date()
            }
          });
        }
      }
    }

    return {
      status: 'success',
      message: 'Theme saved successfully',
      data: {
        primaryColor: primaryColor || '#4f46e5',
        sidebarColor: sidebarColor || '#FFFFFF',
        sidebarActiveColor: sidebarActiveColor || '#4f46e5',
        sidebarActiveTextColor: sidebarActiveTextColor || '#FFFFFF',
        accentColor: accentColor || '#f59e0b',
        textColor: textColor || '#0f172a',
        textHoverColor: textHoverColor || '#4f46e5',
        borderRadius: borderRadius || '0.625rem'
      }
    };
  });
}

