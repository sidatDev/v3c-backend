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
import {
  isNoisyTranscript,
  normalizeHindiToUrdu,
  detectDominantLanguage,
  computeThinkingDelay,
  isConversationalGreeting,
  isConversationalAffirmation,
  contextualizeQuery
} from './VoicePipelineUtils';

// ── Competitor / out-of-tenant entity guard ──────────────────────────────────
const COMPETITOR_PATTERNS: RegExp[] = [
  /\befu\b/i,
  /\bigi\b/i,
  /\bjubilee\b/i,
  /\badamjee\b/i,
  /\btpl\b/i,
  /\bstate\s*life\b/i,
  /\bnational\s*life\b/i,
  /\bpakistan\s*life\b/i,
  /\bsalamtakaful\b/i,
  /\bpak\s*qatar\b/i,
  /\bwarid\b/i,
  /\bhabib\s*metro\b/i,
  /\balianz\b/i,
  /\bchubb\b/i,
  /\bpru\s*bsn\b/i,
];

function detectCompetitor(query: string, currentTenantName?: string): string | null {
  const tenantLower = (currentTenantName || '').toLowerCase();
  for (const pattern of COMPETITOR_PATTERNS) {
    const match = query.match(pattern);
    if (match) {
      const matchLower = match[0].toLowerCase();
      if (tenantLower && (tenantLower.includes(matchLower) || (matchLower === 'efu' && tenantLower.includes('efu')))) {
        continue;
      }
      return match[0];
    }
  }
  return null;
}

function ts(): string {
  return new Date().toISOString().substring(11, 23);
}

export interface VoiceSessionParams {
  socket: WebSocket;
  sessionId?: string;
  agentId?: string;
  publicKey?: string;
  slug?: string;
  language?: string;
  clientIp?: string;
}

export class RealtimeSessionManager {
  private socket: WebSocket;
  private openAiWs: WebSocket | null = null;
  private tenantConfig: TenantConfig | null = null;
  private language: string;
  private sessionIdNum: number | null = null;
  private dbSession: any = null;
  private leadId: number | null = null;

  // Client IP for concurrent session throttling
  private clientIp: string = '127.0.0.1';

  // Session-level language memory & confidence tracking
  private sessionPreferredLanguage: 'English' | 'Urdu' | 'RomanUrdu' | null = null;
  private languageConfidenceStreak: number = 0;

  // Track previous turn for multi-turn query contextualization
  private lastUserTurn: string = '';

  // Turn counter for limit enforcement
  private turnCount: number = 0;

  // Per-turn state
  private aiTranscriptBuffer: string = '';
  private pendingTurnAudit: VoiceAuditRecord | null = null;
  private turnStartTime: number = 0;
  private selectedVoice: string = 'shimmer';

  // Lifecycle guards & timers
  private greetingSent: boolean = false;
  private sessionReadySent: boolean = false;
  private isResponseInProgress: boolean = false;
  private isClosingGracefully: boolean = false;
  private lastTurnTimestamp: number = 0;

  // Production Safeguard Timers
  private maxDurationTimer: NodeJS.Timeout | null = null;
  private silenceTimeoutTimer: NodeJS.Timeout | null = null;
  private heartbeatInterval: NodeJS.Timeout | null = null;

  private agentId?: string;
  private publicKey?: string;
  private slug?: string;

