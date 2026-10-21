import { FastifyInstance, FastifyPluginOptions } from 'fastify';
import { ChannelGateway, V3CMessage } from '../services/gateway/ChannelGateway';
import { WhatsAppSenderService } from '../services/whatsapp/WhatsAppSenderService';
import { WhatsAppSessionService, WhatsAppSessionContext } from '../services/whatsapp/WhatsAppSessionService';
import { ChatService } from '../services/ai/ChatService';
import { OrchestratorService } from '../services/orchestrator/OrchestratorService';
import { ScopeGuard } from '../services/orchestrator/ScopeGuard';

// 5-minute in-memory deduplication cache for Meta message IDs
const DEDUP_TTL_MS = 5 * 60 * 1000;
const processedMessageIds = new Map<string, number>();

function isDuplicateAndMark(messageId: string): boolean {
  const now = Date.now();

  // Periodically sweep expired entries if map grows
  if (processedMessageIds.size > 1000) {
    for (const [id, expiresAt] of processedMessageIds.entries()) {
      if (expiresAt < now) {
        processedMessageIds.delete(id);
      }
    }
  }

  const existingExpires = processedMessageIds.get(messageId);
  if (existingExpires && existingExpires > now) {
    return true;
  }

  processedMessageIds.set(messageId, now + DEDUP_TTL_MS);
  return false;
}

interface PendingReplyTask {
  messageId: string;
  from: string;
  text: string;
  sessionCtx: WhatsAppSessionContext | null;
  v3cMessage: V3CMessage;
}

