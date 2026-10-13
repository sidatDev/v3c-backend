
import WebSocket from 'ws';
import prisma from '../../lib/prisma';
import { TenantConfigCache, TenantConfig } from '../cache/TenantConfigCache';
import { PromptService } from './PromptService';
import { RetrievalService } from './RetrievalService';
import { ConversationService } from './ConversationService';
import { SecurityShieldService } from '../security/SecurityShieldService';
import { StructuredLogger } from '../logger/StructuredLogger';
import { VoiceAuditLogger, VoiceAuditRecord } from '../logger/VoiceAuditLogger';
import { AiLogService } from '../logger/AiLogService';
import { LeadQualificationService } from './LeadQualificationService';
import {
  isNoisyTranscript,
  normalizeHindiToUrdu,
  detectDominantLanguage,
  computeThinkingDelay,
  isConversationalGreeting,
  isConversationalAffirmation,
  contextualizeQuery,
  detectCompetitor,
  evaluateScopeAndRefusal,
  isFemaleVoice,
  buildConciseSessionInstructions,
  isGenericMarketingTitle,
  ts,
  resolveSelectedVoice,
  TOP_PRIORITY_SCOPE_RULE,
  DEFAULT_LANGUAGE_RULES
} from './VoicePipelineUtils';

export interface VoiceSessionParams {
  socket: WebSocket;
  sessionId?: string;
  agentId?: string;
  publicKey?: string;
  slug?: string;
  language?: string;
  clientIp?: string;
  voice?: string;
  interestedClientId?: string;
}

export class RealtimeSessionManager {
  private socket: WebSocket;
  private openAiWs: WebSocket | null = null;
  private tenantConfig: TenantConfig | null = null;
  private language: string;
  private sessionIdNum: number | null = null;
  private dbSession: any = null;
  private leadId: number | null = null;
  private interestedClientId: number | null = null;
  private clientIp: string = '127.0.0.1';
  private sessionPreferredLanguage: 'English' | 'Urdu' | 'RomanUrdu' | null = 'Urdu';
  private languageConfidenceStreak: number = 0;
  private lastUserTurn: string = '';
  private turnCount: number = 0;
  private aiTranscriptBuffer: string = '';
  private pendingTurnAudit: VoiceAuditRecord | null = null;
  private turnStartTime: number = 0;
  private selectedVoice: string = 'shimmer';
  private greetingSent: boolean = false;
  private sessionReadySent: boolean = false;
  private isResponseInProgress: boolean = false;
  private isClosingGracefully: boolean = false;
  private isTurnCapReached: boolean = false;
  private lastTurnTimestamp: number = 0;
  private recentUserTurns: string[] = [];
  private lastTurnWasRefused: boolean = false;
  private lastTurnWasNoisy: boolean = false;
  private maxDurationTimer: NodeJS.Timeout | null = null;
  private silenceTimeoutTimer: NodeJS.Timeout | null = null;
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private agentId?: string;
  private publicKey?: string;
  private slug?: string;
  private requestedVoice?: string;

  constructor(params: VoiceSessionParams) {
    this.socket = params.socket;
    this.sessionIdNum = params.sessionId ? parseInt(params.sessionId, 10) : null;
    this.agentId = params.agentId;
    this.publicKey = params.publicKey;
    this.slug = params.slug;
    this.language = params.language === 'en' ? 'English' : 'Urdu';
    this.clientIp = params.clientIp || '127.0.0.1';
    this.requestedVoice = params.voice;
    this.interestedClientId = params.interestedClientId ? parseInt(params.interestedClientId, 10) : null;
  }

  private sendResponseCreate(payload: any) {
    if (!this.openAiWs || this.openAiWs.readyState !== WebSocket.OPEN) return;
    if (this.isResponseInProgress) {
      console.log(`[PIPELINE ${ts()}] ⚠️ Active response in progress — cancelling before new response`);
      try {
        this.openAiWs.send(JSON.stringify({ type: 'response.cancel' }));
      } catch (_) {}
      this.isResponseInProgress = false;
    }
    if (payload?.response) {
      payload.response.tool_choice = payload.response.tool_choice || 'none';
    }
    if (payload?.response?.instructions) {
      console.log('\n📚 [RAG CONTEXT SENT]:', payload.response.instructions);
    }
    this.openAiWs.send(JSON.stringify(payload));
  }

