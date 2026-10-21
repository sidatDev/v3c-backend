import { TenantConfigCache } from '../cache/TenantConfigCache';
import { PromptService } from './PromptService';
import { RetrievalService } from './RetrievalService';
import { ConversationService } from './ConversationService';
import { SecurityShieldService } from '../security/SecurityShieldService';
import { OtpVerificationService } from '../security/OtpVerificationService';
import { AiGateway } from './AiGateway';
import prisma from '../../lib/prisma';
import { OrchestratorService } from '../orchestrator/OrchestratorService';
import { ScopeGuard } from '../orchestrator/ScopeGuard';

export interface ChatMessageParams {
  sessionId?: number;
  agentId?: string;
  publicKey?: string;
  slug?: string;
  message: string;
  language?: string;
  interestedClientId?: number;
}

export class ChatService {
  /**
   * Process an incoming visitor chat message with RAG context & safety checks
   */
  static async processMessage(params: ChatMessageParams): Promise<{
    reply: string;
    sources: any[];
    fallbackTriggered: boolean;
    topicLinks?: any[];
    humanTakeoverActive?: boolean;
  }> {
    const { sessionId, agentId, publicKey, slug, message, language = 'en' } = params;

    // 1. Resolve Tenant Configuration from Cache
    const tenantConfig = await TenantConfigCache.getTenantConfig(publicKey, agentId, slug);
    let { tenantId, agent } = tenantConfig;

    // If agentId is provided, fetch that specific Agent record from the database
    if (agentId) {
      const specificAgent = await prisma.agent.findUnique({
        where: { id: agentId },
        include: { RetrievalConfig: true }
      });
      if (specificAgent) {
        agent = specificAgent;
        tenantConfig.agent = specificAgent;
        if (!tenantId && specificAgent.tenantId) {
          tenantId = specificAgent.tenantId;
          tenantConfig.tenantId = specificAgent.tenantId;
        }
      }
    }

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
    let interestedClientId: number | null = params.interestedClientId || null;
    let recentMessages: any[] = [];
    let summary: string | undefined = undefined;

    if (sessionId) {
      const sessionCtx = await ConversationService.getSessionContext(sessionId, tenantId);
      dbSession = sessionCtx.dbSession;
      leadId = sessionCtx.leadId;
      if (!interestedClientId) {
        interestedClientId = sessionCtx.interestedClientId;
      }
      recentMessages = sessionCtx.recentMessages;
      summary = sessionCtx.summary;

      // Count visitor turns accurately for Turn Cap Check
      const visitorTurns = recentMessages.filter(m => m.sender === 'visitor' || m.sender === 'user').length + 1;
      const turnCapCheck = SecurityShieldService.checkSessionTurnCap(visitorTurns, 'chat');

      // Turn 25: Hard Cap Exceeded
      if (turnCapCheck.exceeded) {
        const isUrdu = language === 'ur' || /[\u0600-\u06FF]/.test(message);
        const capNotice = isUrdu
          ? 'آپ کی چیٹ سیشن کی 25 باریوں کی حد مکمل ہو چکی ہے۔ برائے مہربانی اپنا رابطہ نمبر چھوڑ دیں تاکہ ہماری ٹیم آپ سے رابطہ کر سکے۔ شکریہ!'
          : 'You have reached the chat session limit of 25 turns. Please leave your contact details so our support team can follow up with you. Thank you!';
        return {
          reply: capNotice,
          sources: [],
          fallbackTriggered: true
        };
      }

      // Save visitor message to DB
      if (dbSession) {
        await ConversationService.saveMessage({
          tenantId,
          agentId: agent.id,
          sessionId: dbSession.id,
          visitorId: dbSession.visitorId,
          leadId,
          interestedClientId,
          sender: 'visitor',
          message
        });

        // Silent-Listener Mode: When a human agent has taken over (status === 'HUMAN'),
        // record the visitor message & broadcast via RealtimeHub, but do NOT auto-reply as AI.
        if (dbSession.status === 'HUMAN') {
          console.log(`[ChatService] Session #${dbSession.id} is in HUMAN takeover mode (silent listener). Skipping auto AI reply.`);
          return {
            reply: '',
            sources: [],
            fallbackTriggered: false,
            topicLinks: [],
            humanTakeoverActive: true
          };
        }
      }
    }

    // 3.5 Orchestrator OTP Verification Gate (Blueprint Sec 4.2 & 4.6: Account Modification Restriction)
    const otpSubjectId = String(sessionId || params.interestedClientId || 'anon_session');
    const isDigitCode = /^\d{4,6}$/.test(message.trim());

    if (
      isDigitCode &&
      OtpVerificationService.hasPendingChallenge(
        tenantId,
        otpSubjectId,
        'conversation_account_action'
      )
    ) {
      const verifyRes = await OtpVerificationService.verifyOtp({
        tenantId,
        subjectId: otpSubjectId,
        purpose: 'conversation_account_action',
        code: message.trim(),
      });
      const isUrdu = language === 'ur' || /[\u0600-\u06FF]/.test(message);
      const otpReply = verifyRes.verified
        ? isUrdu
          ? 'آپ کا او ٹی پی (OTP) کامیابی سے تصدیق ہو گیا ہے۔ اب آپ اپنے اکاؤنٹ یا پالیسی میں تبدیلی کی تفصیلات بتا سکتے ہیں۔'
          : 'Your OTP has been verified successfully! You are now authorized to proceed with your account or policy modification request.'
        : verifyRes.reason;

      if (dbSession) {
        await ConversationService.saveMessage({
          tenantId,
          agentId: agent.id,
          sessionId: dbSession.id,
          visitorId: dbSession.visitorId,
          leadId,
          interestedClientId,
          sender: 'ai',
          message: otpReply,
        });
      }
      return {
        reply: otpReply,
        sources: [],
        fallbackTriggered: false,
      };
    }

    if (
      OtpVerificationService.detectSensitiveAccountAction(message) &&
      !OtpVerificationService.isVerified(tenantId, otpSubjectId, 'conversation_account_action')
    ) {
      const otpPolicy = await OtpVerificationService.getPolicy(tenantId);
      if (otpPolicy.enforceOnConversationAccountModify) {
        const challenge = await OtpVerificationService.issueOtp({
          tenantId,
          subjectId: otpSubjectId,
          purpose: 'conversation_account_action',
          targetContact: `Session-${otpSubjectId}`,
        });
        const isUrdu = language === 'ur' || /[\u0600-\u06FF]/.test(message);
        const challengeMsg = isUrdu
          ? `حفاظتی اصولوں کے تحت اکاؤنٹ یا پالیسی میں تبدیلی سے پہلے تصدیق ضروری ہے۔ ہم نے آپ کو ${challenge.otpLength} ہندسوں کا OTP بھیج دیا ہے (ٹیسٹ کوڈ: ${challenge.sandboxOtpPreview})۔ براہ کرم آگے بڑھنے کے لیے OTP درج کریں۔`
          : `For your security, sensitive account or policy modifications require OTP verification. We have sent a ${challenge.otpLength}-digit OTP to your registered contact (Sandbox Code: ${challenge.sandboxOtpPreview}). Please reply with the code to proceed.`;

        if (dbSession) {
          await ConversationService.saveMessage({
            tenantId,
            agentId: agent.id,
            sessionId: dbSession.id,
            visitorId: dbSession.visitorId,
            leadId,
            interestedClientId,
            sender: 'ai',
            message: challengeMsg,
          });
        }
        return {
          reply: challengeMsg,
          sources: [],
          fallbackTriggered: false,
        };
      }
    }

    // 4. Perform Retrieval-Augmented Generation (RAG)
    const threshold = agent.RetrievalConfig?.similarityThreshold ?? 0.3;
    const kbId = agentId ? (agent?.knowledgeBaseId || null) : null;
    const retrievalResult = await RetrievalService.search(tenantId, message, 5, threshold, 1000, kbId);

    // Post-Retrieval Confidence Gate: Validate top chunk directly answers the query
    if (retrievalResult.chunks && retrievalResult.chunks.length > 0 && !retrievalResult.fallbackTriggered) {
      const topChunkText = retrievalResult.chunks[0].content;
      const isConfident = await OrchestratorService.validateRagConfidence(message, topChunkText, tenantId, agent?.id || null);
      if (!isConfident) {
        console.log(`[ChatService] RAG confidence check rejected top chunk for query: "${message}"`);
        const isUrdu = language === 'ur' || /[\u0600-\u06FF]/.test(message);
        const refusal = isUrdu ? ScopeGuard.REFUSAL_TEXT : ScopeGuard.REFUSAL_TEXT_EN;

        if (dbSession) {
          await ConversationService.saveMessage({
            tenantId,
            agentId: agent.id,
            sessionId: dbSession.id,
            visitorId: dbSession.visitorId,
            leadId,
            interestedClientId,
            sender: 'ai',
            message: refusal
          });
        }

        return {
          reply: refusal,
          sources: [],
          fallbackTriggered: true,
          topicLinks: []
        };
      }
    }

    let reply = '';
    let topicLinks: { title: string; url: string }[] = [];

    // 5. Handle Fallback vs Normal Completion
    if (retrievalResult.fallbackTriggered) {
      const dbTopicLinks = await prisma.agentTopicLink.findMany({
        where: { tenantId, isActive: true },
        orderBy: { displayOrder: 'asc' },
        take: 5
      });

      if (dbTopicLinks.length > 0) {
        topicLinks = dbTopicLinks.map((t: any) => ({ title: t.title, url: t.url }));
      } else {
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

    const SERVICE_KEYWORDS = /\b(service|services|product|products|ai|solution|solutions|sprintly|talentra|humora|v3c|development|web|mobile|app|marketing|bpo|design|software|consulting|price|cost|about|contact|support|معلومات|خدمات|پروڈکٹ|حل|سافٹ ویئر|ایپ|ویب)\b/i;
    const hasServiceKeyword = SERVICE_KEYWORDS.test(message);

    const isFollowUp = recentMessages.length > 0 && (
      message.split(/\s+/).length < 7 || 
      /\b(it|other|others|this|that|also|more|cost|price|details|besides|difference|compare|dono|doosri|doosra|elawa|alawa|aur|batao|konsa|konsi|mazeed|pehla|dosra|teesra|farq|muqabla|دوسرا|دوسری|علاوہ|اور|بتاؤ|مزید|پہلا|تیسرا|فرق|مقابلہ|درمیان|ڈیفرنس)\b/i.test(message)
    );

    let contextDirective: string;
    if (retrievalResult.fallbackTriggered && !retrievalResult.contextText) {
      if (isFollowUp || hasServiceKeyword) {
        contextDirective = `[QUERY — GENERAL ASSISTANCE]: Answer the user's query naturally and accurately in ${language} regarding ${agent.name} products, services, and solutions.`;
      } else {
        contextDirective = `[STRICT OUT-OF-SCOPE DIRECTIVE]: The query is unrelated to ${agent.name}'s services. You MUST politely refuse in ${language}. State clearly that you are the AI assistant for ${agent.name} and can only assist with ${agent.name}'s services, products, and business solutions.`;
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
      language,
      voice: agent.voice
    });

    // Execute AI Completion via AiGateway
    const completion = await AiGateway.complete({
      messages,
      tenantId,
      agentId: agent?.id,
      sessionId,
      mode: 'chat'
    });

    const vSettings = (agent.voiceSettings as any) || {};
    const basePromptLower = (agent.systemPrompt || '').toLowerCase();
    let isFemale = false;
    if (vSettings.gender) {
      isFemale = vSettings.gender.toLowerCase() === 'female';
    } else if (basePromptLower.includes('female virtual assistant') || basePromptLower.includes('female assistant')) {
      isFemale = true;
    } else if (basePromptLower.includes('male virtual assistant') || basePromptLower.includes('male assistant')) {
      isFemale = false;
    } else {
      const femaleVoices = ['shimmer', 'coral', 'sage', 'verse', 'marin', 'nova'];
      const voiceClean = (agent.voice || 'cedar').split(' ')[0].toLowerCase().replace(/[^a-z]/g, '');
      isFemale = femaleVoices.includes(voiceClean);
    }

    reply = PromptService.sanitizeGenderVerbs(completion.reply, isFemale);

    // Check Turn 18 (70% Early Warning Notice for Chat)
    if (recentMessages.length > 0) {
      const visitorTurnCount = recentMessages.filter(m => m.sender === 'visitor' || m.sender === 'user').length + 1;
      const turnCheck = SecurityShieldService.checkSessionTurnCap(visitorTurnCount, 'chat');
      if (turnCheck.warning70Percent) {
        const isUrdu = language === 'ur' || /[\u0600-\u06FF]/.test(message);
        const warningBanner = isUrdu
          ? '\n\n⚠️ *اطلاع: آپ کی گفتگو کا 70 فیصد حصہ (18ویں باری) مکمل ہو چکا ہے۔ آپ جلد 25 باریوں کی حد تک پہنچنے والے ہیں۔*'
          : '\n\n⚠️ *Notice: You have reached 70% of your chat turn limit (Turn 18 of 25). Please leave your contact details if you need further assistance after this session.*';
        reply += warningBanner;
      }
    }

    // 6. Save AI Reply to DB
    if (dbSession) {
      await ConversationService.saveMessage({
        tenantId,
        agentId: agent.id,
        sessionId: dbSession.id,
        visitorId: dbSession.visitorId,
        leadId,
        interestedClientId,
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

  /**
   * Silent-Listener AI Suggestion:
   * Generates a RAG-assisted reply draft for a human operator without sending it to the visitor.
   */
  static async generateSilentSuggestion(
    sessionId: number,
    tenantId: string
  ): Promise<{ suggestion: string; sources: any[] }> {
    const sessionCtx = await ConversationService.getSessionContext(sessionId, tenantId);
    const { dbSession, recentMessages, summary } = sessionCtx;

    const lastVisitorMsg =
      [...recentMessages].reverse().find((m) => m.sender === 'visitor' || m.sender === 'user')?.message ||
      'Please provide a helpful follow-up response to the customer.';

    const tenantConfig = await TenantConfigCache.getTenantConfig(
      undefined,
      dbSession?.aiAgentId || undefined,
      undefined
    );
    const agent = tenantConfig.agent;
    const kbId = agent?.knowledgeBaseId || null;
    const threshold = agent?.RetrievalConfig?.similarityThreshold ?? 0.3;

    const retrievalResult = await RetrievalService.search(
      tenantId,
      lastVisitorMsg,
      4,
      threshold,
      1000,
      kbId
    );

    const messages = PromptService.buildMessages({
      tenantConfig,
      retrievedContext:
        retrievalResult.contextText ||
        `[SILENT LISTENER SUGGESTION]: Suggest a polite, concise, accurate reply for the human support agent to send to the customer regarding ${agent?.name || 'our services'}.`,
      summary,
      recentMessages,
      currentMessage: lastVisitorMsg,
      language: 'en',
      voice: agent?.voice || 'alloy',
    });

    const completion = await AiGateway.complete({
      messages,
      tenantId,
      agentId: agent?.id,
      sessionId,
      mode: 'chat',
    });

    return {
      suggestion: completion.reply,
      sources: retrievalResult.sources || [],
    };
  }
}
