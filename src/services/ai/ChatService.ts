import prisma from '../../lib/prisma';
import { TenantConfigCache } from '../cache/TenantConfigCache';
import { ConversationService } from './ConversationService';
import { RetrievalService } from './RetrievalService';
import { PromptService } from './PromptService';
import { AiGateway } from './AiGateway';

export interface ChatParams {
  sessionId?: number;
  agentId?: string;
  publicKey?: string;
  slug?: string;
  message: string;
  language?: string;
}

export interface ChatResult {
  reply: string;
  sources: { title: string; url?: string }[];
  fallbackTriggered?: boolean;
  topicLinks?: { title: string; url: string }[];
}

export class ChatService {
  /**
   * Process incoming text chat request using the unified AI pipeline
   */
  static async handleChat(params: ChatParams): Promise<ChatResult> {
    const { sessionId, agentId, publicKey, slug, message, language = 'en' } = params;

    // 1. Resolve Tenant Configuration from Cache
    const tenantConfig = await TenantConfigCache.getTenantConfig(publicKey, agentId, slug);
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
    const threshold = agent.RetrievalConfig?.similarityThreshold ?? 0.3;
    const retrievalResult = await RetrievalService.search(tenantId, message, 5, threshold);

    let reply = '';
    let topicLinks: { title: string; url: string }[] = [];

    // 4. Handle Fallback vs Normal Completion
    if (retrievalResult.fallbackTriggered) {
      // Load topic links for tenant/agent
      const dbTopicLinks = await prisma.agentTopicLink.findMany({
        where: { tenantId, isActive: true },
        orderBy: { displayOrder: 'asc' },
        take: 5
      });

      if (dbTopicLinks.length > 0) {
        topicLinks = dbTopicLinks.map((t: any) => ({ title: t.title, url: t.url }));
      } else {
        // Fallback to CrawledPage entries
        const crawledPages = await prisma.crawledPage.findMany({
          where: { tenantId, enabled: true },
          take: 5
        });
        topicLinks = crawledPages.map((p: any) => ({
          title: p.title || p.url.replace(/^https?:\/\//, ''),
          url: p.url
        }));
      }

      const isUrdu = language === 'ur' || /[\u0600-\u06FF]/.test(message);
      const defaultUrdu = 'معذرت، میں صرف ہماری کمپنی کی خدمات اور ویب سائٹ کی معلومات کا جواب دے سکتا ہوں۔ آپ درج ذیل لنکس وزٹ کر سکتے ہیں:';
      const defaultEnglish = 'I can only answer questions related to our services and official knowledge base. Here are some key pages you can explore:';
      
      const fallbackIntro = isUrdu
        ? (agent.RetrievalConfig?.fallbackMessageUrdu || defaultUrdu)
        : (agent.RetrievalConfig?.fallbackMessage || defaultEnglish);

      reply = fallbackIntro;
    } else {
      // 5. Construct Unified System Prompt & Messages
      const messages = PromptService.buildMessages({
        tenantConfig,
        retrievedContext: retrievalResult.contextText,
        summary,
        recentMessages,
        currentMessage: message,
        language
      });

      // Execute AI Completion via AiGateway
      const completion = await AiGateway.complete({
        messages,
        tenantId,
        sessionId,
        mode: 'chat'
      });

      reply = completion.reply;
    }

    // 6. Save AI Reply to DB
    if (dbSession && leadId) {
      await ConversationService.saveMessage({
        tenantId,
        agentId: agent.id,
        sessionId: dbSession.id,
        visitorId: dbSession.visitorId,
        leadId,
        sender: 'ai',
        message: reply
      });
    }

    return {
      reply,
      sources: retrievalResult.sources,
      fallbackTriggered: retrievalResult.fallbackTriggered,
      topicLinks
    };
  }
}
