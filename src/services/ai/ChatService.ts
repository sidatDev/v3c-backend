import prisma from '../../lib/prisma';
import { TenantConfigCache } from '../cache/TenantConfigCache';
import { ConversationService } from './ConversationService';
import { RetrievalService } from './RetrievalService';
import { PromptService } from './PromptService';
import { AiGateway } from './AiGateway';
import { SecurityShieldService } from '../security/SecurityShieldService';

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

    // 2. Security Shield: Prompt Injection Detector
    const injectionMatch = SecurityShieldService.detectPromptInjection(message);
    if (injectionMatch) {
      const isUrdu = language === 'ur' || /[\u0600-\u06FF]/.test(message);
      const refusalMsg = isUrdu
        ? 'معذرت، میں آپ کی اس درخواست کا جواب نہیں دے سکتا۔ میں صرف ہماری کمپنی کی سروسز میں مدد کر سکتا ہوں۔'
        : 'I cannot fulfill requests attempting to alter system instructions. How can I assist you with our services today?';
      return {
        reply: refusalMsg,
        sources: [],
        fallbackTriggered: true
      };
    }

    // 3. Load Session Memory & Save Visitor Message
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

      // Turn Cap Check for Chat (max 40 messages)
      if (recentMessages.length >= 40) {
        const isUrdu = language === 'ur' || /[\u0600-\u06FF]/.test(message);
        const capNotice = isUrdu
          ? 'آپ کے سیشن کی گفتگو کی حد مکمل ہو چکی ہے۔ مزید معلومات کے لیے اپنا نمبر چھوڑ دیں۔'
          : 'You have reached the session conversation limit. Please leave your contact details so our support team can follow up with you.';
        return {
          reply: capNotice,
          sources: [],
          fallbackTriggered: true
        };
      }

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

    }

    // Insurance keyword safety net — detect insurance-related terms in any language before refusing
    const INSURANCE_KEYWORDS = /\b(insurance|insur|claim|claims|policy|policies|premium|motor|health|travel|marine|fire|engineering|corporate|accident|theft|comprehensive|third.?party|coverage|renewal|renew|hospital|medical|baggage|cargo|indemnity|liability|انشورنس|کلیم|پالیسی|موٹر|ہیلتھ|ٹریول|گاڑی|ایکسیڈنٹ|چوری|ہسپتال|میڈیکل|بیمہ|سامان|کارگو|آگ|فائر|سمندری|انجینئرنگ|کمپریہنسیو|تھرڈ|پارٹی|کوریج|ری?نیوال|پریمیم)\b/i;
    const hasInsuranceKeyword = INSURANCE_KEYWORDS.test(message);

    const isFollowUp = recentMessages.length > 0 && (
      message.split(/\s+/).length < 7 || 
      /\b(it|other|others|this|that|also|more|cost|price|details|besides|difference|compare|dono|doosri|doosra|elawa|alawa|aur|batao|konsa|konsi|mazeed|pehla|dosra|teesra|farq|muqabla|دوسرا|دوسری|علاوہ|اور|بتاؤ|مزید|پہلا|تیسرا|فرق|مقابلہ|درمیان|ڈیفرنس)\b/i.test(message)
    );

    let contextDirective: string;
    if (retrievalResult.fallbackTriggered) {
      if (isFollowUp || hasInsuranceKeyword) {
        contextDirective = hasInsuranceKeyword && !isFollowUp
          ? `[INSURANCE QUERY — LOW RETRIEVAL MATCH]: The user asked about ${agent.name} insurance services but no exact knowledge base chunk matched. Answer the query naturally and helpfully in ${language} using your knowledge of ${agent.name} products. If you don't have specific details, offer to connect them with official ${agent.name} support channels.`
          : `[TURN DIRECTIVE]: Answer the user's follow-up query naturally and accurately in ${language} using recent conversation history regarding ${agent.name} services.`;
      } else {
        contextDirective = `[STRICT OUT-OF-SCOPE DIRECTIVE]: The query is NOT related to insurance. You MUST politely refuse in ${language}. State clearly that you are the AI assistant for ${agent.name} and can only assist with ${agent.name} insurance services. Under NO circumstances provide instructions, troubleshooting, or general knowledge for non-insurance topics.`;
      }
    } else {
      contextDirective = retrievalResult.contextText;
    }

    const messages = PromptService.buildMessages({
      tenantConfig,
      retrievedContext: contextDirective,
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
