import { FastifyInstance, FastifyPluginOptions } from 'fastify';
import bcrypt from 'bcrypt';
import { randomUUID, randomBytes } from 'crypto';
import prisma from '../lib/prisma';
import { signToken, getCookieOptions } from '../utils/jwt';
import { protect } from '../middleware/auth';
import { AppError } from '../middleware/error';

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
      tenantId: result.tenant.id,
      role: 'manager',
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
        user: {
          id: result.user.id,
          name: result.user.name,
          email: result.user.email,
          role: 'manager',
          tenantId: result.tenant.id,
          companyName: result.tenant.name
        },
        permissions
      }
    };
  });

  // @route   POST /api/auth/login
  // @desc    Log in user and establish active session
  fastify.post('/login', async (request, reply) => {
    const { email, password, rememberMe } = request.body as any;

    if (!email || !password) {
      throw new AppError('Please provide email and password.', 400);
    }

    // Find user
    const user = await prisma.user.findUnique({
      where: { email },
      include: { Tenant: true }
    });

    if (!user || user.status !== 'active' || !(await bcrypt.compare(password, user.password))) {
      throw new AppError('Incorrect email or password.', 401);
    }

    // Get User Roles and Permissions
    const userRoles = await prisma.userRole.findMany({
      where: { userId: user.id },
      include: { Role: true }
    });

    if (userRoles.length === 0) {
      throw new AppError('No roles assigned to this user.', 403);
    }

    // Get primary role (prefer super_admin, then manager, then member)
    let primaryRole = 'member';
    if (userRoles.some(ur => ur.Role.name === 'super_admin')) {
      primaryRole = 'super_admin';
    } else if (userRoles.some(ur => ur.Role.name === 'manager')) {
      primaryRole = 'manager';
    }

    // Get role IDs
    const roleIds = userRoles.map(ur => ur.roleId);

    // Get all permissions for roles
    const rolePermissions = await prisma.rolePermission.findMany({
      where: { roleId: { in: roleIds } },
      include: { Permission: true }
    });
    const permissions = rolePermissions.map(rp => `${rp.Permission.resource}:${rp.Permission.action}`);

    // Create session token
    const tokenPayload = {
      userId: user.id,
      tenantId: user.tenantId,
      role: primaryRole,
      permissions
    };
    const token = signToken(tokenPayload, rememberMe);

    // Set session expiry
    const duration = rememberMe ? 30 * 24 * 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
    const expiresAt = new Date(Date.now() + duration);

    // Save session in database
    await prisma.userSession.create({
      data: {
        id: randomUUID(),
        userId: user.id,
        tenantId: user.tenantId,
        token,
        ipAddress: request.ip || null,
        userAgent: request.headers['user-agent'] || null,
        expiresAt
      }
    });

    // Update user lastLogin
    await prisma.user.update({
      where: { id: user.id },
      data: { lastLogin: new Date() }
    });

    // Log login audit
    request.auditLog = {
      action: 'LOGIN',
      resourceType: 'User',
      resourceId: user.id.toString()
    };

    // Set cookie and respond
    reply.setCookie('token', token, getCookieOptions(rememberMe));
    
    return {
      status: 'success',
      data: {
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
          role: primaryRole,
          tenantId: user.tenantId,
          companyName: user.Tenant?.name || null
        },
        permissions
      }
    };
  });

  // @route   GET /api/auth/me
  // @desc    Get current user profile and permissions from session
  fastify.get('/me', { preHandler: protect }, async (request, reply) => {
    const userPayload = request.user!;
    
    const user = await prisma.user.findUnique({
      where: { id: userPayload.userId },
      include: { Tenant: true }
    });

    if (!user || user.status !== 'active') {
      throw new AppError('User belonging to this token no longer exists.', 401);
    }

    return {
      status: 'success',
      data: {
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
          role: userPayload.role,
          tenantId: user.tenantId,
          companyName: user.Tenant?.name || null,
          image: user.image
        },
        permissions: userPayload.permissions
      }
    };
  });

  // @route   POST /api/auth/logout
  // @desc    Invalidate current session and clear authentication cookie
  fastify.post('/logout', async (request, reply) => {
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
        data: { isActive: false }
      });
    }

    reply.clearCookie('token', {
      path: '/',
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax'
    });
    
    return { status: 'success', message: 'Logged out successfully.' };
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
}
