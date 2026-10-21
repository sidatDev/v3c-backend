import { randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';

export interface AuditLogData {
  userId?: number | string | null;
  tenantId?: string | null;
  action: string;
  entity: string;
  entityId?: string | null;
  changeDiff?: Record<string, any> | null;
  ipAddress?: string | null;
  userAgent?: string | null;
}

/**
 * Append-only Audit Log utility.
 * STRICT SECURITY INVARIANT: Only prisma.auditLog.create is invoked.
 * No update or delete operations are exposed anywhere.
 */
export const logAudit = async (
  prisma: PrismaClient | any,
  userId: number | string | null | undefined,
  action: string,
  entity: string,
  entityId?: string | null,
  changeDiff?: Record<string, any> | null,
  ipAddress?: string | null
): Promise<void> => {
  try {
    let parsedUserId: number | null = null;
    if (typeof userId === 'number') {
      parsedUserId = userId;
    } else if (typeof userId === 'string') {
      const parsed = parseInt(userId, 10);
      if (!isNaN(parsed)) {
        parsedUserId = parsed;
      }
    }

    await prisma.auditLog.create({
      data: {
        id: randomUUID(),
        userId: parsedUserId,
        action,
        entity,
        resourceType: entity,
        entityId: entityId || null,
        resourceId: entityId || null,
        changeDiff: changeDiff || null,
        details: changeDiff || null,
        ipAddress: ipAddress || null,
        createdAt: new Date(),
      },
    });
  } catch (err: any) {
    console.error('[AUDIT LOG ERROR] Failed to record append-only audit log:', {
      action,
      entity,
      entityId,
      error: err?.message || err,
    });
  }
};

export default logAudit;
