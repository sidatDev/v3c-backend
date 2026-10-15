import { TokenPayload } from '../utils/jwt';
import { AuditDetails } from '../middleware/audit';

declare module 'fastify' {
  interface FastifyRequest {
    user?: TokenPayload & {
      id?: number;
      groupId?: string | null;
      departmentId?: string | null;
      roleLevel?: string | null;
      activeTenantId?: string | null;
    };
    auditLog?: AuditDetails;
  }
}
