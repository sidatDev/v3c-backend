import { FastifyRequest, FastifyReply } from 'fastify';
import { AppError } from './error';
import { Resource, Action } from '../constants/permissions';

export const restrictTo = (resource: Resource, action: Action) => {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.user) {
      throw new AppError('You are not authenticated.', 401);
    }

    const { role, permissions } = request.user;

    // Super admins always have full access
    if (role === 'super_admin') {
      return;
    }

    // Check if user has specific permission, or manage permission for this resource
    const hasPermission = 
      permissions.includes(`${resource}:${action}`) || 
      permissions.includes(`${resource}:manage`);

    if (!hasPermission) {
      throw new AppError('You do not have permission to perform this action.', 403);
    }
  };
};
