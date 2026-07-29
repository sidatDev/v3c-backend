import { FastifyInstance, FastifyPluginOptions } from 'fastify';
import bcrypt from 'bcrypt';
import { randomUUID } from 'crypto';
import prisma from '../lib/prisma';
import { protect } from '../middleware/auth';
import { AppError } from '../middleware/error';
import { uploadFileToS3 } from '../utils/s3';

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
        createdAt: true
      }
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
            uploadFileToS3(buffer, fileKey, mimetype).then(url => {
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
        updatedAt: new Date()
      },
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        image: true,
        role: true
      }
    });

    return { status: 'success', data: updated };
  });

  // @route   PUT /api/account/password
  // @desc    Update password
  fastify.put('/password', { preHandler: protect }, async (request, reply) => {
    const userId = request.user!.userId;
    const { currentPassword, newPassword } = request.body as any;

    if (!currentPassword || !newPassword) {
      throw new AppError('Current and new password are required.', 400);
    }

    if (newPassword.length < 8) {
      throw new AppError('New password must be at least 8 characters long.', 400);
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
      data: { password: hashed, updatedAt: new Date() }
    });

    return { status: 'success', message: 'Password updated successfully.' };
  });
}