  private sendRefusalResponse(salesRefusal: string) {
    if (!this.openAiWs || this.openAiWs.readyState !== WebSocket.OPEN) return;
    console.log(`[RealtimeSessionManager] Refusal sent via conversation.item.create: "${salesRefusal}"`);
    this.openAiWs.send(JSON.stringify({
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'user',
        content: [{
          type: 'input_text',
          text: `OUTPUT ONLY THIS TEXT AND NOTHING ELSE. DO NOT ADD, MODIFY, EXPLAIN, OR TRANSLATE:\n"${salesRefusal}"`,
        }],
      },
    }));
    this.sendResponseCreate({
      type: 'response.create',
      response: {
        tool_choice: 'none',
      },
    });
  }

  private resetSilenceTimeout() {
    if (this.silenceTimeoutTimer) clearTimeout(this.silenceTimeoutTimer);
    // 90-Second VAD Silence Auto-Disconnect Guard
    this.silenceTimeoutTimer = setTimeout(() => {
      console.log(`[SESSION LIFECYCLE ${ts()}] ⏱ SILENCE TIMEOUT (90s no speech) — triggering graceful disconnect`);
      this.gracefulClose('Session closed due to 90 seconds of inactivity.');
    }, 90 * 1000);
  }

  private startHeartbeat() {
    if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
    // 30-Second Ping/Pong Heartbeat to prevent zombie WebSocket connections
    this.heartbeatInterval = setInterval(() => {
      if (this.socket && this.socket.readyState === WebSocket.OPEN) {
        this.socket.ping();
      }
    }, 30 * 1000);
  }

  private isCleanedUp: boolean = false;

  private cleanupTimers() {
    if (this.isCleanedUp) return;
    this.isCleanedUp = true;

    if (this.maxDurationTimer) { clearTimeout(this.maxDurationTimer); this.maxDurationTimer = null; }
    if (this.silenceTimeoutTimer) { clearTimeout(this.silenceTimeoutTimer); this.silenceTimeoutTimer = null; }
    if (this.heartbeatInterval) { clearInterval(this.heartbeatInterval); this.heartbeatInterval = null; }
    SecurityShieldService.unregisterVoiceCallSession(this.clientIp, this);

    if (this.sessionIdNum) {
      console.log(`[RealtimeSessionManager] Socket/Session terminating — evaluating session #${this.sessionIdNum} (tenantId: ${this.tenantConfig?.tenantId || 'auto'}, interestedClientId: ${this.interestedClientId || 'none'})`);
      LeadQualificationService.evaluateSession(
        this.sessionIdNum,
        this.tenantConfig?.tenantId,
        this.interestedClientId || undefined
      ).catch(err => {
        console.error('[RealtimeSessionManager] Lead qualification evaluation error:', err);
      });
    }
  }

  private gracefulClose(reasonMessage: string) {
    if (this.isClosingGracefully) return;
    this.isClosingGracefully = true;

    console.log(`[SESSION LIFECYCLE ${ts()}] 🛑 GRACEFUL CLOSE INITIATED: "${reasonMessage}"`);

    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      try {
        this.socket.send(JSON.stringify({ type: 'error', message: reasonMessage }));
      } catch (_) {}
    }

    // Brief delay to allow browser to flush final audio output before socket teardown
    setTimeout(() => {
      if (this.openAiWs && this.openAiWs.readyState === WebSocket.OPEN) {
        this.openAiWs.close();
      }
      if (this.socket && this.socket.readyState === WebSocket.OPEN) {
        this.socket.close();
      }
      this.cleanupTimers();
    }, 1500);
  }

  async start(): Promise<void> {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      this.socket.send(JSON.stringify({ type: 'error', message: 'OpenAI API Key not configured' }));
      this.socket.close();
      return;
    }

    // ── 0. Safeguard: IP Concurrent Call Cap Check (Max 3/IP) ────────────────
    const ipCheck = SecurityShieldService.checkIpConcurrentCallCap(this.clientIp, 3);
    if (!ipCheck.allowed) {
      console.log(`[SESSION LIFECYCLE ${ts()}] 🚫 IP CONCURRENT CALL CAP BLOCKED for IP: ${this.clientIp}`);
      this.socket.send(JSON.stringify({ type: 'error', message: ipCheck.reason }));
      this.socket.close();
      return;
    }
    SecurityShieldService.registerVoiceCallSession(this.clientIp, this);

    // ── 1. Resolve Tenant Configuration ──────────────────────────────────────
    try {
      this.tenantConfig = await TenantConfigCache.getTenantConfig(this.publicKey, this.agentId, this.slug);
    } catch (err: any) {
      StructuredLogger.error('[SESSION] Failed to resolve tenant config', { error: err?.message });
      this.socket.send(JSON.stringify({ type: 'error', message: 'Tenant configuration failure' }));
      this.cleanupTimers();
      this.socket.close();
      return;
    }

    const { tenantId, agent } = this.tenantConfig;

    // ── Pre-flight Tenant Quota Check ───────────────────────────────────────
    if (this.sessionIdNum) {
      const sessionCtx = await ConversationService.getSessionContext(this.sessionIdNum, tenantId);
      this.dbSession = sessionCtx.dbSession;
      this.leadId = sessionCtx.leadId;
      if (!this.interestedClientId && sessionCtx.interestedClientId) {
        this.interestedClientId = sessionCtx.interestedClientId;
      }

      // Resume turn count for Session Re-hydration (prevents turn cap refresh bypass)
      if (sessionCtx.recentMessages && sessionCtx.recentMessages.length > 0) {
        const visitorMsgCount = sessionCtx.recentMessages.filter(m => m.sender === 'visitor' || m.sender === 'user').length;
        this.turnCount = visitorMsgCount;
        console.log(`[SESSION RE-HYDRATION ${ts()}] Resumed existing session #${this.sessionIdNum} with ${this.turnCount} turn(s)`);
      }

      try {
        await prisma.visitorSession.update({
          where: { id: this.sessionIdNum },
          data: { channel: 'voice' }
        });
      } catch (err: any) {
        StructuredLogger.warn('[RealtimeSessionManager] Failed to update session channel to voice', { error: err?.message });
      }
    }

    // Start Safeguard Timers
    this.startHeartbeat();
    this.resetSilenceTimeout();

    // 15-Minute Max Call Duration Hard Cap Guard
    this.maxDurationTimer = setTimeout(() => {
      console.log(`[SESSION LIFECYCLE ${ts()}] ⏱ MAX SESSION DURATION (15 minutes) REACHED — closing session`);
      this.gracefulClose('Max session call duration of 15 minutes reached.');
    }, 15 * 60 * 1000);

    // Configurable voice parameters with fallback to enterprise production defaults
    const vSettings = (agent.voiceSettings as any) || {};
    const voiceResponseDelayMs = typeof vSettings.voiceResponseDelayMs === 'number' ? vSettings.voiceResponseDelayMs : 600;
    const minTranscriptLength = typeof vSettings.minTranscriptLength === 'number' ? vSettings.minTranscriptLength : 3;
    const minWordCount = typeof vSettings.minWordCount === 'number' ? vSettings.minWordCount : 2;

    this.selectedVoice = resolveSelectedVoice(this.requestedVoice, agent.voice);

    console.log(`\n[SESSION LIFECYCLE ${ts()}] ▶ Session START`);
    console.log(`  Tenant     : ${agent.name} (${tenantId})`);
    console.log(`  Voice      : ${this.selectedVoice} | IP: ${this.clientIp}`);
    console.log(`  Turn Count : ${this.turnCount}/20 (Voice Cap)`);

    // ── Build base system prompt ─────────────────────────────────────────────
    const baseInstructions = PromptService.buildSystemPrompt({
      tenantConfig: this.tenantConfig,
      language: this.language,
      isVoice: true,
      voice: this.selectedVoice,
    });

    // ── Open OpenAI Realtime WebSocket ───────────────────────────────────────
    const openAiUrl = 'wss://api.openai.com/v1/realtime?model=gpt-realtime-mini';
    this.openAiWs = new WebSocket(openAiUrl, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });

    this.openAiWs.on('open', () => {
      console.log(`[SESSION LIFECYCLE ${ts()}] WebSocket CONNECTED to OpenAI`);
      StructuredLogger.info('[SESSION] Connected to OpenAI Realtime', {
        tenantId, voice: this.selectedVoice, agentName: agent.name,
      });

      const isFemaleAgent = isFemaleVoice(this.tenantConfig?.agent?.voiceSettings, this.selectedVoice);
      const sessionInstructions = buildConciseSessionInstructions(isFemaleAgent);

      const sessionConfig = {
        type: 'session.update',
        session: {
          type: 'realtime',
          instructions: sessionInstructions,
          audio: {
            input: {
              transcription: {
                model: 'whisper-1',
                language: 'ur',
              },
              turn_detection: {
                type: 'server_vad',
                create_response: false,
              },
            },
            output: {
              voice: this.selectedVoice,
            },
          },
        },
      };

      console.log('[SESSION CONFIG GA PAYLOAD]:', JSON.stringify(sessionConfig, null, 2));
      this.openAiWs?.send(JSON.stringify(sessionConfig));
    });

    // ── Proxy audio from browser → OpenAI ────────────────────────────────────
    this.socket.on('message', (message: WebSocket.RawData) => {
      const textMessage = typeof message === 'string' ? message : message.toString('utf-8');
      try {
        const msg = JSON.parse(textMessage);
        if (msg.type === 'ping') {
          this.socket.send(JSON.stringify({ type: 'pong' }));
          return;
        }
      } catch (_) {}

      if (this.openAiWs && this.openAiWs.readyState === WebSocket.OPEN) {
        this.openAiWs.send(textMessage);
      }
    });

    // ── Handle events from OpenAI → browser ──────────────────────────────────
    this.openAiWs.on('message', async (data: WebSocket.RawData) => {
      let event: any;
      try {
        event = JSON.parse(data.toString());
      } catch (_) {
        return;
      }

      if (event.type === 'error' && event.error?.code === 'response_cancel_not_active') {
        console.log(`[PIPELINE ${ts()}] Debug: ignored response_cancel_not_active error:`, event.error?.message);
        return;
      }

      // Relay event to browser client
      if (this.socket.readyState === WebSocket.OPEN) {
        this.socket.send(JSON.stringify(event));
      }

      if (event.type === 'session.updated' && !this.sessionReadySent) {
        this.sessionReadySent = true;
        console.log(`[SESSION LIFECYCLE ${ts()}] session.updated confirmed`);
        if (this.socket.readyState === WebSocket.OPEN) {
          this.socket.send(JSON.stringify({ type: 'session.ready' }));
        }

        // Send initial greeting on connection
        if (!this.greetingSent) {
          this.greetingSent = true;
          const isFemale = isFemaleVoice(this.tenantConfig?.agent?.voiceSettings, this.selectedVoice);
          const greetingText = isFemale
            ? 'As Salam o Alaikum! Main apki kiya madad kar sakti hon?'
            : 'As Salam o Alaikum! Main apki kiya madad kar sakta hon?';

          const langDirective = isFemale
            ? '[RESPOND 100% IN URDU — FEMALE VERBS ONLY]'
            : '[RESPOND 100% IN URDU — MALE VERBS ONLY]';

          console.log(`[PIPELINE ${ts()}] → SENDING response.create() [INITIAL GREETING]`);
          this.sendResponseCreate({
            type: 'response.create',
            response: {
              instructions: `${langDirective}\n[GREETING DIRECTIVE]: Speak EXACTLY this greeting text in clear Urdu: "${greetingText}"`,
            },
          });
        }
      }

      if (event.type === 'response.created') {
        this.isResponseInProgress = true;
      }

      if (event.type === 'response.done' || event.type === 'response.cancelled') {
        this.isResponseInProgress = false;
        console.log(`[PIPELINE ${ts()}] ↓ response.done`);

        if (this.isClosingGracefully) {
          console.log(`[SESSION LIFECYCLE ${ts()}] Final response.done received during graceful close — tearing down socket`);
          setTimeout(() => {
            if (this.socket && this.socket.readyState === WebSocket.OPEN) this.socket.close();
            if (this.openAiWs && this.openAiWs.readyState === WebSocket.OPEN) this.openAiWs.close();
            this.cleanupTimers();
          }, 800);
        }
      }

      if (event.type === 'response.output_audio_transcript.delta' && event.delta) {
        process.stdout.write(event.delta);
        this.aiTranscriptBuffer += event.delta;
      }

      if (event.type === 'response.done') {
        console.log('\n✅ [AI RESPONSE DONE] Usage:', event.response?.usage);
        if (this.tenantConfig && this.sessionIdNum && this.aiTranscriptBuffer.trim()) {
          await ConversationService.saveMessage({
            tenantId: this.tenantConfig.tenantId,
            agentId: this.tenantConfig.agent.id,
            sessionId: this.sessionIdNum,
            visitorId: this.dbSession?.visitorId,
            leadId: this.leadId,
            interestedClientId: this.interestedClientId,
            sender: 'ai',
            message: this.aiTranscriptBuffer.trim(),
          });
        }
        this.aiTranscriptBuffer = '';

        if (this.pendingTurnAudit) {
          this.pendingTurnAudit.latencyMs = Date.now() - this.turnStartTime;
          const usage = event.response?.usage;
          const promptTokens = usage?.input_tokens ?? usage?.prompt_tokens ?? 0;
          const completionTokens = usage?.output_tokens ?? usage?.completion_tokens ?? 0;
          if (usage) {
            this.pendingTurnAudit.totalTokens = usage.total_tokens ?? (promptTokens + completionTokens);
          }
          VoiceAuditLogger.printFinal(this.pendingTurnAudit);

          if (this.tenantConfig) {
            AiLogService.logRequest({
              tenantId: this.tenantConfig.tenantId,
              agentId: this.tenantConfig.agent.id,
              visitorSessionId: this.sessionIdNum || undefined,
              mode: 'voice',
              userQuery: this.lastUserTurn || 'Realtime Voice Turn',
              modelUsed: 'gpt-realtime-mini',
              voiceUsed: this.selectedVoice,
              promptTokens,
              completionTokens,
              latencyMs: this.pendingTurnAudit.latencyMs
            });
          }

          if (this.sessionIdNum) {
            const voiceCost = (promptTokens * 0.01 + completionTokens * 0.02) / 1000;
            prisma.visitorSession.update({
              where: { id: this.sessionIdNum },
              data: {
                totalInputTokens: { increment: promptTokens },
                totalOutputTokens: { increment: completionTokens },
                estimatedCost: { increment: voiceCost }
              }
            }).catch(err => console.error('[RealtimeSessionManager] Failed to update VisitorSession token counts:', err));
          }

          this.pendingTurnAudit = null;
        }

        // Auto-terminate and emit session.limit_reached to client after limit notice audio completes
        if (this.isTurnCapReached) {
          console.log(`[SESSION LIFECYCLE] Limit audio notice finished — sending session.limit_reached & closing socket`);
          if (this.socket.readyState === WebSocket.OPEN) {
            this.socket.send(JSON.stringify({ type: 'session.limit_reached', reason: 'turn_cap_exceeded' }));
            setTimeout(() => {
              try { this.socket.close(); } catch (_) {}
            }, 1000);
          }
        }
      }

      // ── Core Audio Transcription Turn Handling ─────────────────────────────
      if (
        event.type === 'conversation.item.input_audio_transcription.completed' &&
        event.transcript
      ) {
        // Cancel any autonomous in-flight response only if one is active
        if (this.isResponseInProgress && this.openAiWs && this.openAiWs.readyState === WebSocket.OPEN) {
          try {
            this.openAiWs.send(JSON.stringify({ type: 'response.cancel' }));
          } catch (_) {}
          this.isResponseInProgress = false;
        }
        this.aiTranscriptBuffer = '';

        console.log('\n🗣️ [USER SAID]:', event.transcript);
        const rawSpeech = event.transcript.trim();
        if (!rawSpeech || !this.tenantConfig) return;

        // Reset silence timeout on user activity
        this.resetSilenceTimeout();

        const userSpeech = normalizeHindiToUrdu(rawSpeech);

        if (isNoisyTranscript(userSpeech, minTranscriptLength, minWordCount)) {
          console.log(`[PIPELINE ${ts()}] ⏭ IGNORED noisy transcript: "${userSpeech}"`);
          this.lastTurnWasNoisy = true;
          return;
        }

        this.recentUserTurns.push(userSpeech);
        if (this.recentUserTurns.length > 3) this.recentUserTurns.shift();

        this.turnStartTime = Date.now();
        const tTranscriptDone = Date.now();
        this.turnCount++;

        console.log(`[PIPELINE ${ts()}] ↓ transcription.completed (Turn #${this.turnCount}) — "${userSpeech.substring(0, 80)}"`);

        const prevLang = this.sessionPreferredLanguage;
        const dominantLang = detectDominantLanguage(userSpeech);

        if (this.sessionPreferredLanguage === dominantLang) {
          this.languageConfidenceStreak++;
        } else if (!this.sessionPreferredLanguage) {
          this.sessionPreferredLanguage = dominantLang;
          this.languageConfidenceStreak = 1;
        } else {
          if (this.languageConfidenceStreak >= 2 || userSpeech.split(/\s+/).length >= 4) {
            console.log(`[PIPELINE ${ts()}] 🌐 Session language switched: ${this.sessionPreferredLanguage} ➔ ${dominantLang}`);
            this.sessionPreferredLanguage = dominantLang;
            this.languageConfidenceStreak = 1;
          }
        }

        const detectedLanguage: 'English' | 'Urdu' | 'RomanUrdu' = dominantLang;
        const isUrdu = detectedLanguage === 'Urdu' || detectedLanguage === 'RomanUrdu';

        // ── Security Layer 1: Anti-Bot Turn Cooldown Throttling ──────────────
        const nowMs = Date.now();
        const wordCount = userSpeech.trim().split(/\s+/).filter(Boolean).length;
        const timeSinceLastTurn = this.lastTurnTimestamp > 0 ? (nowMs - this.lastTurnTimestamp) : 999999;
        const shouldThrottle = (this.lastTurnWasNoisy && timeSinceLastTurn < 2500) ||
                               (wordCount < 3 && timeSinceLastTurn < 1500);

        if (shouldThrottle) {
          console.log(`[PIPELINE ${ts()}] ⏱ ANTI-BOT THROTTLE — ignored rapid turn (${timeSinceLastTurn}ms gap, words=${wordCount})`);
          this.lastTurnWasNoisy = true;
          return;
        }
        this.lastTurnTimestamp = nowMs;
        this.lastTurnWasNoisy = false;

        // ── Security Layer 2: Voice Session Turn Cap & Warning Check ────────
        const turnCapCheck = SecurityShieldService.checkSessionTurnCap(this.turnCount, 'voice');

        // Turn 20: Hard Cap Reached
        if (turnCapCheck.exceeded) {
          console.log(`[PIPELINE ${ts()}] 🛑 VOICE SESSION TURN CAP REACHED (Turn #${this.turnCount}/20) — initiating graceful goodbye`);
          this.isClosingGracefully = true;
          this.isTurnCapReached = true;
          const capNotice = isUrdu
            ? 'آپ کی گفتگو کی 20 باریوں کی حد مکمل ہو چکی ہے۔ برائے مہربانی اپنا رابطہ نمبر چھوڑ دیں تاکہ ہماری ٹیم آپ سے رابطہ کر سکے۔ شکریہ!'
            : 'You have reached the voice session limit of 20 turns. Please leave your contact details so our support team can follow up with you. Thank you!';

          this.sendResponseCreate({
            type: 'response.create',
            response: {
              instructions: `You MUST respond with EXACTLY this text and nothing else, in ${detectedLanguage}: "${capNotice}"`,
            },
          });
          return;
        }

        // Turn 14: 70% Early Warning Directive
        let warning70Directive = '';
        if (turnCapCheck.warning70Percent) {
          console.log(`[PIPELINE ${ts()}] ⚠️ 70% TURN WARNING TRIGGERED (Turn #14 of 20)`);
          warning70Directive = isUrdu
            ? `\n[70% TURN LIMIT NOTICE]: Mention warmly to the user that they have reached 70% of their conversation turn limit (Turn 14 of 20) and are approaching their session cap.`
            : `\n[70% TURN LIMIT NOTICE]: Inform the user politely that they have reached 70% of their session turn limit (Turn 14 of 20) and are approaching their cap.`;
        }

        // ── Security Layer 3: Prompt Injection Shield ───────────────────────
        const injectionMatch = SecurityShieldService.detectPromptInjection(userSpeech);
        if (injectionMatch) {
          console.log(`[PIPELINE ${ts()}] 🛡 PROMPT INJECTION SHIELD TRIGGERED — refusing payload`);
          const refusalMsg = isUrdu
            ? 'معذرت، میں آپ کی اس درخواست کا جواب نہیں دے سکتا۔ میں صرف ہماری کمپنی کی سروسز میں مدد کر سکتا ہوں۔'
            : 'I cannot fulfill requests attempting to alter system instructions. How can I assist you with our services today?';

          this.sendResponseCreate({
            type: 'response.create',
            response: {
              instructions: `You MUST respond with EXACTLY this text and nothing else, in ${detectedLanguage}: "${refusalMsg}"`,
            },
          });
          return;
        }

        // Save visitor turn to DB
        if (this.sessionIdNum) {
          await ConversationService.saveMessage({
            tenantId: this.tenantConfig.tenantId,
            agentId: this.tenantConfig.agent.id,
            sessionId: this.sessionIdNum,
            visitorId: this.dbSession?.visitorId,
            leadId: this.leadId,
            interestedClientId: this.interestedClientId,
            sender: 'visitor',
            message: userSpeech,
          });
        }

        const isFemaleVoiceTurn = isFemaleVoice(this.tenantConfig?.agent?.voiceSettings, this.selectedVoice);

        const salesRefusal = isUrdu
          ? 'معذرت، میں اس سوال کا جواب نہیں دے سکتا۔ براہ کرم ہماری سیلز ٹیم سے رابطہ کریں تاکہ وہ آپ کی بہتر مدد کر سکیں۔'
          : 'I am unable to help with this query. Please contact our sales team for further assistance.';

        // ── Security Layer 4: Out-of-Scope Keyword & Follow-up Refusal Guard ─
        const scopeCheck = evaluateScopeAndRefusal(userSpeech, this.lastTurnWasRefused);
        this.lastTurnWasRefused = scopeCheck.updatedRefusedState;
        if (scopeCheck.shouldRefuse) {
          console.log(`[PIPELINE ${ts()}] 🚫 OUT-OF-SCOPE ${scopeCheck.reason} — triggering immediate hard refusal`);
          this.lastUserTurn = userSpeech;
          this.sendRefusalResponse(salesRefusal);
          return;
        }

        // ── Intent Path A: Conversational Greetings & Affirmations ──────────
        const isGreeting = isConversationalGreeting(userSpeech);
        const isAffirmation = isConversationalAffirmation(userSpeech);

        if (isGreeting || isAffirmation) {
          const intentDecision = isGreeting ? 'CONVERSATIONAL_GREETING' : 'CONVERSATIONAL_AFFIRMATION';
          const greetingLangMandate = isUrdu
            ? (isFemaleVoiceTurn ? `[RESPOND 100% IN URDU — FEMALE VERBS ONLY]` : `[RESPOND 100% IN URDU — MALE VERBS ONLY]`)
            : `[RESPOND 100% IN ENGLISH]`;

          this.lastUserTurn = userSpeech;
          this.sendResponseCreate({
            type: 'response.create',
            response: {
              instructions: `${greetingLangMandate}${warning70Directive}\n[USER TURN]: "${userSpeech}"\nRespond warmly and clearly in ${detectedLanguage} as a professional support agent.`,
            },
          });
          return;
        }

        // ── Competitor Shield Guard ──────────────────────────────────────────
        const competitorMatch = detectCompetitor(userSpeech, this.tenantConfig.agent.name);
        if (competitorMatch) {
          const fallbackText = isUrdu
            ? this.tenantConfig.agent.RetrievalConfig?.fallbackMessageUrdu || 'معذرت، میں صرف ہماری کمپنی کی خدمات کی معلومات کا جواب دے سکتا ہوں۔'
            : this.tenantConfig.agent.RetrievalConfig?.fallbackMessage || 'I can only answer questions related to our services and official knowledge base.';

          this.lastUserTurn = userSpeech;
          this.sendResponseCreate({
            type: 'response.create',
            response: {
              instructions: `You MUST respond with EXACTLY this text and nothing else, in ${detectedLanguage}: "${fallbackText}"`,
            },
          });
          return;
        }

        // ── Intent Path B: Grounded Vector Search (RAG, topK = 4) ──────────
        const rawThreshold = this.tenantConfig.agent.RetrievalConfig?.similarityThreshold ?? 0.35;
        const threshold = Math.max(rawThreshold, 0.35);
        const searchQuery = contextualizeQuery(userSpeech, this.lastUserTurn);

        let retrieval: any;
        try {
          retrieval = await RetrievalService.search(
            this.tenantConfig.tenantId,
            searchQuery,
            4,
            threshold,
          );
        } catch (searchErr) {
          console.error('[RealtimeSessionManager] RetrievalService.search threw error:', searchErr);
          retrieval = {
            chunks: [],
            contextText: '',
            sources: [],
            avgSimilarity: 0,
            topSimilarity: 0,
            fallbackTriggered: true,
            timings: { embeddingMs: 0, vectorSearchMs: 0, totalMs: 0 },
          };
        }

        if (
          !retrieval ||
          !retrieval.chunks ||
          retrieval.chunks.length === 0 ||
          (retrieval.topSimilarity ?? 0) < threshold
        ) {
          if (retrieval) {
            retrieval.fallbackTriggered = true;
          }
        }

        // Title-similarity check: if top chunk's title is < 20 chars or contains generic marketing terms, treat as fallback
        if (retrieval.chunks && retrieval.chunks.length > 0) {
          const topTitle = (retrieval.chunks[0].sourceTitle || '').trim();
          if (isGenericMarketingTitle(topTitle)) {
            console.log(`[RealtimeSessionManager] Top chunk title is generic/short ("${topTitle}") — treating as fallback`);
            retrieval.fallbackTriggered = true;
          }
        }

        this.lastUserTurn = userSpeech;
        const retrievalMs = retrieval?.timings?.totalMs ?? 0;
        const thinkingDelayMs = computeThinkingDelay(retrievalMs, voiceResponseDelayMs);

        if (!this.openAiWs || this.openAiWs.readyState !== WebSocket.OPEN) return;

        if (thinkingDelayMs > 0) {
          await new Promise((r) => setTimeout(r, thinkingDelayMs));
        }

        const agentName = this.tenantConfig.agent.name?.trim() || 'Sidat Technologies & Digital';
        const langGenderMandate = isUrdu
          ? (isFemaleVoiceTurn ? `[RESPOND 100% IN URDU — FEMALE VERBS ONLY]` : `[RESPOND 100% IN URDU — MALE VERBS ONLY]`)
          : `[RESPOND 100% IN ENGLISH]`;

        if (retrieval.fallbackTriggered) {
          this.lastTurnWasRefused = true;
          this.sendRefusalResponse(salesRefusal);
          return;
        } else {
          this.lastTurnWasRefused = false;
          const contextOnly = retrieval.contextText;
          this.sendResponseCreate({
            type: 'response.create',
            response: {
              tool_choice: 'none',
              instructions: `${langGenderMandate}${warning70Directive}\n${baseInstructions}\n\n[KNOWLEDGE CONTEXT FOR THIS TURN ONLY — Answer clearly and concisely in ${detectedLanguage} using this official ${agentName} knowledge base context]:\n${contextOnly}\n\n[CRITICAL CONTEXT DISCIPLINE]: Answer ONLY what the user explicitly asked. Be concise. If this context contains details or products (e.g. 'Sprintly') that the user did NOT specifically ask about, DO NOT mention them. Do NOT force unrequested products or irrelevant details into your answer.\n\nCRITICAL — IF THE ABOVE CONTEXT DOES NOT CONTAIN THE DIRECT ANSWER TO THE USER'S QUESTION, OUTPUT ONLY THIS TEXT AND NOTHING ELSE. DO NOT ADD, MODIFY, EXPLAIN, OR TRANSLATE:\n"${salesRefusal}"`,
            },
          });
        }
      }
    });

    // ── Cleanup & Closure Event Listeners ────────────────────────────────────
    this.socket.on('close', async () => {
      console.log(`[SESSION LIFECYCLE ${ts()}] Browser client DISCONNECTED`);
      // Flush any pending AI transcript buffer before concluding session
      if (this.tenantConfig && this.sessionIdNum && this.aiTranscriptBuffer.trim()) {
        try {
          await ConversationService.saveMessage({
            tenantId: this.tenantConfig.tenantId,
            agentId: this.tenantConfig.agent.id,
            sessionId: this.sessionIdNum,
            visitorId: this.dbSession?.visitorId,
            leadId: this.leadId,
            interestedClientId: this.interestedClientId,
            sender: 'ai',
            message: this.aiTranscriptBuffer.trim(),
          });
          console.log(`[RealtimeSessionManager] Flushed remaining AI transcript buffer (${this.aiTranscriptBuffer.length} chars) to Conversation`);
          this.aiTranscriptBuffer = '';
        } catch (saveErr) {
          console.error('[RealtimeSessionManager] Failed to flush final aiTranscriptBuffer on close:', saveErr);
        }
      }
      this.cleanupTimers();
      if (this.openAiWs && this.openAiWs.readyState === WebSocket.OPEN) {
        this.openAiWs.close();
      }
    });

    this.openAiWs.on('close', () => {
      console.log(`[SESSION LIFECYCLE ${ts()}] OpenAI WS CLOSED`);
      this.cleanupTimers();
      if (this.socket.readyState === WebSocket.OPEN) {
        this.socket.close();
      }
    });

    this.openAiWs.on('error', (err: any) => {
      StructuredLogger.error('[SESSION] OpenAI WS Error', { error: err?.message || err });
      this.cleanupTimers();
      if (this.socket.readyState === WebSocket.OPEN) {
        this.socket.send(JSON.stringify({ type: 'error', message: 'Voice session error' }));
      }
    });

    this.socket.on('error', (err: any) => {
      StructuredLogger.error('[SESSION] Client WS Error', { error: err?.message || err });
      this.cleanupTimers();
    });
  }
}
