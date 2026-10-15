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
    include: {
      User: {
        include: {
          Tenant: true,
          UserRole: {
            include: { Role: true }
          }
        }
      }
    }
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

  // 4. Backward compatibility: ensure hierarchy fields are attached to user context
  if (!decoded.roleLevel) {
    const userRoles = session.User?.UserRole || [];
    let resolvedLevel: string = 'L4_AGENT';
    if (userRoles.some(ur => ur.Role.name === 'super_admin' || ur.Role.level === 'L0_PLATFORM')) {
      resolvedLevel = 'L0_PLATFORM';
    } else if (userRoles.some(ur => ur.Role.level === 'L1_GROUP')) {
      resolvedLevel = 'L1_GROUP';
    } else if (userRoles.some(ur => ur.Role.name === 'manager' || ur.Role.level === 'L2_COMPANY')) {
      resolvedLevel = 'L2_COMPANY';
    } else if (userRoles.some(ur => ur.Role.level === 'L3_DEPARTMENT')) {
      resolvedLevel = 'L3_DEPARTMENT';
    } else if (userRoles.length > 0) {
      resolvedLevel = userRoles[0].Role.level || 'L4_AGENT';
    }
    decoded.roleLevel = resolvedLevel;
  }

  if (decoded.groupId === undefined) {
    decoded.groupId = session.User?.Tenant?.groupId || null;
  }
  if (decoded.departmentId === undefined) {
    decoded.departmentId = session.User?.departmentId || null;
  }
  if (decoded.id === undefined) {
    decoded.id = decoded.userId;
  }
  if (!decoded.email && session.User?.email) {
    decoded.email = session.User.email;
  }
  if (!decoded.name && session.User?.name) {
    decoded.name = session.User.name;
  }

  // 5. Update session last activity (throttled to once every 2 minutes to prevent connection exhaustion)
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

  // 6. Support Group-level (L1) and Platform-level (L0) tenant switching via x-tenant-id header
  const requestedTenantId = request.headers['x-tenant-id'] as string | undefined;
  if (requestedTenantId && (decoded.roleLevel === 'L1_GROUP' || decoded.roleLevel === 'L0_PLATFORM')) {
    if (decoded.roleLevel === 'L1_GROUP' && decoded.groupId) {
      const validGroupTenant = await prisma.tenant.findFirst({
        where: { id: requestedTenantId, groupId: decoded.groupId },
        select: { id: true }
      });
      if (validGroupTenant) {
        decoded.activeTenantId = requestedTenantId;
      }
    } else if (decoded.roleLevel === 'L0_PLATFORM') {
      const validTenant = await prisma.tenant.findFirst({
        where: { id: requestedTenantId },
        select: { id: true }
      });
      if (validTenant) {
        decoded.activeTenantId = requestedTenantId;
      }
    }
  }

  // 7. Grant access to protected route and attach user context
  request.user = decoded;
};
