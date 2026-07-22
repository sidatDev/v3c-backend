import { TokenPayload } from '../utils/jwt';
import { AuditDetails } from '../middleware/audit';

declare module 'fastify' {
  interface FastifyRequest {
    user?: TokenPayload;
    auditLog?: AuditDetails;
  }
}
