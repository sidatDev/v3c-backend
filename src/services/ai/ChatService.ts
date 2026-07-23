import { TenantConfigCache } from '../cache/TenantConfigCache';
import { ConversationService } from './ConversationService';
import { RetrievalService } from './RetrievalService';
import { PromptService } from './PromptService';
import { AiGateway } from './AiGateway';

export interface ChatParams {
  sessionId?: number;
  agentId?: string;
  publicKey?: string;
  message: string;
  language?: string;
}

export interface ChatResult {
  reply: string;
  sources: { title: string; url?: string }[];
}

export class ChatService {
  /**
   * Process incoming text chat request using the unified AI pipeline
   */
  static async handleChat(params: ChatParams): Promise<ChatResult> {
    const { sessionId, agentId, publicKey, message, language = 'en' } = params;

    // 1. Resolve Tenant Configuration from Cache
    const tenantConfig = await TenantConfigCache.getTenantConfig(publicKey, agentId);
    const { tenantId, agent } = tenantConfig;

    // 2. Load Session Memory & Save Visitor Message
    let dbSession = null;
    let leadId: number | null = null;
    let recentMessages: any[] = [];
    let summary: string | undefined = undefined;

    if (sessionId) {
      const sessionCtx = await ConversationService.getSessionContext(sessionId, tenantId);
      dbSession = sessionCtx.dbSession;
      leadId = sessionCtx.leadId;
      recentMessages = sessionCtx.recentMessages;
      summary = sessionCtx.summary;

      // Save visitor message to DB
      if (dbSession && leadId) {
        await ConversationService.saveMessage({
          tenantId,
          agentId: agent.id,
          sessionId: dbSession.id,
          visitorId: dbSession.visitorId,
          leadId,
          sender: 'visitor',
          message
        });
      }
    }

    // 3. Perform Retrieval-Augmented Generation (RAG)
    const retrievalResult = await RetrievalService.search(tenantId, message, 5, 0.1);

    // 4. Construct Unified System Prompt & Messages
    const messages = PromptService.buildMessages({
      tenantConfig,
      retrievedContext: retrievalResult.contextText,
      summary,
      recentMessages,
      currentMessage: message,
      language
    });

    // 5. Execute AI Completion via AiGateway
    const completion = await AiGateway.complete({
      messages,
      tenantId,
      sessionId,
      mode: 'chat'
    });

    // 6. Save AI Reply to DB
    if (dbSession && leadId) {
      await ConversationService.saveMessage({
        tenantId,
        agentId: agent.id,
        sessionId: dbSession.id,
        visitorId: dbSession.visitorId,
        leadId,
        sender: 'ai',
        message: completion.reply
      });
    }

    return {
      reply: completion.reply,
      sources: retrievalResult.sources
    };
  }
}
