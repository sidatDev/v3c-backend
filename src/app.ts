import Fastify from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

import websocket from '@fastify/websocket';
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
import aiSearchRoutes from './routes/ai-search';
import agentsRoutes from './routes/agents';
import inboxRoutes from './routes/inbox';
import aiLogsRoutes from './routes/ai-logs';
import analyticsRoutes from './routes/analytics';
import publicRoutes from './routes/public';
import { errorHandler } from './middleware/error';
import { auditLoggerHook } from './middleware/audit';

const app = Fastify({
  logger: false,
});

// 1. Register CORS
const allowedOrigins: (string | RegExp)[] = [
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  /\.vercel\.app$/,
  /\.sidattech\.com$/
];

if (process.env.ADMIN_PANEL_URL) {
  allowedOrigins.push(process.env.ADMIN_PANEL_URL);
}

app.register(cors, {
  origin: allowedOrigins,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH']
});

import rateLimit from '@fastify/rate-limit';

// 2. Register Rate Limit, Cookie Parser, Multipart, and WebSocket
app.register(rateLimit, {
  max: 100,
  timeWindow: '1 minute',
  keyGenerator: (req) => {
    const ip = req.headers['x-forwarded-for'] || req.ip;
    const body = (req.body as any) || {};
    const query = (req.query as any) || {};
    const slug = body.slug || query.slug || '';
    return slug ? `${ip}-${slug}` : `${ip}`;
  },
  errorResponseBuilder: (req, context) => ({
    statusCode: 429,
    error: 'Too Many Requests',
    message: `Rate limit exceeded. Try again in ${Math.ceil(context.ttl / 1000)} seconds.`
  })
});

app.register(cookie);
app.register(multipart, { limits: { fileSize: 50 * 1024 * 1024 } }); // 50MB limit
app.register(websocket);

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
app.register(aiSearchRoutes, { prefix: '/api/ai-search' });
app.register(agentsRoutes, { prefix: '/api/agents' });
app.register(inboxRoutes, { prefix: '/api/inbox' });
app.register(aiLogsRoutes, { prefix: '/api/ai-logs' });
app.register(analyticsRoutes, { prefix: '/api/analytics' });
app.register(publicRoutes, { prefix: '/api/public' });

// Health Check
app.get('/health', async (request, reply) => {
  return { status: 'ok', timestamp: new Date() };
});

// 5. Global Error Handler
app.setErrorHandler(errorHandler);

export default app;
