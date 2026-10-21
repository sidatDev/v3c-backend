import { FastifyInstance, FastifyPluginOptions } from 'fastify';
import bcrypt from 'bcrypt';
import { randomUUID, randomBytes } from 'crypto';
import prisma from '../lib/prisma';
import { signToken, getCookieOptions, signTempMfaToken, verifyTempMfaToken } from '../utils/jwt';
import { protect } from '../middleware/auth';
import { AppError } from '../middleware/error';
import { generateMfaSetup, verifyMfaCode } from '../services/mfaService';
import { issueAuthTokens, rotateRefreshToken, revokeRefreshToken } from '../services/tokenService';
import { logAudit } from '../lib/audit';


// Helper to generate a slug from tenant name
const slugify = (text: string) => {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)+/g, '');
};

export default async function authRoutes(fastify: FastifyInstance, options: FastifyPluginOptions) {
  
  // @route   POST /api/auth/signup
  // @desc    Register a new tenant manager and create tenant account
  fastify.post('/signup', async (request, reply) => {
    const { name, email, password, companyName } = request.body as any;

    if (!name || !email || !password || !companyName) {
      throw new AppError('Please provide all required fields.', 400);
    }

    // Check if user already exists
    const existingUser = await prisma.user.findUnique({ where: { email } });
    if (existingUser) {
      throw new AppError('Email is already registered.', 400);
    }

    const tenantSlug = slugify(companyName);
    const existingTenant = await prisma.tenant.findUnique({ where: { slug: tenantSlug } });
    if (existingTenant) {
      throw new AppError('A company with this name already exists. Please choose another name.', 400);
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 12);

    // Get Manager Role ID
    const managerRole = await prisma.role.findFirst({
      where: { name: 'manager', isSystem: true }
    });
    if (!managerRole) {
      throw new AppError('System roles not seeded. Please contact system administrator.', 500);
    }

    // Execute signup inside transaction
    const result = await prisma.$transaction(async (tx) => {
      const tenantId = randomUUID();

      // 1. Create Tenant
      const tenant = await tx.tenant.create({
        data: {
          id: tenantId,
          name: companyName,
          slug: tenantSlug,
          status: 'active',
          updatedAt: new Date()
        }
      });

      // 2. Create Tenant Limit
      await tx.tenantLimit.create({
        data: {
          id: randomUUID(),
          tenantId,
          maxLeads: 100,
          maxConversations: 1000,
          maxStorage: BigInt(104857600), // 100MB
          updatedAt: new Date()
        }
      });

      // 3. Create User
      const user = await tx.user.create({
        data: {
          name,
          email,
          password: hashedPassword,
          role: 'manager', // backward compatibility
          status: 'active',
          tenantId,
          updatedAt: new Date()
        }
      });

      // 4. Create User Role mapping
      await tx.userRole.create({
        data: {
          userId: user.id,
          roleId: managerRole.id,
          tenantId
        }
      });

      // 5. Create Admin Profile
      await tx.adminProfile.create({
        data: {
          userId: user.id,
          packagePlan: 'professional',
          price: '$99',
          nextBillingDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
          leadsIncluded: 100,
          leadsUsed: 0,
          storage: '100MB',
          tenantId,
          updatedAt: new Date()
        }
      });

      return { user, tenant };
    });

    // Get permissions for the manager role
    const permissionsRes = await prisma.rolePermission.findMany({
      where: { roleId: managerRole.id },
      include: { Permission: true }
    });
    const permissions = permissionsRes.map(p => `${p.Permission.resource}:${p.Permission.action}`);

    // Create session token
    const tokenPayload = {
      userId: result.user.id,
      id: result.user.id,
      name: result.user.name,
      email: result.user.email,
      tenantId: result.tenant.id,
      groupId: result.tenant.groupId || null,
      departmentId: result.user.departmentId || null,
      role: 'manager',
      roleLevel: managerRole.level || 'L2_COMPANY',
      permissions
    };
    const token = signToken(tokenPayload);

    // Save session in database
    await prisma.userSession.create({
      data: {
        id: randomUUID(),
        userId: result.user.id,
        tenantId: result.tenant.id,
        token,
        ipAddress: request.ip || null,
        userAgent: request.headers['user-agent'] || null,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000) // 24 hours
      }
    });

    // Log the signup action
    request.auditLog = {
      action: 'SIGNUP',
      resourceType: 'User',
      resourceId: result.user.id.toString(),
      details: { email, companyName }
    };

    // Set JWT cookie and respond
    const cookieOpts = getCookieOptions();
    reply.setCookie('token', token, cookieOpts);
    
    return {
      status: 'success',
      data: {
        token,
        user: {
          id: result.user.id,
          name: result.user.name,
          email: result.user.email,
          role: 'manager',
          roleLevel: managerRole.level || 'L2_COMPANY',
          tenantId: result.tenant.id,
          groupId: result.tenant.groupId || null,
          departmentId: result.user.departmentId || null,
          tenantSlug: result.tenant.slug,
          companyName: result.tenant.name
        },
        permissions
      }
    };
  });

  // @route   POST /api/auth/login
  // @desc    Log in user and establish active session (or request MFA code)
  fastify.post('/login', async (request, reply) => {
    const { email, password, rememberMe } = request.body as any;

    if (!email || !password) {
      throw new AppError('Please provide email and password.', 400);
    }

    // Find user
    const user = await prisma.user.findUnique({
      where: { email },
      include: {
        Tenant: true,
        department: true,
      },
    });

    if (!user || user.status !== 'active' || !(await bcrypt.compare(password, user.password))) {
      throw new AppError('Incorrect email or password.', 401);
    }

    // If MFA is enabled on user account, return short-lived tempToken and challenge
    if (user.mfaEnabled) {
      const tempToken = signTempMfaToken(user.id, user.email);
      return {
        status: 'success',
        requiresMfa: true,
        tempToken,
      };
    }

    // Issue short-lived JWT (1h) and long-lived refresh token (7d)
    const authResult = await issueAuthTokens(
      user,
      request.ip || null,
      request.headers['user-agent'] || null
    );

    // Update user lastLogin
    await prisma.user.update({
      where: { id: user.id },
      data: { lastLogin: new Date() },
    });

    // Append-only audit log
    await logAudit(
      prisma,
      user.id,
      'USER_LOGIN',
      'User',
      String(user.id),
      null,
      request.ip || null
    );

    // Set cookie and respond
    reply.setCookie('token', authResult.token, getCookieOptions(rememberMe));

    return {
      status: 'success',
      data: {
        token: authResult.token,
        refreshToken: authResult.refreshToken,
        expiresIn: authResult.expiresIn,
        user: authResult.user,
        permissions: authResult.permissions,
      },
    };
  });

  // @route   POST /api/auth/login/mfa-verify
  // @desc    Complete login with 6-digit TOTP verification
  fastify.post('/login/mfa-verify', async (request, reply) => {
    const { tempToken, code, rememberMe } = request.body as any;

    if (!tempToken || !code) {
      throw new AppError('Please provide both tempToken and 6-digit MFA code.', 400);
    }

    let payload: any;
    try {
      payload = verifyTempMfaToken(tempToken);
    } catch {
      throw new AppError('Invalid or expired MFA session. Please log in again.', 401);
    }

    const user = await prisma.user.findUnique({
      where: { id: payload.userId },
      include: {
        Tenant: true,
        department: true,
      },
    });

    if (!user || user.status !== 'active' || !user.mfaEnabled || !user.mfaSecret) {
      throw new AppError('MFA verification is not active for this account.', 401);
    }

    const isValid = verifyMfaCode(user.mfaSecret, String(code));
    if (!isValid) {
      throw new AppError('Invalid MFA verification code.', 401);
    }

    // Issue short-lived JWT (1h) and long-lived refresh token (7d)
    const authResult = await issueAuthTokens(
      user,
      request.ip || null,
      request.headers['user-agent'] || null
    );

    await prisma.user.update({
      where: { id: user.id },
      data: { lastLogin: new Date() },
    });

    await logAudit(
      prisma,
      user.id,
      'USER_LOGIN_MFA',
      'User',
      String(user.id),
      null,
      request.ip || null
    );

    reply.setCookie('token', authResult.token, getCookieOptions(rememberMe));

    return {
      status: 'success',
      data: {
        token: authResult.token,
        refreshToken: authResult.refreshToken,
        expiresIn: authResult.expiresIn,
        user: authResult.user,
        permissions: authResult.permissions,
      },
    };
  });


  // @route   GET /api/auth/me
  // @desc    Get current user profile and permissions from session
  fastify.get('/me', async (request, reply) => {
    let token: string | undefined;

    if (request.cookies && request.cookies.token) {
      token = request.cookies.token;
    } else if (request.headers.authorization && request.headers.authorization.startsWith('Bearer')) {
      token = request.headers.authorization.split(' ')[1];
    }

    if (!token) {
      return { status: 'success', data: null };
    }

    try {
      await protect(request, reply);
    } catch {
      return { status: 'success', data: null };
    }

    const userPayload = request.user!;
    const user = await prisma.user.findUnique({
      where: { id: userPayload.userId },
      include: {
        Tenant: true,
        department: true
      }
    });

    if (!user || user.status !== 'active') {
      return { status: 'success', data: null };
    }

    const roleLevel = userPayload.roleLevel || (userPayload.role === 'super_admin' ? 'L0_PLATFORM' : 'L4_AGENT');

    return {
      status: 'success',
      data: {
        token,
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
          role: userPayload.role,
          roleLevel,
          tenantId: user.tenantId,
          groupId: user.Tenant?.groupId || userPayload.groupId || null,
          departmentId: user.departmentId || userPayload.departmentId || null,
          tenantSlug: user.Tenant?.slug || 'v3c-system-tenant',
          domainId: user.domainId,
          companyName: user.Tenant?.name || null,
          image: user.image
        },
        permissions: userPayload.permissions
      }
    };
  });

  // @route   POST /api/auth/logout
  // @desc    Invalidate current session, revoke refresh token, and clear authentication cookie
  fastify.post('/logout', async (request, reply) => {
    const { refreshToken } = (request.body as any) || {};

    if (refreshToken) {
      await revokeRefreshToken(refreshToken);
    }

    let token: string | undefined;

    if (request.cookies && request.cookies.token) {
      token = request.cookies.token;
    } else if (request.headers.authorization && request.headers.authorization.startsWith('Bearer')) {
      token = request.headers.authorization.split(' ')[1];
    }

    if (token) {
      // Invalidate session in DB
      await prisma.userSession.updateMany({
        where: { token, isActive: true },
        data: { isActive: false },
      });
    }

    reply.clearCookie('token', {
      path: '/',
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
    });

    return { status: 'success', message: 'Logged out successfully.' };
  });

  // @route   POST /api/auth/refresh
  // @desc    Rotate refresh token and issue a new short-lived JWT
  fastify.post('/refresh', async (request, reply) => {
    const { refreshToken } = (request.body as any) || {};

    if (!refreshToken) {
      throw new AppError('Refresh token is required.', 400);
    }

    const rotated = await rotateRefreshToken(
      refreshToken,
      request.ip || null,
      request.headers['user-agent'] || null
    );

    reply.setCookie('token', rotated.token, getCookieOptions(false));

    return {
      status: 'success',
      data: rotated,
    };
  });

  // @route   POST /api/auth/mfa/setup
  // @desc    Generate TOTP secret and QR code for scanning
  fastify.post('/mfa/setup', { preHandler: protect }, async (request, reply) => {
    const user = await prisma.user.findUnique({
      where: { id: request.user!.userId },
      select: { email: true, mfaEnabled: true },
    });

    if (!user) {
      throw new AppError('User not found.', 404);
    }

    const setupResult = await generateMfaSetup(user.email);

    return {
      status: 'success',
      data: setupResult,
    };
  });

  // @route   POST /api/auth/mfa/enable
  // @desc    Verify TOTP code and enable MFA on account
  fastify.post('/mfa/enable', { preHandler: protect }, async (request, reply) => {
    const { token, secret } = request.body as any;

    if (!token || !secret) {
      throw new AppError('Please provide both the 6-digit verification code and setup secret.', 400);
    }

    const isValid = verifyMfaCode(secret, String(token));
    if (!isValid) {
      throw new AppError('Invalid MFA verification code.', 400);
    }

    await prisma.user.update({
      where: { id: request.user!.userId },
      data: {
        mfaEnabled: true,
        mfaSecret: secret,
      },
    });

    await logAudit(
      prisma,
      request.user!.userId,
      'MFA_ENABLED',
      'User',
      String(request.user!.userId),
      null,
      request.ip || null
    );

    return {
      status: 'success',
      message: 'Multi-Factor Authentication has been successfully enabled.',
    };
  });

  // @route   POST /api/auth/mfa/disable
  // @desc    Disable MFA on account with code verification
  fastify.post('/mfa/disable', { preHandler: protect }, async (request, reply) => {
    const { token } = request.body as any;

    if (!token) {
      throw new AppError('Please provide your 6-digit MFA verification code.', 400);
    }

    const user = await prisma.user.findUnique({
      where: { id: request.user!.userId },
      select: { mfaEnabled: true, mfaSecret: true },
    });

    if (!user || !user.mfaEnabled || !user.mfaSecret) {
      throw new AppError('MFA is not enabled on this account.', 400);
    }

    const isValid = verifyMfaCode(user.mfaSecret, String(token));
    if (!isValid) {
      throw new AppError('Invalid MFA verification code.', 400);
    }

    await prisma.user.update({
      where: { id: request.user!.userId },
      data: {
        mfaEnabled: false,
        mfaSecret: null,
      },
    });

    await logAudit(
      prisma,
      request.user!.userId,
      'MFA_DISABLED',
      'User',
      String(request.user!.userId),
      null,
      request.ip || null
    );

    return {
      status: 'success',
      message: 'Multi-Factor Authentication has been successfully disabled.',
    };
  });


  // @route   POST /api/auth/forgot-password
  // @desc    Generate password reset token and return connection info
  fastify.post('/forgot-password', async (request, reply) => {
    const { email } = request.body as any;
    if (!email) {
      throw new AppError('Please provide an email address.', 400);
    }

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      // Return 200 even if email doesn't exist for security reasons (prevents enumeration)
      return {
        status: 'success',
        message: 'If a user with this email exists, a reset link has been generated.'
      };
    }

    const resetToken = randomBytes(32).toString('hex');
    const resetExpires = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes expiry

    await prisma.user.update({
      where: { id: user.id },
      data: {
        passwordResetToken: resetToken,
        passwordResetExpires: resetExpires
      }
    });

    const resetUrl = `http://localhost:3000/reset-password?token=${resetToken}`;
    console.log(`[PASSWORD RESET LINK for ${email}]: ${resetUrl}`);

    return {
      status: 'success',
      message: 'Password reset link generated.',
      // For development, we return the token in the response payload to allow easy testing.
      ...(process.env.NODE_ENV !== 'production' && { resetUrl, resetToken })
    };
  });

  // @route   POST /api/auth/reset-password
  // @desc    Verify reset token and update user password
  fastify.post('/reset-password', async (request, reply) => {
    const { token, password } = request.body as any;

    if (!token || !password) {
      throw new AppError('Token and password are required.', 400);
    }

    const user = await prisma.user.findUnique({
      where: { passwordResetToken: token }
    });

    if (!user || !user.passwordResetExpires || user.passwordResetExpires < new Date()) {
      throw new AppError('Token is invalid or has expired.', 400);
    }

    // Update password
    const hashedPassword = await bcrypt.hash(password, 12);
    await prisma.user.update({
      where: { id: user.id },
      data: {
        password: hashedPassword,
        passwordResetToken: null,
        passwordResetExpires: null
      }
    });

    // Revoke all active sessions for this user
    await prisma.userSession.updateMany({
      where: { userId: user.id, isActive: true },
      data: { isActive: false }
    });

    return {
      status: 'success',
      message: 'Password reset successfully. Please log in with your new password.'
    };
  });

  // @route   GET /api/auth/accessible-tenants
  // @desc    Returns list of tenants the current user can access based on hierarchy
  fastify.get('/accessible-tenants', { preHandler: protect }, async (request, reply) => {
    const user = request.user!;
    const roleLevel = user.roleLevel || (user.role === 'super_admin' ? 'L0_PLATFORM' : 'L4_AGENT');

    let tenants: { id: string; name: string; slug: string; status: string }[] = [];

    if (roleLevel === 'L0_PLATFORM') {
      tenants = await prisma.tenant.findMany({
        select: { id: true, name: true, slug: true, status: true },
        orderBy: { name: 'asc' }
      });
    } else if (roleLevel === 'L1_GROUP') {
      tenants = user.groupId
        ? await prisma.tenant.findMany({
            where: { groupId: user.groupId },
            select: { id: true, name: true, slug: true, status: true },
            orderBy: { name: 'asc' }
          })
        : [];
    } else {
      if (user.tenantId) {
        const tenant = await prisma.tenant.findUnique({
          where: { id: user.tenantId },
          select: { id: true, name: true, slug: true, status: true }
        });
        if (tenant) tenants = [tenant];
      }
    }

    return {
      status: 'success',
      data: tenants
    };
  });
}