export default async function whatsappRoutes(fastify: FastifyInstance, options: FastifyPluginOptions) {
  // @route   GET /api/whatsapp/webhook
  // @desc    Meta Webhook Verification Handshake
  fastify.get('/webhook', async (request, reply) => {
    try {
      const query = (request.query || {}) as Record<string, string | undefined>;
      const mode = query['hub.mode'];
      const token = query['hub.verify_token'];
      const challenge = query['hub.challenge'];

      const expectedToken = process.env.WHATSAPP_VERIFY_TOKEN;

      if (mode === 'subscribe' && token && expectedToken && token === expectedToken) {
        return reply.status(200).type('text/plain').send(challenge || '');
      }

      return reply.status(403).type('text/plain').send('Forbidden');
    } catch (err: any) {
      return reply.status(403).type('text/plain').send('Forbidden');
    }
  });

  // @route   POST /api/whatsapp/webhook
  // @desc    Meta Cloud API Incoming Message Receiver with Instant 200 and Background AI Reply
  fastify.post('/webhook', async (request, reply) => {
    console.log('[WHATSAPP DEBUG] Incoming request:', request.url, request.headers, request.body);

    const pendingTasks: PendingReplyTask[] = [];

    try {
      const body = request.body as any;

      if (body && Array.isArray(body.entry)) {
        for (const entry of body.entry) {
          if (!entry || !Array.isArray(entry.changes)) continue;

          for (const change of entry.changes) {
            const value = change?.value;
            if (!value) continue;

            const phoneNumberId = value.metadata?.phone_number_id || 'unknown';
            const messages = value.messages;

            if (Array.isArray(messages)) {
              for (const message of messages) {
                // Ignore non-text types (audio, image, status, echoes)
                if (message?.type === 'text' && message.text?.body && message.id) {
                  // Deduplication check: skip if already processed within TTL
                  if (isDuplicateAndMark(message.id)) {
                    console.log(`[WHATSAPP DEDUP] Skipping duplicate message ID: ${message.id}`);
                    continue;
                  }

                  const from = message.from || 'unknown';
                  const textBody = message.text.body;

                  // Resolve tenant, visitor, and persistent session
                  let sessionCtx: WhatsAppSessionContext | null = null;
                  try {
                    sessionCtx = await WhatsAppSessionService.resolveWhatsAppSession(from);
                  } catch (sessionErr: any) {
                    console.error('[WHATSAPP] Failed to resolve session for sender:', from, sessionErr?.message || sessionErr);
                  }

                  const tenantId = sessionCtx?.tenant?.id || 'whatsapp-pending-mapping';
                  const sessionId = sessionCtx?.session?.id ? String(sessionCtx.session.id) : `${phoneNumberId}:${from}`;

                  // Observation ingestion via ChannelGateway
                  let ingestedMsg: V3CMessage | null = null;
                  try {
                    ingestedMsg = ChannelGateway.ingest({
                      channel: 'whatsapp',
                      tenantId,
                      sessionId,
                      content: textBody,
                      language: 'unknown',
                      metadata: {
                        type: message.type,
                        from: message.from,
                        messageId: message.id,
                        timestamp: message.timestamp,
                      },
                    });
                  } catch (gwErr: any) {
                    console.error('[WHATSAPP GATEWAY ERROR]', gwErr?.message || gwErr);
                  }

                  const v3cMessage: V3CMessage = ingestedMsg || {
                    messageId: message.id,
                    channel: 'whatsapp',
                    tenantId,
                    sessionId,
                    language: 'unknown',
                    content: textBody,
                    metadata: {
                      type: message.type,
                      from: message.from,
                      messageId: message.id,
                      timestamp: message.timestamp,
                    },
                    receivedAt: new Date().toISOString(),
                  };

                  pendingTasks.push({
                    messageId: message.id,
                    from,
                    text: textBody,
                    sessionCtx,
                    v3cMessage,
                  });
                }
              }
            }
          }
        }
      }
    } catch (err: any) {
      console.error('[WHATSAPP WEBHOOK ERROR]', err?.message || err);
    }

    // Always reply 200 with { success: true } immediately, before any AI processing
    reply.status(200).send({ success: true });

    // Background asynchronous AI reply loop (runs after 200 is sent)
    if (pendingTasks.length > 0) {
      setImmediate(async () => {
        for (const task of pendingTasks) {
          try {
            // a. Mark message as read so user sees blue ticks
            await WhatsAppSenderService.markAsRead(task.messageId);

            if (!task.sessionCtx || !task.sessionCtx.tenant) {
              console.error(`[WHATSAPP] reply failed: no tenant resolved for sender ${task.from}`);
              continue;
            }

            // Orchestrator Scope Gate
            const decision = await OrchestratorService.decide(task.v3cMessage);
            if (!decision.approved) {
              // If rejected: send REFUSAL_TEXT via WhatsAppSenderService.sendLongText. Skip ChatService entirely.
              await WhatsAppSenderService.sendLongText(task.from, ScopeGuard.REFUSAL_TEXT);
              console.log(`[WHATSAPP] sent refusal to ${task.from} for message id ${task.messageId} (reason: ${decision.reason})`);
              continue;
            }

            // Orchestrator Dynamic Agent Routing
            let routedAgentId = task.sessionCtx.agent?.id;
            try {
              const routing = await OrchestratorService.routeMessage(
                task.sessionCtx.tenant.id,
                task.text,
                task.sessionCtx.session?.id ? String(task.sessionCtx.session.id) : undefined,
                task.from
              );
              if (routing?.agentId) {
                routedAgentId = routing.agentId;
              }
            } catch (routeErr: any) {
              console.warn('[ROUTING_FALLBACK] WhatsApp Orchestrator routeMessage failed, using default agent:', routeErr?.message || routeErr);
            }

            // b. If approved: Run ChatService RAG pipeline
            const chatResult = await ChatService.processMessage({
              sessionId: Number(task.sessionCtx.session.id),
              slug: task.sessionCtx.tenant.slug,
              agentId: routedAgentId,
              message: task.text,
              language: 'unknown',
            });

            const replyText = chatResult.reply;

            // c. Send outbound response via WhatsAppSenderService
            await WhatsAppSenderService.sendLongText(task.from, replyText);

            // d. Structured log
            console.log(`[WHATSAPP] reply sent with message id ${task.messageId} to ${task.from}`);
          } catch (replyErr: any) {
            console.error(`[WHATSAPP] reply failed for message id ${task.messageId}:`, replyErr?.message || replyErr);
          }
        }
      });
    }
  });
}
