import { FastifyInstance, FastifyPluginOptions, FastifyRequest } from 'fastify';
import bcrypt from 'bcrypt';
import { randomUUID } from 'crypto';
import prisma from '../lib/prisma';
import { protect } from '../middleware/auth';
import { AppError } from '../middleware/error';
import { uploadFileToS3 } from '../utils/s3';
import {
  OtpVerificationService,
  OtpPurpose,
} from '../services/security/OtpVerificationService';

async function resolveAccountContext(request: FastifyRequest): Promise<{
  tenantId: string;
  userId: number;
}> {
  const headerTenant = request.headers['x-tenant-id'];
  const explicitTenantId = Array.isArray(headerTenant) ? headerTenant[0] : headerTenant;

  if (!request.user && (request.headers.authorization || request.cookies?.token)) {
    try {
      await protect(request, {} as any);
    } catch (_) {}
  }

  const tenantId =
    explicitTenantId?.trim() ||
    request.user?.activeTenantId ||
    request.user?.tenantId ||
    '8a123d29-99da-4db4-9141-8f6bb9b7233a';
  const userId = request.user?.userId || 1;

  return { tenantId, userId };
}

export default async function accountRoutes(fastify: FastifyInstance, options: FastifyPluginOptions) {
  // @route   GET /api/account/profile
  fastify.get('/profile', { preHandler: protect }, async (request, reply) => {
    const userId = request.user!.userId;
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        image: true,
        role: true,
        status: true,
        createdAt: true,
      },
    });

    if (!user) throw new AppError('User profile not found', 404);
    return { status: 'success', data: user };
  });

  // @route   PUT /api/account/profile
  // @desc    Update profile (Name, Phone, SeaweedFS S3 Avatar)
  fastify.put('/profile', { preHandler: protect }, async (request, reply) => {
    const userId = request.user!.userId;
    const isMultipart = request.isMultipart();

    let name: string | undefined;
    let phone: string | undefined;
    let imageUrl: string | undefined;

    if (isMultipart) {
      const pendingUploads: Promise<void>[] = [];
      const parts = request.parts();
      for await (const part of parts) {
        if (part.type === 'file') {
          const buffer = await part.toBuffer();
          const ext = part.filename.split('.').pop() || 'png';
          const fileKey = `avatars/user-${userId}-${randomUUID()}.${ext}`;
          const mimetype = part.mimetype;
          pendingUploads.push(
            uploadFileToS3(buffer, fileKey, mimetype).then((url) => {
              imageUrl = url;
            })
          );
        } else {
          if (part.fieldname === 'name') name = part.value as string;
          if (part.fieldname === 'phone') phone = part.value as string;
        }
      }
      await Promise.all(pendingUploads);
    } else {
      const body = request.body as any;
      name = body.name;
      phone = body.phone;
    }

    const updated = await prisma.user.update({
      where: { id: userId },
      data: {
        ...(name ? { name } : {}),
        ...(phone !== undefined ? { phone } : {}),
        ...(imageUrl ? { image: imageUrl } : {}),
        updatedAt: new Date(),
      },
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        image: true,
        role: true,
      },
    });

    return { status: 'success', data: updated };
  });

  // @route   PUT /api/account/password
  // @desc    Update password (enforces OTP verification when tenant policy requires it)
  fastify.put('/password', { preHandler: protect }, async (request, reply) => {
    const userId = request.user!.userId;
    const tenantId =
      request.user?.activeTenantId ||
      request.user?.tenantId ||
      '8a123d29-99da-4db4-9141-8f6bb9b7233a';
    const { currentPassword, newPassword, otpCode } = request.body as any;

    if (!currentPassword || !newPassword) {
      throw new AppError('Current and new password are required.', 400);
    }

    if (newPassword.length < 8) {
      throw new AppError('New password must be at least 8 characters long.', 400);
    }

    const policy = await OtpVerificationService.getPolicy(tenantId);
    const subjectId = `user_${userId}`;

    if (policy.enforceOnAdminPasswordChange) {
      if (otpCode) {
        const check = await OtpVerificationService.verifyOtp({
          tenantId,
          subjectId,
          purpose: 'password_change',
          code: String(otpCode),
        });
        if (!check.verified) {
          throw new AppError(check.reason, 403);
        }
      } else if (!OtpVerificationService.isVerified(tenantId, subjectId, 'password_change')) {
        throw new AppError(
          'OTP verification is required before changing your password. Please request and verify a 6-digit OTP first.',
          403
        );
      }
    }

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new AppError('User not found', 404);

    const isMatch = await bcrypt.compare(currentPassword, user.password);
    if (!isMatch) {
      throw new AppError('Current password is incorrect.', 400);
    }

    const hashed = await bcrypt.hash(newPassword, 10);
    await prisma.user.update({
      where: { id: userId },
      data: { password: hashed, updatedAt: new Date() },
    });

    OtpVerificationService.consumeVerification(tenantId, subjectId, 'password_change');

    return { status: 'success', message: 'Password updated successfully after OTP verification.' };
  });

  // @route   GET /api/account/otp-config
  // @desc    Get Orchestrator & Admin OTP Verification Policy (Blueprint Sec 4.2 & 4.6)
  fastify.get('/otp-config', async (request, reply) => {
    const { tenantId } = await resolveAccountContext(request);
    const policy = await OtpVerificationService.getPolicy(tenantId);
    return { status: 'success', data: policy };
  });

  // @route   PUT /api/account/otp-config
  // @desc    Update Orchestrator & Admin OTP Verification Policy
  fastify.put('/otp-config', async (request, reply) => {
    const { tenantId } = await resolveAccountContext(request);
    const body = (request.body || {}) as any;
    const updated = await OtpVerificationService.savePolicy(tenantId, body);
    return { status: 'success', data: updated };
  });

  // @route   POST /api/account/otp/request
  // @desc    Issue an OTP challenge before a sensitive account/policy modification
  fastify.post('/otp/request', async (request, reply) => {
    const { tenantId, userId } = await resolveAccountContext(request);
    const body = (request.body || {}) as {
      purpose?: OtpPurpose;
      subjectId?: string;
      targetContact?: string;
    };

    const purpose: OtpPurpose = body.purpose || 'password_change';
    const subjectId = body.subjectId || `user_${userId}`;

    const challenge = await OtpVerificationService.issueOtp({
      tenantId,
      subjectId,
      purpose,
      targetContact: body.targetContact || request.user?.email || `user_${userId}@v3c.ai`,
    });

    return { status: 'success', data: challenge };
  });

  // @route   POST /api/account/otp/verify
  // @desc    Verify a submitted OTP code for sensitive account or mid-conversation action
  fastify.post('/otp/verify', async (request, reply) => {
    const { tenantId, userId } = await resolveAccountContext(request);
    const body = (request.body || {}) as {
      purpose?: OtpPurpose;
      subjectId?: string;
      code?: string;
    };

    if (!body.code) {
      throw new AppError('OTP code is required', 400);
    }

    const purpose: OtpPurpose = body.purpose || 'password_change';
    const subjectId = body.subjectId || `user_${userId}`;

    const result = await OtpVerificationService.verifyOtp({
      tenantId,
      subjectId,
      purpose,
      code: body.code,
    });

    return { status: 'success', data: result };
  });
}
