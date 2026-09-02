import { FastifyRequest, FastifyReply } from 'fastify';
import { verifyToken, TokenPayload } from '../utils/jwt';
import prisma from '../lib/prisma';
import { AppError } from './error';

export const protect = async (request: FastifyRequest, reply: FastifyReply) => {
  let token: string | undefined;

  // 1. Get token from cookies or Authorization header
  if (request.cookies && request.cookies.token) {
    token = request.cookies.token;
  } else if (request.headers.authorization && request.headers.authorization.startsWith('Bearer')) {
    token = request.headers.authorization.split(' ')[1];
  }

  if (!token) {
    throw new AppError('You are not logged in. Please log in to get access.', 401);
  }

  // 2. Verify token signature and expiration
  let decoded: TokenPayload;
  try {
    decoded = verifyToken(token);
  } catch (err) {
    throw new AppError('Invalid or expired token. Please log in again.', 401);
  }

  // 3. Verify session exists and is active in database
  const session = await prisma.userSession.findUnique({
    where: { token },
    include: { User: true }
  });

  if (!session || !session.isActive || session.expiresAt < new Date()) {
    // Invalidate session if expired but database didn't clean it up yet
    if (session && session.isActive) {
      await prisma.userSession.update({
        where: { token },
        data: { isActive: false }
      });
    }
    throw new AppError('Session is invalid or has expired. Please log in again.', 401);
  }

  // 4. Update session last activity (throttled to once every 2 minutes to prevent connection exhaustion)
  const now = new Date();
  if (!session.lastActivity || (now.getTime() - new Date(session.lastActivity).getTime() > 2 * 60 * 1000)) {
    prisma.userSession.update({
      where: { token },
      data: { lastActivity: now }
    }).catch((err) => {
      // Non-blocking catch to prevent session update failures from failing the user request
      console.warn('[AUTH] Throttled session lastActivity update error:', err?.message || err);
    });
  }

  // 5. Grant access to protected route and attach user context
  request.user = decoded;
};
