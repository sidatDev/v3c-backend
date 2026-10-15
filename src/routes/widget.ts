import { FastifyInstance, FastifyPluginOptions } from 'fastify';
import { randomUUID } from 'crypto';
import prisma from '../lib/prisma';
import { protect } from '../middleware/auth';
import { restrictTo } from '../middleware/rbac';
import { AppError } from '../middleware/error';
import { openai } from '../utils/openai';
import { TenantConfigCache } from '../services/cache/TenantConfigCache';
import { applyTenantScope } from '../utils/tenantScope';

export default async function widgetRoutes(fastify: FastifyInstance, options: FastifyPluginOptions) {

  // @route   GET /api/widget/voice-preview
  // @desc    Generate live OpenAI TTS audio preview for selected voice
  fastify.get('/voice-preview', { preHandler: [protect, restrictTo('widget', 'view')] }, async (request, reply) => {
    const query = request.query as any;
    const voice = (query.voice || 'alloy').toLowerCase();

    try {
      const mp3 = await openai.audio.speech.create({
        model: 'tts-1',
        voice: voice as any,
        input: `Hello! This is a preview of the ${voice} voice for your AI assistant.`,
      });

      const buffer = Buffer.from(await mp3.arrayBuffer());
      reply.type('audio/mpeg');
      return reply.send(buffer);
    } catch (err: any) {
      throw new AppError(err?.message || 'Failed to generate voice preview', 500);
    }
  });

  // Helper to ensure WidgetConfig & Agent exist for tenant
  async function getOrCreateWidgetAndAgent(user: any) {
    const tenantId = user?.tenantId;
    let widgetConfig = await prisma.widgetConfig.findFirst({
      where: applyTenantScope({}, user)
    });

    if (!widgetConfig) {
      if (!tenantId) {
        throw new AppError('Tenant ID missing for creating widget config', 400);
      }
      widgetConfig = await prisma.widgetConfig.create({
        data: {
          tenantId,
          style: 'Style 1',
          allowLeadForm: true,
          enableAiBrowser: true,
          showQuickQuestions: false,
          showPreSessionForm: true,
          interactionLimit: 10,
          defaultMode: 'VOICE',
          widgetMode: 'BOTH',
          allowedCountries: [],
          isActive: true,
          updatedAt: new Date()
        }
      });
    }

    let agent = await prisma.agent.findFirst({
      where: applyTenantScope({ isActive: true }, user),
      orderBy: { updatedAt: 'desc' }
    }) || await prisma.agent.findFirst({
      where: applyTenantScope({}, user),
      orderBy: { updatedAt: 'desc' }
    });

    if (!agent) {
      if (!tenantId) {
        throw new AppError('Tenant ID missing for creating agent', 400);
      }
      agent = await prisma.agent.create({
        data: {
          id: randomUUID(),
          tenantId,
          name: 'V3C AI Assistant',
          voice: 'alloy',
          language: 'English',
          systemPrompt: 'You are a helpful customer support assistant for V3C Platform.',
          isActive: true,
          defaultMode: 'VOICE',
          widgetMode: 'BOTH',
          accentColor: '#4F46E5',
          updatedAt: new Date()
        }
      });
    }

    return { widgetConfig, agent };
  }

  // @route   GET /api/widget
  // @desc    Get complete widget configuration (Critical Controls, Access Controls, Appearance, Voice)
  fastify.get('/', { preHandler: [protect, restrictTo('widget', 'view')] }, async (request, reply) => {
    const { widgetConfig, agent } = await getOrCreateWidgetAndAgent(request.user);
    const quickQuestions = await prisma.quickQuestion.findMany({
      where: applyTenantScope({}, request.user),
      orderBy: { createdAt: 'asc' }
    });

    return {
      status: 'success',
      data: {
        widgetConfig,
        agent,
        quickQuestions
      }
    };
  });

  // @route   PUT /api/widget
  // @desc    Update widget & agent configuration
  fastify.put('/', { preHandler: [protect, restrictTo('widget', 'edit')] }, async (request, reply) => {
    const body = request.body as any;

    const { widgetConfig: existingWidget, agent: existingAgent } = await getOrCreateWidgetAndAgent(request.user);

    // Update WidgetConfig
    const updatedWidget = await prisma.widgetConfig.update({
      where: { id: existingWidget.id },
      data: {
        isActive: body.isActive !== undefined ? body.isActive : existingWidget.isActive,
        style: body.style || existingWidget.style,
        allowLeadForm: body.allowLeadForm !== undefined ? body.allowLeadForm : existingWidget.allowLeadForm,
        enableAiBrowser: body.enableAiBrowser !== undefined ? body.enableAiBrowser : existingWidget.enableAiBrowser,
        showQuickQuestions: body.showQuickQuestions !== undefined ? body.showQuickQuestions : existingWidget.showQuickQuestions,
        showPreSessionForm: body.showPreSessionForm !== undefined ? body.showPreSessionForm : existingWidget.showPreSessionForm,
        interactionLimit: body.interactionLimit !== undefined ? parseInt(body.interactionLimit) : existingWidget.interactionLimit,
        defaultMode: body.defaultMode || existingWidget.defaultMode,
        widgetMode: body.widgetMode || existingWidget.widgetMode,
        allowedCountries: Array.isArray(body.allowedCountries) ? body.allowedCountries : existingWidget.allowedCountries,
        updatedAt: new Date()
      }
    });

    // Update Agent (voice selection & appearance)
    const updatedAgent = await prisma.agent.update({
      where: { id: existingAgent.id },
      data: {
        voice: body.voice || existingAgent.voice,
        accentColor: body.accentColor || existingAgent.accentColor,
        defaultMode: body.defaultMode || existingAgent.defaultMode,
        widgetMode: body.widgetMode || existingAgent.widgetMode,
        isActive: body.isActive !== undefined ? body.isActive : existingAgent.isActive,
        updatedAt: new Date()
      }
    });

    // Log update
    request.auditLog = {
      action: 'UPDATE_WIDGET_CONFIG',
      resourceType: 'WidgetConfig',
      resourceId: updatedWidget.id.toString(),
      details: { voice: updatedAgent.voice, isActive: updatedWidget.isActive }
    };

    if (existingWidget.tenantId) TenantConfigCache.invalidate(existingWidget.tenantId);

    return {
      status: 'success',
      data: {
        widgetConfig: updatedWidget,
        agent: updatedAgent
      }
    };
  });

  // @route   GET /api/widget/quick-questions
  // @desc    List quick questions for tenant
  fastify.get('/quick-questions', { preHandler: [protect, restrictTo('widget', 'view')] }, async (request, reply) => {
    const questions = await prisma.quickQuestion.findMany({
      where: applyTenantScope({}, request.user),
      orderBy: { createdAt: 'asc' }
    });

    return {
      status: 'success',
      data: questions
    };
  });

  // @route   POST /api/widget/quick-questions
  // @desc    Add a quick question
  fastify.post('/quick-questions', { preHandler: [protect, restrictTo('widget', 'edit')] }, async (request, reply) => {
    const tenantId = request.user!.tenantId;
    if (!tenantId) {
      throw new AppError('Tenant ID missing', 400);
    }
    const { question, defaultAnswer } = request.body as any;

    if (!question || !defaultAnswer) {
      throw new AppError('Question and default answer are required.', 400);
    }

    const created = await prisma.quickQuestion.create({
      data: {
        question,
        defaultAnswer,
        tenantId,
        updatedAt: new Date()
      }
    });

    TenantConfigCache.invalidate(tenantId);

    reply.status(201);
    return {
      status: 'success',
      data: created
    };
  });

  // @route   DELETE /api/widget/quick-questions/:id
  // @desc    Delete a quick question
  fastify.delete('/quick-questions/:id', { preHandler: [protect, restrictTo('widget', 'edit')] }, async (request, reply) => {
    const id = parseInt((request.params as any).id);

    if (isNaN(id)) {
      throw new AppError('Invalid ID', 400);
    }

    const question = await prisma.quickQuestion.findFirst({
      where: applyTenantScope({ id }, request.user)
    });
    if (!question) {
      throw new AppError('Question not found', 404);
    }

    await prisma.quickQuestion.delete({ where: { id } });

    if (question.tenantId) TenantConfigCache.invalidate(question.tenantId);

    return {
      status: 'success',
      message: 'Quick question removed successfully.'
    };
  });

  // @route   GET /api/widget/embed-code
  // @desc    Get website script embed snippet
  fastify.get('/embed-code', { preHandler: [protect, restrictTo('widget', 'view')] }, async (request, reply) => {
    // Get primary domain key for tenant
    const domain = await prisma.domain.findFirst({
      where: applyTenantScope({}, request.user)
    });

    const publicKey = domain?.publicKey || 'demo-public-key-v3c';
    const widgetUrl = process.env.ADMIN_PANEL_URL || 'http://localhost:3000';

    const embedScript = `<!-- V3C AI Voice & Chat Widget Embed -->
<script 
  src="${widgetUrl}/widget.js" 
  data-public-key="${publicKey}"
  async>
</script>`;

    return {
      status: 'success',
      data: {
        publicKey,
        embedScript
      }
    };
  });
}
