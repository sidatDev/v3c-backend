import { FastifyRequest, FastifyReply } from 'fastify';
import { randomUUID } from 'crypto';
import prisma from '../lib/prisma';

export interface AuditDetails {
  action: string;
  resourceType: string;
  resourceId?: string;
  details?: any;
}

export const auditLoggerHook = async (request: FastifyRequest, reply: FastifyReply) => {
  try {
    if (request.auditLog && reply.statusCode >= 200 && reply.statusCode < 300) {
      const { action, resourceType, resourceId, details } = request.auditLog;
      const userId = request.user ? request.user.userId : null;
      const tenantId = request.user ? request.user.tenantId : null;
      
      await prisma.auditLog.create({
        data: {
          id: randomUUID(),
          userId,
          tenantId,
          action,
          resourceType,
          resourceId: resourceId || null,
          details: details || null,
          ipAddress: request.ip || request.socket.remoteAddress || null,
          userAgent: request.headers['user-agent'] || null,
        }
      });
    }
  } catch (err) {
    console.error('Audit log failed to record:', err);
  }
};