  constructor(params: VoiceSessionParams) {
    this.socket = params.socket;
    this.sessionIdNum = params.sessionId ? parseInt(params.sessionId, 10) : null;
    this.agentId = params.agentId;
    this.publicKey = params.publicKey;
    this.slug = params.slug;
    this.language = params.language === 'ur' ? 'Urdu' : 'English';
    this.clientIp = params.clientIp || '127.0.0.1';
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
    this.openAiWs.send(JSON.stringify(payload));
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

  private cleanupTimers() {
    if (this.maxDurationTimer) { clearTimeout(this.maxDurationTimer); this.maxDurationTimer = null; }
    if (this.silenceTimeoutTimer) { clearTimeout(this.silenceTimeoutTimer); this.silenceTimeoutTimer = null; }
    if (this.heartbeatInterval) { clearInterval(this.heartbeatInterval); this.heartbeatInterval = null; }
    SecurityShieldService.unregisterVoiceCallSession(this.clientIp, this);
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
    const vadThreshold = typeof vSettings.vadThreshold === 'number' ? vSettings.vadThreshold : 0.70;
    const vadSilenceDurationMs = typeof vSettings.vadSilenceDurationMs === 'number' ? vSettings.vadSilenceDurationMs : 800;
    const vadPrefixPaddingMs = typeof vSettings.vadPrefixPaddingMs === 'number' ? vSettings.vadPrefixPaddingMs : 300;
    const voiceResponseDelayMs = typeof vSettings.voiceResponseDelayMs === 'number' ? vSettings.voiceResponseDelayMs : 600;
    const minTranscriptLength = typeof vSettings.minTranscriptLength === 'number' ? vSettings.minTranscriptLength : 3;
    const minWordCount = typeof vSettings.minWordCount === 'number' ? vSettings.minWordCount : 2;

    const validVoices = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'sage', 'shimmer', 'verse', 'marin', 'cedar'];
    const rawVoice = (agent.voice || 'shimmer').toLowerCase();
    this.selectedVoice = validVoices.includes(rawVoice) ? rawVoice : 'shimmer';

    console.log(`\n[SESSION LIFECYCLE ${ts()}] ▶ Session START`);
    console.log(`  Tenant     : ${agent.name} (${tenantId})`);
    console.log(`  Voice      : ${this.selectedVoice} | IP: ${this.clientIp}`);
    console.log(`  Turn Count : ${this.turnCount}/20 (Voice Cap)`);

    // ── Build base system prompt ─────────────────────────────────────────────
    const baseInstructions = PromptService.buildSystemPrompt({
      tenantConfig: this.tenantConfig,
      language: this.language,
      isVoice: true,
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

      const sessionConfig = {
        type: 'session.update',
        session: {
          type: 'realtime',
          instructions: `${baseInstructions}\nSupported Languages: STRICTLY English and Urdu ONLY. Never detect, respond in, or recognize Hindi or Devanagari script.`,
          audio: {
            input: {
              format: { type: 'audio/pcm', rate: 24000 },
              transcription: {
                model: 'gpt-realtime-whisper',
                language: (this.language === 'Urdu' || agent.autoLanguageDetection || (agent.language && agent.language.toLowerCase().includes('ur'))) ? 'ur' : undefined,
              },
              turn_detection: {
                type: 'server_vad',
                threshold: vadThreshold,
                prefix_padding_ms: vadPrefixPaddingMs,
                silence_duration_ms: vadSilenceDurationMs,
                create_response: false,
              },
            },
            output: {
              format: { type: 'audio/pcm', rate: 24000 },
              voice: this.selectedVoice,
            },
          },
        },
      };

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
          const isUrdu = this.language === 'Urdu';
          const agentName = this.tenantConfig?.agent.name || 'EFU General Insurance';
          const greetingText = isUrdu
            ? `سلام! میں ${agentName} کی خودمختار ورچوئل اسسٹنٹ ہوں۔ میں آپ کی کیا مدد کر سکتی ہوں؟`
            : `Hello! I am the AI Virtual Support Assistant for ${agentName}. How may I assist you today?`;

          const langDirective = isUrdu
            ? `[RESPOND 100% IN URDU — FEMALE VERBS ONLY]`
            : `[RESPOND 100% IN ENGLISH]`;

          console.log(`[PIPELINE ${ts()}] → SENDING response.create() [INITIAL GREETING]`);
          this.sendResponseCreate({
            type: 'response.create',
            response: {
              instructions: `${langDirective}\n[GREETING DIRECTIVE]: Speak EXACTLY this greeting text in ${this.language}: "${greetingText}"`,
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
        this.aiTranscriptBuffer += event.delta;
      }

      if (event.type === 'response.done') {
        if (this.tenantConfig && this.sessionIdNum && this.leadId && this.aiTranscriptBuffer.trim()) {
          await ConversationService.saveMessage({
            tenantId: this.tenantConfig.tenantId,
            agentId: this.tenantConfig.agent.id,
            sessionId: this.sessionIdNum,
            visitorId: this.dbSession?.visitorId,
            leadId: this.leadId,
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
      }

      // ── Core Audio Transcription Turn Handling ─────────────────────────────
      if (
        event.type === 'conversation.item.input_audio_transcription.completed' &&
        event.transcript
      ) {
        const rawSpeech = event.transcript.trim();
        if (!rawSpeech || !this.tenantConfig) return;

        // Reset silence timeout on user activity
        this.resetSilenceTimeout();

        const userSpeech = normalizeHindiToUrdu(rawSpeech);

        if (isNoisyTranscript(userSpeech, minTranscriptLength, minWordCount)) {
          console.log(`[PIPELINE ${ts()}] ⏭ IGNORED noisy transcript: "${userSpeech}"`);
          return;
        }

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
        if (this.lastTurnTimestamp > 0 && (nowMs - this.lastTurnTimestamp < 2500)) {
          console.log(`[PIPELINE ${ts()}] ⏱ ANTI-BOT THROTTLE — ignored rapid turn (<2.5s gap)`);
          return;
        }
        this.lastTurnTimestamp = nowMs;

        // ── Security Layer 2: Voice Session Turn Cap & Warning Check ────────
        const turnCapCheck = SecurityShieldService.checkSessionTurnCap(this.turnCount, 'voice');

        // Turn 20: Hard Cap Reached
        if (turnCapCheck.exceeded) {
          console.log(`[PIPELINE ${ts()}] 🛑 VOICE SESSION TURN CAP REACHED (Turn #${this.turnCount}/20) — initiating graceful goodbye`);
          this.isClosingGracefully = true;
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
        if (this.sessionIdNum && this.leadId) {
          await ConversationService.saveMessage({
            tenantId: this.tenantConfig.tenantId,
            agentId: this.tenantConfig.agent.id,
            sessionId: this.sessionIdNum,
            visitorId: this.dbSession?.visitorId,
            leadId: this.leadId,
            sender: 'visitor',
            message: userSpeech,
          });
        }

        // ── Intent Path A: Conversational Greetings & Affirmations ──────────
        const isGreeting = isConversationalGreeting(userSpeech);
        const isAffirmation = isConversationalAffirmation(userSpeech);

        if (isGreeting || isAffirmation) {
          const intentDecision = isGreeting ? 'CONVERSATIONAL_GREETING' : 'CONVERSATIONAL_AFFIRMATION';
          const greetingLangMandate = isUrdu
            ? `[RESPOND 100% IN URDU — FEMALE VERBS ONLY]`
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
        const threshold = isUrdu ? Math.min(rawThreshold, 0.25) : Math.min(rawThreshold, 0.38);
        const searchQuery = contextualizeQuery(userSpeech, this.lastUserTurn);

        const retrieval = await RetrievalService.search(
          this.tenantConfig.tenantId,
          searchQuery,
          4,
          threshold,
        );

        this.lastUserTurn = userSpeech;
        const retrievalMs = retrieval.timings.totalMs;
        const thinkingDelayMs = computeThinkingDelay(retrievalMs, voiceResponseDelayMs);

        if (!this.openAiWs || this.openAiWs.readyState !== WebSocket.OPEN) return;

        if (thinkingDelayMs > 0) {
          await new Promise((r) => setTimeout(r, thinkingDelayMs));
        }

        const agentName = this.tenantConfig.agent.name?.trim() || 'EFU General Insurance';
        const langGenderMandate = isUrdu
          ? `[RESPOND 100% IN URDU — FEMALE VERBS ONLY]`
          : `[RESPOND 100% IN ENGLISH]`;

        const INSURANCE_KEYWORDS = /\b(insurance|insur|claim|claims|policy|policies|premium|motor|health|travel|marine|fire|engineering|corporate|accident|theft|comprehensive|third.?party|coverage|renewal|renew|hospital|medical|baggage|cargo|indemnity|liability|انشورنس|کلیم|پالیسی|موٹر|ہیلتھ|ٹریول|گاڑی|ایکسیڈنٹ|چوری|ہسپتال|میڈیکل|بیمہ|سامان|کارگو|آگ|فائر|سمندری|انجینئرنگ|کمپریہنسیو|تھرڈ|پارٹی|کوریج|ری?نیوال|پریمیم)\b/i;
        const hasInsuranceKeyword = INSURANCE_KEYWORDS.test(userSpeech);

        if (retrieval.fallbackTriggered) {
          const isFollowUp = !!this.lastUserTurn && (
            userSpeech.split(/\s+/).length < 7 || 
            /\b(it|other|others|this|that|also|more|cost|price|details|besides|difference|compare|dono|doosri|doosra|elawa|alawa|aur|batao|konsa|konsi|mazeed|pehla|dosra|teesra|farq|muqabla|دوسرا|دوسری|علاوہ|اور|بتاؤ|مزید|پہلا|تیسرا|فرق|مقابلہ|درمیان|ڈیفرنس)\b/i.test(userSpeech)
          );

          if (isFollowUp || hasInsuranceKeyword) {
            const directive = hasInsuranceKeyword && !isFollowUp
              ? `[INSURANCE QUERY — LOW RETRIEVAL MATCH]: The user asked about ${agentName} insurance services but no exact chunk matched. Answer helpfully in ${detectedLanguage} using product knowledge.`
              : `[TURN DIRECTIVE]: Answer the follow-up query naturally in ${detectedLanguage} using conversation history regarding ${agentName} services.`;

            this.sendResponseCreate({
              type: 'response.create',
              response: {
                instructions: `${langGenderMandate}${warning70Directive}\n${directive}`,
              },
            });
          } else {
            this.sendResponseCreate({
              type: 'response.create',
              response: {
                instructions: `${langGenderMandate}${warning70Directive}\n[STRICT OUT-OF-SCOPE DIRECTIVE]: The query is NOT related to insurance. Politely refuse in ${detectedLanguage}. State clearly that you are the assistant for ${agentName}.`,
              },
            });
          }
        } else {
          const contextOnly = retrieval.contextText;
          this.sendResponseCreate({
            type: 'response.create',
            response: {
              instructions: `${langGenderMandate}${warning70Directive}\n[KNOWLEDGE CONTEXT FOR THIS TURN ONLY — Answer clearly in ${detectedLanguage} using this official ${agentName} knowledge base context]:\n${contextOnly}`,
            },
          });
        }
      }
    });

    // ── Cleanup & Closure Event Listeners ────────────────────────────────────
    this.socket.on('close', () => {
      console.log(`[SESSION LIFECYCLE ${ts()}] Browser client DISCONNECTED`);
      this.cleanupTimers();
      if (this.openAiWs && this.openAiWs.readyState !== WebSocket.OPEN) {
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
