import { FastifyInstance, FastifyPluginOptions } from 'fastify';
import { randomUUID } from 'crypto';
import prisma from '../lib/prisma';
import { protect } from '../middleware/auth';
import { restrictTo } from '../middleware/rbac';
import { AppError } from '../middleware/error';

export default async function widgetRoutes(fastify: FastifyInstance, options: FastifyPluginOptions) {

  // Helper to ensure WidgetConfig & Agent exist for tenant
  async function getOrCreateWidgetAndAgent(tenantId: string) {
    let widgetConfig = await prisma.widgetConfig.findFirst({
      where: { tenantId }
    });

    if (!widgetConfig) {
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
      where: { tenantId }
    });

    if (!agent) {
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
    const tenantId = request.user!.tenantId;
    if (!tenantId) {
      throw new AppError('Tenant ID missing', 400);
    }

    const { widgetConfig, agent } = await getOrCreateWidgetAndAgent(tenantId);
    const quickQuestions = await prisma.quickQuestion.findMany({
      where: { tenantId },
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
    const tenantId = request.user!.tenantId;
    if (!tenantId) {
      throw new AppError('Tenant ID missing', 400);
    }

    const body = request.body as any;

    const { widgetConfig: existingWidget, agent: existingAgent } = await getOrCreateWidgetAndAgent(tenantId);

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
    const tenantId = request.user!.tenantId;
    if (!tenantId) return { status: 'success', data: [] };

    const questions = await prisma.quickQuestion.findMany({
      where: { tenantId },
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

    reply.status(201);
    return {
      status: 'success',
      data: created
    };
  });

  // @route   DELETE /api/widget/quick-questions/:id
  // @desc    Delete a quick question
  fastify.delete('/quick-questions/:id', { preHandler: [protect, restrictTo('widget', 'edit')] }, async (request, reply) => {
    const tenantId = request.user!.tenantId;
    const id = parseInt((request.params as any).id);

    if (isNaN(id)) {
      throw new AppError('Invalid ID', 400);
    }

    const question = await prisma.quickQuestion.findUnique({ where: { id } });
    if (!question || (tenantId && question.tenantId !== tenantId)) {
      throw new AppError('Question not found', 404);
    }

    await prisma.quickQuestion.delete({ where: { id } });

    return {
      status: 'success',
      message: 'Quick question removed successfully.'
    };
  });

  // @route   GET /api/widget/embed-code
  // @desc    Get website script embed snippet
  fastify.get('/embed-code', { preHandler: [protect, restrictTo('widget', 'view')] }, async (request, reply) => {
    const tenantId = request.user!.tenantId;

    // Get primary domain key for tenant
    const domain = await prisma.domain.findFirst({
      where: { tenantId }
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
