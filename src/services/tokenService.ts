import crypto from 'crypto';
import prisma from '../lib/prisma';
import { signToken, TokenPayload } from '../utils/jwt';
import { AppError } from '../middleware/error';

const REFRESH_TOKEN_EXPIRY_DAYS = 7;

/**
 * Hash a refresh token using SHA-256 for secure database storage.
 */
export const hashRefreshToken = (token: string): string => {
  return crypto.createHash('sha256').update(token).digest('hex');
};

/**
 * Generate a random 40-byte hex refresh token.
 */
export const generateRawRefreshToken = (): string => {
  return crypto.randomBytes(40).toString('hex');
};

export interface AuthTokensResult {
  token: string;
  refreshToken: string;
  expiresIn: number; // in seconds (3600 for 1h)
  user: any;
  permissions: string[];
}

/**
 * Resolves the user's primary role, role level, and permissions list.
 */
export const resolveUserRolesAndPermissions = async (userId: number) => {
  const userRoles = await prisma.userRole.findMany({
    where: { userId },
    include: { Role: true },
  });

  let primaryRole = 'member';
  let primaryRoleLevel = 'L4_AGENT';

  if (userRoles.some((ur) => ur.Role.name === 'super_admin' || ur.Role.level === 'L0_PLATFORM')) {
    primaryRole = 'super_admin';
    primaryRoleLevel = 'L0_PLATFORM';
  } else if (userRoles.some((ur) => ur.Role.level === 'L1_GROUP')) {
    const groupRole = userRoles.find((ur) => ur.Role.level === 'L1_GROUP')!;
    primaryRole = groupRole.Role.name;
    primaryRoleLevel = 'L1_GROUP';
  } else if (userRoles.some((ur) => ur.Role.name === 'manager' || ur.Role.level === 'L2_COMPANY')) {
    primaryRole = 'manager';
    primaryRoleLevel = 'L2_COMPANY';
  } else if (userRoles.some((ur) => ur.Role.level === 'L3_DEPARTMENT')) {
    const deptRole = userRoles.find((ur) => ur.Role.level === 'L3_DEPARTMENT')!;
    primaryRole = deptRole.Role.name;
    primaryRoleLevel = 'L3_DEPARTMENT';
  } else if (userRoles.length > 0) {
    primaryRole = userRoles[0].Role.name;
    primaryRoleLevel = userRoles[0].Role.level || 'L4_AGENT';
  }

  const roleIds = userRoles.map((ur) => ur.roleId);
  const rolePermissions = await prisma.rolePermission.findMany({
    where: { roleId: { in: roleIds } },
    include: { Permission: true },
  });

  const permissions = rolePermissions.map((rp) => `${rp.Permission.resource}:${rp.Permission.action}`);

  return { primaryRole, primaryRoleLevel, permissions };
};

/**
 * Creates a short-lived JWT (1 hour) and a hashed long-lived refresh token (7 days).
 */
export const issueAuthTokens = async (
  user: any,
  ipAddress?: string | null,
  userAgent?: string | null
): Promise<AuthTokensResult> => {
  const { primaryRole, primaryRoleLevel, permissions } = await resolveUserRolesAndPermissions(user.id);

  // Short-lived JWT (1 hour)
  const tokenPayload: TokenPayload = {
    userId: user.id,
    id: user.id,
    name: user.name,
    email: user.email,
    tenantId: user.tenantId,
    groupId: user.Tenant?.groupId || null,
    departmentId: user.departmentId || null,
    role: primaryRole,
    roleLevel: primaryRoleLevel,
    permissions,
  };

  const jwtToken = signToken(tokenPayload, false);

  // Long-lived Refresh Token (7 days)
  const rawRefreshToken = generateRawRefreshToken();
  const hashedToken = hashRefreshToken(rawRefreshToken);
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_EXPIRY_DAYS * 24 * 60 * 60 * 1000);

  // Store hashed refresh token in database
  await prisma.refreshToken.create({
    data: {
      token: hashedToken,
      userId: user.id,
      expiresAt,
    },
  });

  // Track session in userSession table for backward compatibility
  await prisma.userSession.create({
    data: {
      id: crypto.randomUUID(),
      userId: user.id,
      tenantId: user.tenantId,
      token: jwtToken,
      ipAddress: ipAddress || null,
      userAgent: userAgent || null,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000), // 1 hour
    },
  });

  return {
    token: jwtToken,
    refreshToken: rawRefreshToken,
    expiresIn: 3600,
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      role: primaryRole,
      roleLevel: primaryRoleLevel,
      tenantId: user.tenantId,
      groupId: user.Tenant?.groupId || null,
      departmentId: user.departmentId || null,
      tenantSlug: user.Tenant?.slug,
      companyName: user.Tenant?.name,
    },
    permissions,
  };
};

/**
 * Rotates an active refresh token: revokes old token and generates a new pair.
 */
export const rotateRefreshToken = async (
  rawRefreshToken: string,
  ipAddress?: string | null,
  userAgent?: string | null
): Promise<{ token: string; refreshToken: string; expiresIn: number }> => {
  if (!rawRefreshToken || typeof rawRefreshToken !== 'string') {
    throw new AppError('Refresh token is required.', 400);
  }

  const hashedToken = hashRefreshToken(rawRefreshToken);

  const existingToken = await prisma.refreshToken.findUnique({
    where: { token: hashedToken },
    include: {
      User: {
        include: {
          Tenant: true,
          department: true,
        },
      },
    },
  });

  if (!existingToken || existingToken.revoked || existingToken.expiresAt < new Date()) {
    throw new AppError('Invalid or expired refresh token. Please log in again.', 401);
  }

  // Revoke the old refresh token (Strict Single-Use Rotation)
  await prisma.refreshToken.update({
    where: { id: existingToken.id },
    data: { revoked: true },
  });

  if (!existingToken.User || existingToken.User.status !== 'active') {
    throw new AppError('User account is inactive or not found.', 401);
  }

  // Issue new tokens
  const newTokens = await issueAuthTokens(existingToken.User, ipAddress, userAgent);

  return {
    token: newTokens.token,
    refreshToken: newTokens.refreshToken,
    expiresIn: newTokens.expiresIn,
  };
};

/**
 * Revokes a refresh token on logout.
 */
export const revokeRefreshToken = async (rawRefreshToken: string): Promise<void> => {
  if (!rawRefreshToken) return;

  const hashedToken = hashRefreshToken(rawRefreshToken);
  await prisma.refreshToken.updateMany({
    where: { token: hashedToken },
    data: { revoked: true },
  });
};
