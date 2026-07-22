import Fastify from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

import multipart from '@fastify/multipart';
import authRoutes from './routes/auth';
import rolesRoutes from './routes/roles';
import dashboardRoutes from './routes/dashboard';
import conversationsRoutes from './routes/conversations';
import widgetRoutes from './routes/widget';
import knowledgeBaseRoutes from './routes/knowledge-base';
import integrationsRoutes from './routes/integrations';
import teamRoutes from './routes/team';
import domainRoutes from './routes/domain';
import accountRoutes from './routes/account';
import notificationsRoutes from './routes/notifications';
import { errorHandler } from './middleware/error';
import { auditLoggerHook } from './middleware/audit';

const app = Fastify({
  logger: false,
});

// 1. Register CORS
app.register(cors, {
  origin: ['http://localhost:3000', 'http://127.0.0.1:3000'],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept', 'Origin']
});

// 2. Register Cookie Parser & Multipart
app.register(cookie);
app.register(multipart, { limits: { fileSize: 50 * 1024 * 1024 } }); // 50MB limit

// 3. Register Global Audit Logger Hook
app.addHook('onResponse', auditLoggerHook);

// 4. Register API Route Plugins
app.register(authRoutes, { prefix: '/api/auth' });
app.register(rolesRoutes, { prefix: '/api/roles' });
app.register(dashboardRoutes, { prefix: '/api/dashboard' });
app.register(conversationsRoutes, { prefix: '/api/conversations' });
app.register(widgetRoutes, { prefix: '/api/widget' });
app.register(knowledgeBaseRoutes, { prefix: '/api/kb' });
app.register(integrationsRoutes, { prefix: '/api/integrations' });
app.register(teamRoutes, { prefix: '/api/team' });
app.register(domainRoutes, { prefix: '/api/domain' });
app.register(accountRoutes, { prefix: '/api/account' });
app.register(notificationsRoutes, { prefix: '/api/notifications' });

// Health Check
app.get('/health', async (request, reply) => {
  return { status: 'ok', timestamp: new Date() };
});

// 5. Global Error Handler
app.setErrorHandler(errorHandler);

export default app;
