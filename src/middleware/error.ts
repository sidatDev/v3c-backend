import { FastifyRequest, FastifyReply } from 'fastify';

export class AppError extends Error {
  public statusCode: number;
  public isOperational: boolean;

  constructor(message: string, statusCode: number) {
    super(message);
    this.statusCode = statusCode;
    this.isOperational = true;

    Error.captureStackTrace(this, this.constructor);
  }
}

export const errorHandler = (
  error: any,
  request: FastifyRequest,
  reply: FastifyReply
) => {
  const statusCode = error.statusCode || 500;
  const message = error.message || 'Internal Server Error';

  console.error(`[ERROR] ${request.method} ${request.url} - Status: ${statusCode} - Message: ${message}`);
  if (process.env.NODE_ENV !== 'production' && error.stack) {
    console.error(error.stack);
  }

  reply.status(statusCode).send({
    status: 'error',
    message,
    ...(process.env.NODE_ENV !== 'production' && { stack: error.stack }),
  });
};
