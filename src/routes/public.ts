import { FastifyInstance, FastifyPluginOptions } from 'fastify';
import WebSocket from 'ws';
import { randomUUID } from 'crypto';
import prisma from '../lib/prisma';
import { AppError } from '../middleware/error';
import { openai, generateEmbedding } from '../utils/openai';

export default async function publicRoutes(fastify: FastifyInstance, options: FastifyPluginOptions) {

  // Helper to validate Public Key & Agent ID
  async function validatePublicAccess(publicKey?: string, agentId?: string) {
    let domain = null;
    let tenantId = null;

    if (publicKey) {
      domain = await prisma.domain.findFirst({
        where: { publicKey },
        include: { Tenant: true }
      });
      if (domain) {
        tenantId = domain.tenantId;
      }
    }

    let agent = null;
    if (agentId) {
      agent = await prisma.agent.findFirst({
        where: { id: agentId }
      });
      if (agent && !tenantId) {
        tenantId = agent.tenantId;
      }
    }

    if (!agent && tenantId) {
      agent = await prisma.agent.findFirst({
        where: { tenantId }
      });
    }

    // Fallback: If no publicKey or agentId specified (or invalid), pick default active agent in DB for testing
    if (!agent) {
      agent = await prisma.agent.findFirst({
        where: { isActive: true }
      });
      if (agent) {
        tenantId = agent.tenantId;
      }
    }

    if (!tenantId || !agent) {
      throw new AppError('Invalid public key or agent ID. No default agent configured.', 404);
    }

    const tenant = await prisma.tenant.findUnique({
      where: { id: tenantId }
    });

    const widgetConfig = await prisma.widgetConfig.findFirst({
      where: { tenantId }
    });

    return { domain, tenant, agent, widgetConfig, tenantId };
  }

  // @route   GET /api/public/widget
  // @desc    Get widget configuration & tenant metadata for public embedding
  fastify.get('/widget', async (request, reply) => {
    const { publicKey, agentId } = request.query as { publicKey?: string; agentId?: string };

    const { tenant, agent, widgetConfig, tenantId } = await validatePublicAccess(publicKey, agentId);

    const quickQuestions = await prisma.quickQuestion.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'asc' }
    });

    // Check if domain/widget is active
    const isActive = widgetConfig?.isActive ?? true;

    return {
      status: 'success',
      data: {
        tenant: {
          id: tenant?.id,
          name: tenant?.name,
          slug: tenant?.slug
        },
        agent: {
          id: agent.id,
          name: agent.name,
          voice: agent.voice || 'alloy',
          language: agent.language || 'English',
          systemPrompt: agent.systemPrompt,
          initialGreetingMessage: agent.initialGreetingMessage || 'Hi! How can I help you today?',
          defaultMode: agent.defaultMode || 'VOICE',
          widgetMode: agent.widgetMode || 'BOTH',
          accentColor: agent.accentColor || '#bef264',
          launcherStyle: agent.launcherStyle || 'orb'
        },
        widget: {
          isActive,
          style: widgetConfig?.style || 'Style 1',
          allowedCountries: widgetConfig?.allowedCountries || [],
          interactionLimit: widgetConfig?.interactionLimit || 10,
          allowLeadForm: widgetConfig?.allowLeadForm ?? true,
          enableAiBrowser: widgetConfig?.enableAiBrowser ?? true,
          showQuickQuestions: widgetConfig?.showQuickQuestions ?? false,
          showPreSessionForm: widgetConfig?.showPreSessionForm ?? true,
          quickQuestionsMode: widgetConfig?.quickQuestionsMode || 'auto',
          defaultMode: widgetConfig?.defaultMode || 'VOICE',
          widgetMode: widgetConfig?.widgetMode || 'BOTH'
        },
        quickQuestions: quickQuestions.map(q => ({
          id: q.id,
          questionText: q.question,
          defaultAnswer: q.defaultAnswer
        }))
      }
    };
  });

  // @route   POST /api/public/session
  // @desc    Create a new visitor session
  fastify.post('/session', async (request, reply) => {
    const { publicKey, agentId, referrer, landingPage } = request.body as {
      publicKey?: string;
      agentId?: string;
      referrer?: string;
      landingPage?: string;
    };

    const { domain, tenantId, agent } = await validatePublicAccess(publicKey, agentId);

    // Create or find anonymous visitor
    const visitorSecureId = `visitor-${Math.random().toString(36).substring(2, 10)}`;
    const visitor = await prisma.visitor.create({
      data: {
        secureId: visitorSecureId,
        tenantId,
        domainId: domain?.id,
        lastActivity: new Date(),
        updatedAt: new Date()
      }
    });

    const session = await prisma.visitorSession.create({
      data: {
        secureId: `sess-${randomUUID()}`,
        visitorId: visitor.id,
        tenantId,
        domainId: domain?.id,
        aiAgentId: agent.id,
        referrer: referrer || null,
        landingPage: landingPage || null,
        startedAt: new Date(),
        updatedAt: new Date()
      }
    });

    return {
      status: 'success',
      data: {
        sessionId: session.id,
        sessionSecureId: session.secureId,
        visitorSecureId: visitor.secureId
      }
    };
  });

  // @route   POST /api/public/chat
  // @desc    Public text chat endpoint with RAG context & multi-language support
  fastify.post('/chat', async (request, reply) => {
    const { sessionId, agentId, publicKey, message, language = 'en' } = request.body as {
      sessionId?: number;
      agentId?: string;
      publicKey?: string;
      message: string;
      language?: string;
    };

    if (!message || message.trim() === '') {
      throw new AppError('Message content cannot be empty', 400);
    }

    const { tenantId, agent } = await validatePublicAccess(publicKey, agentId);

    // 1. Save Visitor Message to DB if sessionId provided
    let dbSession = null;
    let leadIdToUse: number | null = null;

    if (sessionId) {
      dbSession = await prisma.visitorSession.findFirst({
        where: { id: Number(sessionId), tenantId }
      });

      if (dbSession) {
        // Find existing lead or create an anonymous lead for this session
        let lead = await prisma.lead.findFirst({
          where: { visitorSessionId: dbSession.id }
        });

        if (!lead) {
          lead = await prisma.lead.create({
            data: {
              name: 'Visitor Lead',
              tenantId,
              aiAgentId: agent.id,
              visitorId: dbSession.visitorId,
              visitorSessionId: dbSession.id,
              status: 'new',
              updatedAt: new Date()
            }
          });
        }
        leadIdToUse = lead.id;

        await prisma.conversation.create({
          data: {
            tenantId,
            aiAgentId: agent.id,
            visitorId: dbSession.visitorId,
            visitorSessionId: dbSession.id,
            sender: 'visitor',
            message: message.trim(),
            leadId: leadIdToUse
          }
        });
      }
    }

    // 2. Perform RAG Search against DocumentChunk / CrawledPage embeddings
    let contextText = '';
    const sources: { title: string; url?: string }[] = [];

    try {
      const queryEmbedding = await generateEmbedding(message);
      const embeddingSql = `[${queryEmbedding.join(',')}]`;

      const vectorResults: any[] = await prisma.$queryRawUnsafe(`
        SELECT id, content, metadata, 1 - (embedding <=> '${embeddingSql}'::vector) as similarity
        FROM "DocumentChunk"
        WHERE "tenantId" = '${tenantId}'
        ORDER BY embedding <=> '${embeddingSql}'::vector ASC
        LIMIT 4;
      `);

      if (vectorResults && vectorResults.length > 0) {
        contextText = vectorResults
          .filter(r => r.similarity > 0.3)
          .map(r => r.content)
          .join('\n---\n');

        vectorResults.forEach(r => {
          if (r.metadata && (r.metadata as any).filename) {
            sources.push({ title: (r.metadata as any).filename });
          } else if (r.metadata && (r.metadata as any).title) {
            sources.push({ title: (r.metadata as any).title, url: (r.metadata as any).url });
          }
        });
      }
    } catch (err) {
      console.warn('RAG embedding search failed or pgvector not available, continuing with fallback prompt:', err);
    }

    // 3. Construct System Prompt with Language Constraints
    const languageInstruction = language === 'ur'
      ? 'CRITICAL: You MUST respond ONLY in Urdu (اردو). Use proper Urdu vocabulary and script.'
      : 'CRITICAL: You MUST respond ONLY in English.';

    const systemPrompt = `
${agent.systemPrompt || 'You are a helpful customer support assistant for V3C.'}

${languageInstruction}

Use the following reference knowledge base context to answer user questions when applicable:
${contextText || 'No relevant knowledge base context found.'}

If you don't know the answer, politely offer to assist or escalate to a human agent. Keep responses clear, professional, and concise.
`.trim();

    // 4. Generate AI Response via OpenAI Chat Completions
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: message }
      ],
      temperature: 0.7,
      max_tokens: 500
    });

    const aiReply = completion.choices[0]?.message?.content || 'I am sorry, I could not generate a response right now.';

    // 5. Save AI Reply to DB
    if (dbSession && leadIdToUse) {
      await prisma.conversation.create({
        data: {
          tenantId,
          aiAgentId: agent.id,
          visitorId: dbSession.visitorId,
          visitorSessionId: dbSession.id,
          sender: 'ai',
          message: aiReply,
          leadId: leadIdToUse
        }
      });
    }

    return {
      status: 'success',
      data: {
        reply: aiReply,
        sources: Array.from(new Set(sources.map(s => JSON.stringify(s)))).map(s => JSON.parse(s))
      }
    };
  });

  // @route   POST /api/public/lead
  // @desc    Submit visitor contact details (Lead capture)
  fastify.post('/lead', async (request, reply) => {
    const { sessionId, agentId, publicKey, name, email, phone } = request.body as {
      sessionId?: number;
      agentId?: string;
      publicKey?: string;
      name: string;
      email?: string;
      phone?: string;
    };

    if (!name || name.trim() === '') {
      throw new AppError('Name is required for lead submission', 400);
    }

    const { tenantId, agent } = await validatePublicAccess(publicKey, agentId);

    let visitorSessionId = null;
    let visitorId = null;

    if (sessionId) {
      const dbSession = await prisma.visitorSession.findFirst({
        where: { id: Number(sessionId), tenantId }
      });
      if (dbSession) {
        visitorSessionId = dbSession.id;
        visitorId = dbSession.visitorId;
      }
    }

    const lead = await prisma.lead.create({
      data: {
        name: name.trim(),
        email: email ? email.trim() : null,
        phone: phone ? phone.trim() : null,
        tenantId,
        aiAgentId: agent.id,
        visitorId,
        visitorSessionId,
        status: 'new',
        updatedAt: new Date()
      }
    });

    return {
      status: 'success',
      data: {
        leadId: lead.id,
        message: 'Lead captured successfully'
      }
    };
  });

  // @route   POST /api/public/quick-questions
  // @desc    Generate context-aware AI quick questions for the widget
  fastify.post('/quick-questions', async (request, reply) => {
    const { publicKey, agentId, language = 'en' } = request.body as {
      publicKey?: string;
      agentId?: string;
      language?: string;
    };

    const { agent } = await validatePublicAccess(publicKey, agentId);

    const langText = language === 'ur' ? 'Urdu' : 'English';
    const prompt = `
Based on the following AI agent description/system prompt:
"${agent.systemPrompt || 'Customer support assistant'}"

Generate 3 short, natural, visitor-centric quick question suggestions in ${langText}.
Return ONLY a valid JSON array of strings, for example:
["What are your working hours?", "How can I get started?", "What services do you offer?"]
`.trim();

    try {
      const response = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.7,
        response_format: { type: 'json_object' }
      });

      const raw = response.choices[0]?.message?.content || '{}';
      const parsed = JSON.parse(raw);
      const questionsList = parsed.questions || parsed.data || Object.values(parsed)[0] || [];

      const formatted = Array.isArray(questionsList)
        ? questionsList.slice(0, 4).map((q: any) => typeof q === 'string' ? q : q.text || q.question)
        : ['What services do you provide?', 'How do I contact support?', 'Can you help me get started?'];

      return {
        status: 'success',
        data: {
          questions: formatted.map((text, idx) => ({ id: idx + 1, questionText: text }))
        }
      };
    } catch (err) {
      return {
        status: 'success',
        data: {
          questions: [
            { id: 1, questionText: language === 'ur' ? 'آپ کی خدمات کیا ہیں؟' : 'What services do you offer?' },
            { id: 2, questionText: language === 'ur' ? 'میں کس طرح رابطہ کر سکتا ہوں؟' : 'How can I get in touch?' },
            { id: 3, questionText: language === 'ur' ? 'آپ کی ٹائمنگز کیا ہیں؟' : 'What are your operating hours?' }
          ]
        }
      };
    }
  });

  // @route   POST /api/public/session/end
  // @desc    End visitor session
  fastify.post('/session/end', async (request, reply) => {
    const { sessionId, publicKey } = request.body as { sessionId?: number; publicKey?: string };

    if (!sessionId) {
      return { status: 'success', message: 'No session specified' };
    }

    const session = await prisma.visitorSession.findUnique({
      where: { id: Number(sessionId) }
    });

    if (session) {
      const now = new Date();
      const durationSeconds = Math.round((now.getTime() - new Date(session.startedAt).getTime()) / 1000);

      await prisma.visitorSession.update({
        where: { id: session.id },
        data: {
          endedAt: now,
          duration: durationSeconds,
          updatedAt: now
        }
      });
    }

    return {
      status: 'success',
      data: { message: 'Session ended' }
    };
  });

  // @route   WS /api/public/realtime
  // @desc    WebSocket proxy to OpenAI Realtime Voice API
  fastify.get('/realtime', { websocket: true }, (connection: any, req: any) => {
    const socket: WebSocket = connection.socket || connection;
    const query = (req.query || {}) as {
      sessionId?: string;
      agentId?: string;
      publicKey?: string;
      language?: string;
    };

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      socket.send(JSON.stringify({ type: 'error', message: 'OpenAI API Key not configured on server' }));
      socket.close();
      return;
    }

    const language = query.language === 'ur' ? 'Urdu' : 'English';

    // Establish WebSocket connection to OpenAI Realtime GA API
    const openAiUrl = 'wss://api.openai.com/v1/realtime?model=gpt-realtime-mini';
    const openAiWs = new WebSocket(openAiUrl, {
      headers: {
        Authorization: `Bearer ${apiKey}`
      }
    });

    openAiWs.on('open', async () => {
      console.log('[V3C Realtime] Connected to OpenAI Realtime GA API');

      let selectedVoice = 'alloy';
      let systemPrompt = 'You are an AI Virtual Customer Assistant. Answer questions accurately and politely.';
      let greetingMessage = 'Hello! How can I help you today?';

      try {
        const { agent } = await validatePublicAccess(query.publicKey, query.agentId);
        if (agent.voice) selectedVoice = agent.voice.toLowerCase();
        if (agent.systemPrompt) systemPrompt = agent.systemPrompt;
        if ((agent as any).initialGreetingMessage) greetingMessage = (agent as any).initialGreetingMessage;
      } catch (err) {
        console.warn('[V3C Realtime] Using defaults for voice & system prompt:', err);
      }

      // 1. Send GA session configuration
      const sessionConfig = {
        type: 'session.update',
        session: {
          type: 'realtime',
          instructions: `${systemPrompt}\nLanguage Instruction: You MUST respond ONLY in ${language}. Do not switch languages.`,
          audio: {
            output: {
              voice: selectedVoice
            }
          }
        }
      };
      openAiWs.send(JSON.stringify(sessionConfig));
      console.log(`[V3C Realtime] Session configured. voice=${selectedVoice}`);

      // 2. Trigger opening greeting from server side after a short delay (prevents race condition)
      setTimeout(() => {
        if (openAiWs.readyState === WebSocket.OPEN) {
          const greetingPrompt = language === 'Urdu'
            ? `براہ کرم اردو میں جواب دیں: ${greetingMessage}`
            : greetingMessage;

          openAiWs.send(JSON.stringify({
            type: 'conversation.item.create',
            item: {
              type: 'message',
              role: 'user',
              content: [{ type: 'input_text', text: greetingPrompt }],
            },
          }));

          openAiWs.send(JSON.stringify({ type: 'response.create' }));
          console.log('[V3C Realtime] Greeting triggered from server after delay.');

          // Notify browser that session is ready
          if (socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ type: 'session.ready' }));
          }
        }
      }, 600);
    });

    // Forward messages from Browser -> OpenAI
    socket.on('message', (message: WebSocket.RawData) => {
      if (openAiWs.readyState === WebSocket.OPEN) {
        openAiWs.send(message.toString());
      }
    });

    // Forward messages from OpenAI -> Browser
    openAiWs.on('message', (data: WebSocket.RawData) => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(data.toString());
      }
    });

    // Handle Socket closures and errors
    socket.on('close', () => {
      if (openAiWs.readyState === WebSocket.OPEN) {
        openAiWs.close();
      }
    });

    openAiWs.on('close', () => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.close();
      }
    });

    openAiWs.on('error', (err: any) => {
      console.error('OpenAI Realtime WS Error:', err?.message || err);
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'error', message: err?.message || 'OpenAI WS error' }));
      }
    });

    socket.on('error', (err: any) => {
      console.error('Browser Client WS Error:', err?.message || err);
    });
  });
}
