import WebSocket from 'ws';
import { TenantConfigCache, TenantConfig } from '../cache/TenantConfigCache';
import { PromptService } from './PromptService';
import { RetrievalService } from './RetrievalService';
import { ConversationService } from './ConversationService';
import { SecurityShieldService } from '../security/SecurityShieldService';
import { StructuredLogger } from '../logger/StructuredLogger';
import { VoiceAuditLogger, VoiceAuditRecord } from '../logger/VoiceAuditLogger';
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

export interface VoiceSessionParams {
  socket: WebSocket;
  sessionId?: string;
  agentId?: string;
  publicKey?: string;
  slug?: string;
  language?: string;
}

export class RealtimeSessionManager {
  private socket: WebSocket;
  private openAiWs: WebSocket | null = null;
  private tenantConfig: TenantConfig | null = null;
  private language: string;
  private sessionIdNum: number | null = null;
  private dbSession: any = null;
  private leadId: number | null = null;

  // Session-level language memory & confidence tracking
  private sessionPreferredLanguage: 'English' | 'Urdu' | 'RomanUrdu' | null = null;
  private languageConfidenceStreak: number = 0;

  // Track previous turn for multi-turn query contextualization
  private lastUserTurn: string = '';

  // Turn counter for greeting replay protection & pipeline tracking
  private turnCount: number = 0;

  // Per-turn state
  private aiTranscriptBuffer: string = '';
  private pendingTurnAudit: VoiceAuditRecord | null = null;
  private turnStartTime: number = 0;
  private selectedVoice: string = 'shimmer';

  // Lifecycle guards
  private greetingSent: boolean = false;
  private sessionReadySent: boolean = false;
  private isResponseInProgress: boolean = false;
  private lastTurnTimestamp: number = 0;

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
  }

  private sendResponseCreate(payload: any) {
    if (!this.openAiWs || this.openAiWs.readyState !== WebSocket.OPEN) return;
    if (this.isResponseInProgress) {
      console.log(`[PIPELINE] ⚠️ Active response in progress — sending response.cancel before creating new response`);
      try {
        this.openAiWs.send(JSON.stringify({ type: 'response.cancel' }));
      } catch (_) {}
      this.isResponseInProgress = false;
    }
    this.openAiWs.send(JSON.stringify(payload));
  }

  async start(): Promise<void> {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      this.socket.send(JSON.stringify({ type: 'error', message: 'OpenAI API Key not configured' }));
      this.socket.close();
      return;
    }

    // ── 1. Resolve Tenant Configuration ──────────────────────────────────────
    try {
      this.tenantConfig = await TenantConfigCache.getTenantConfig(this.publicKey, this.agentId, this.slug);
    } catch (err: any) {
      StructuredLogger.error('[SESSION] Failed to resolve tenant config', { error: err?.message });
      this.socket.send(JSON.stringify({ type: 'error', message: 'Tenant configuration failure' }));
      this.socket.close();
      return;
    }

    const { tenantId, agent } = this.tenantConfig;

    // Configurable voice parameters with fallback to enterprise production defaults
    const vSettings = (agent.voiceSettings as any) || {};
    const vadThreshold = typeof vSettings.vadThreshold === 'number' ? vSettings.vadThreshold : 0.65;
    const vadSilenceDurationMs = typeof vSettings.vadSilenceDurationMs === 'number' ? vSettings.vadSilenceDurationMs : 800;
    const vadPrefixPaddingMs = typeof vSettings.vadPrefixPaddingMs === 'number' ? vSettings.vadPrefixPaddingMs : 400;
    const voiceResponseDelayMs = typeof vSettings.voiceResponseDelayMs === 'number' ? vSettings.voiceResponseDelayMs : 600;
    const minTranscriptLength = typeof vSettings.minTranscriptLength === 'number' ? vSettings.minTranscriptLength : 3;
    const minWordCount = typeof vSettings.minWordCount === 'number' ? vSettings.minWordCount : 2;

    // Normalise voice to a valid OpenAI Realtime WebSocket voice name
    const validVoices = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'sage', 'shimmer', 'verse', 'marin', 'cedar'];
    const rawVoice = (agent.voice || 'shimmer').toLowerCase();
    this.selectedVoice = validVoices.includes(rawVoice) ? rawVoice : 'shimmer';

    console.log(`\n[SESSION LIFECYCLE] ▶ Session START`);
    console.log(`  Tenant     : ${agent.name} (${tenantId})`);
    console.log(`  Agent ID   : ${agent.id}`);
    console.log(`  Voice      : ${this.selectedVoice}`);
    console.log(`  Language   : ${this.language}`);
    console.log(`  VAD Config : threshold=${vadThreshold}, silence=${vadSilenceDurationMs}ms, prefix=${vadPrefixPaddingMs}ms`);
    console.log(`  Timing     : targetThinkingDelay=${voiceResponseDelayMs}ms`);

    // ── 2. Load DB Session & Lead ─────────────────────────────────────────────
    if (this.sessionIdNum) {
      const sessionCtx = await ConversationService.getSessionContext(this.sessionIdNum, tenantId);
      this.dbSession = sessionCtx.dbSession;
      this.leadId = sessionCtx.leadId;
    }

    // ── 3. Build lean base system prompt (NO static KB — RAG injects per-turn) ─
    const baseInstructions = PromptService.buildSystemPrompt({
      tenantConfig: this.tenantConfig,
      language: this.language,
      isVoice: true,
    });

    // ── 4. Open OpenAI Realtime WebSocket ─────────────────────────────────────
    const openAiUrl = 'wss://api.openai.com/v1/realtime?model=gpt-realtime-mini';
    console.log(`[SESSION LIFECYCLE] Connecting to OpenAI Realtime: ${openAiUrl}`);

    this.openAiWs = new WebSocket(openAiUrl, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });

    // ── 5. Session initialisation ─────────────────────────────────────────────
    this.openAiWs.on('open', () => {
      console.log(`[SESSION LIFECYCLE] WebSocket CONNECTED to OpenAI`);
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
      console.log(`[SESSION LIFECYCLE] session.update sent — waiting for session.updated confirmation`);
    });

    // ── 6. Proxy audio from browser → OpenAI (pass-through only) ─────────────
    this.socket.on('message', (message: WebSocket.RawData) => {
      try {
        const msg = JSON.parse(message.toString());
        if (msg.type !== 'input_audio_buffer.append') {
          console.log(`[SESSION LIFECYCLE] Client → OpenAI: ${msg.type}`);
        }
      } catch (_) {}

      if (this.openAiWs && this.openAiWs.readyState === WebSocket.OPEN) {
        this.openAiWs.send(message.toString());
      }
    });

    // ── 7. Handle OpenAI events — orchestrate every voice turn ────────────────
    this.openAiWs.on('message', async (data: WebSocket.RawData) => {
      const msgStr = data.toString();
      const ts = () => new Date().toISOString();

      if (this.socket.readyState === WebSocket.OPEN) {
        this.socket.send(msgStr);
      }

      let event: any;
      try {
        event = JSON.parse(msgStr);
      } catch (_) {
        return;
      }

      const audioEventTypes = new Set([
        'response.audio.delta',
        'response.output_audio.delta',
        'response.audio_transcript.delta',
        'response.output_audio_transcript.delta',
      ]);
      if (!audioEventTypes.has(event.type)) {
        console.log(`[TRACE ${ts()}] ${event.type}${event.error?.message ? ' — ERROR: ' + event.error.message : ''}`);
      }

      // ── session.updated: log effective config & send verbatim greeting ──────
      if (event.type === 'session.updated') {
        const s = event.session;
        const cr = s.audio?.input?.turn_detection?.create_response;
        const txModel = s.audio?.input?.transcription?.model;
        console.log(`\n[SESSION CONFIG — EFFECTIVE]`);
        console.log(`  Model              : ${s.model}`);
        console.log(`  Voice              : ${s.audio?.output?.voice ?? '(not set)'}`);
        console.log(`  Transcription Model: ${txModel ?? '(none — transcription DISABLED)'}`);
        console.log(`  VAD threshold      : ${s.audio?.input?.turn_detection?.threshold}`);
        console.log(`  VAD silenceMs      : ${s.audio?.input?.turn_detection?.silence_duration_ms}`);
        console.log(`  create_response    : ${cr === false ? 'FALSE ✅ (backend controls responses)' : 'TRUE ⚠'}`);
        console.log(`─────────────────────────────────────────────────────────\n`);

        if (!this.greetingSent && this.turnCount === 0) {
          this.greetingSent = true;
          const greetingText = agent.initialGreetingMessage || 'Assalam-u-Alaikum! How can I help you today?';
          console.log(`[SESSION LIFECYCLE] GREETING SEND (verbatim, once only) — "${greetingText}"`);

          if (this.openAiWs && this.openAiWs.readyState === WebSocket.OPEN) {
            this.sendResponseCreate({
              type: 'response.create',
              response: {
                instructions: `You MUST speak EXACTLY the following text, word for word, with no additions, modifications, or reinterpretation: "${greetingText}"`,
              },
            });
          }

          if (!this.sessionReadySent && this.socket.readyState === WebSocket.OPEN) {
            this.sessionReadySent = true;
            this.socket.send(JSON.stringify({ type: 'session.ready' }));
            console.log(`[SESSION LIFECYCLE] session.ready sent to browser client`);
          }
        } else {
          console.log(`[SESSION LIFECYCLE] session.updated received — greeting NOT re-sent (turnCount: ${this.turnCount}, greetingSent: ${this.greetingSent})`);
        }
      }

      // ── Turn pipeline trace & barge-in tracking ───────────────────────────
      if (event.type === 'input_audio_buffer.speech_started') {
        this.turnCount++;
        console.log(`\n╔══════════════════════════════════════════════════════╗`);
        console.log(`║  VOICE TURN START #${this.turnCount}  @ ${ts()}  ║`);
        console.log(`╚══════════════════════════════════════════════════════╝`);
      }

      if (event.type === 'input_audio_buffer.speech_stopped') {
        console.log(`[PIPELINE ${ts()}] ↓ speech_stopped`);
      }

      if (event.type === 'input_audio_buffer.committed') {
        console.log(`[PIPELINE ${ts()}] ↓ committed — awaiting transcription...`);
      }

      if (event.type === 'response.created') {
        this.isResponseInProgress = true;
        const isGreeting = !this.pendingTurnAudit && this.greetingSent && this.aiTranscriptBuffer === '';
        console.log(`[PIPELINE ${ts()}] ⚡ response.created${isGreeting ? ' [GREETING — expected]' : ' [USER TURN]'}`);
      }

      if (event.type === 'response.done' || event.type === 'response.cancelled') {
        this.isResponseInProgress = false;
        console.log(`[PIPELINE ${ts()}] ↓ response.done`);
      }

      // ── Accumulate AI speech for DB logging ──────────────────────────────
      if (event.type === 'response.output_audio_transcript.delta' && event.delta) {
        this.aiTranscriptBuffer += event.delta;
      }

      // ── response.done: save AI message + finalise audit log ──────────────
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
          if (usage) {
            this.pendingTurnAudit.totalTokens = usage.total_tokens ?? undefined;
          }
          VoiceAuditLogger.printFinal(this.pendingTurnAudit);
          this.pendingTurnAudit = null;
        }
      }

      // ── CORE: Backend-authoritative RAG & Intent orchestration ─────────────
      if (
        event.type === 'conversation.item.input_audio_transcription.completed' &&
        event.transcript
      ) {
        const rawSpeech = event.transcript.trim();
        if (!rawSpeech || !this.tenantConfig) return;

        // 1. Normalize Devanagari (Hindi) Unicode if present
        const userSpeech = normalizeHindiToUrdu(rawSpeech);

        // 2. Transcript Validation Gate (#3, #8)
        if (isNoisyTranscript(userSpeech, minTranscriptLength, minWordCount)) {
          console.log(`[PIPELINE ${ts()}] ⏭ IGNORED noisy/short transcript: "${userSpeech}" — remaining in listening mode`);
          const ignoredAudit: VoiceAuditRecord = {
            conversationId: `${this.tenantConfig.tenantId.substring(0, 8)}-${Date.now()}`,
            userTranscript: userSpeech,
            detectedLanguage: this.sessionPreferredLanguage || 'English',
            dominantLanguage: this.sessionPreferredLanguage || 'English',
            previousSessionLanguage: this.sessionPreferredLanguage || undefined,
            finalResponseLanguage: this.sessionPreferredLanguage || undefined,
            greetingReplayDetected: false,
            ignoredTranscript: true,
            transcriptLength: userSpeech.length,
            wordCount: userSpeech.split(/\s+/).length,
            thinkingDelayMs: 0,
            retrievalLatencyMs: 0,
            embeddingGenerated: false,
            topMatches: [],
            similarityThreshold: 0,
            highestSimilarity: 0,
            decision: 'IGNORED_NOISE',
            fallbackTriggered: false,
            gptInvoked: false,
            responseType: 'Ignored',
            retrievedSources: 0,
            voice: this.selectedVoice,
            latencyMs: 0,
          };
          VoiceAuditLogger.print(ignoredAudit);
          VoiceAuditLogger.printFinal(ignoredAudit);
          return;
        }

        this.turnStartTime = Date.now();
        const tTranscriptDone = Date.now();

        console.log(`[PIPELINE ${ts()}] ↓ transcription.completed — "${userSpeech.substring(0, 80)}"`);

        // 3. Dominant Language Classification & Per-Turn Language Matching
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

        // Match the current turn's dominant spoken language
        const detectedLanguage: 'English' | 'Urdu' | 'RomanUrdu' = dominantLang;
        const isUrdu = detectedLanguage === 'Urdu' || detectedLanguage === 'RomanUrdu';

        // ── Security Layer 1: Anti-Bot Turn Cooldown Throttling ──────────────
        const nowMs = Date.now();
        if (this.lastTurnTimestamp > 0 && (nowMs - this.lastTurnTimestamp < 2500)) {
          console.log(`[PIPELINE ${ts()}] ⏱ ANTI-BOT THROTTLE — ignored rapid turn (<2.5s gap)`);
          return;
        }
        this.lastTurnTimestamp = nowMs;

        // ── Security Layer 2: Session Turn Cap Check ────────────────────────
        const turnCapCheck = SecurityShieldService.checkSessionTurnCap(this.turnCount, 25);
        if (turnCapCheck.exceeded) {
          console.log(`[PIPELINE ${ts()}] 🛑 SESSION TURN CAP REACHED (${this.turnCount}/25) — sending turn limit notice`);
          const capNotice = isUrdu
            ? 'آپ کے وائس سیشن کی گفتگو کی حد مکمل ہو چکی ہے۔ مزید معلومات کے لیے اپنا نمبر چھوڑ دیں۔'
            : 'You have reached the session conversation limit. Please leave your contact details so our support team can follow up with you.';

          this.sendResponseCreate({
            type: 'response.create',
            response: {
              instructions: `You MUST respond with EXACTLY this text and nothing else, in ${detectedLanguage}: "${capNotice}"`,
            },
          });
          return;
        }

        // ── Security Layer 3: Prompt Injection Shield ───────────────────────
        const injectionMatch = SecurityShieldService.detectPromptInjection(userSpeech);
        if (injectionMatch) {
          console.log(`[PIPELINE ${ts()}] 🛡 PROMPT INJECTION SHIELD TRIGGERED: "${injectionMatch}" — refusing payload`);
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
          console.log(`[PIPELINE ${ts()}] 💬 ${intentDecision} DETECTED: "${userSpeech}" — using Agent System Prompt, bypassing fallback`);

          const greetingAudit: VoiceAuditRecord = {
            conversationId: `${this.tenantConfig.tenantId.substring(0, 8)}-${Date.now()}`,
            userTranscript: userSpeech,
            detectedLanguage,
            dominantLanguage: dominantLang,
            previousSessionLanguage: prevLang || undefined,
            finalResponseLanguage: detectedLanguage,
            greetingReplayDetected: false,
            ignoredTranscript: false,
            transcriptLength: userSpeech.length,
            wordCount: userSpeech.split(/\s+/).length,
            thinkingDelayMs: 0,
            retrievalLatencyMs: 0,
            embeddingGenerated: false,
            topMatches: [],
            similarityThreshold: 0,
            highestSimilarity: 0,
            decision: intentDecision as any,
            fallbackTriggered: false,
            gptInvoked: true,
            responseType: 'SystemPrompt',
            retrievedSources: 0,
            voice: this.selectedVoice,
            latencyMs: Date.now() - this.turnStartTime,
          };
          this.pendingTurnAudit = greetingAudit;
          VoiceAuditLogger.print(greetingAudit);

          if (!this.openAiWs || this.openAiWs.readyState !== WebSocket.OPEN) return;

          // Apply natural thinking delay before natural persona response
          const delayMs = computeThinkingDelay(Date.now() - tTranscriptDone, voiceResponseDelayMs);
          if (delayMs > 0) {
            await new Promise((r) => setTimeout(r, delayMs));
          }
          // Per-turn language & gender mandate for greetings too
          const greetingLangMandate = isUrdu
            ? `[STRICT LANGUAGE & GENDER MANDATE]: Respond in URDU. You are a FEMALE assistant — use female verbs ("سمجھتی ہوں", "بتا سکتی ہوں"). NEVER use male verbs. No Hindi words.`
            : `[STRICT LANGUAGE MANDATE]: Respond in ENGLISH only.`;

          this.lastUserTurn = userSpeech;
          console.log(`[PIPELINE ${ts()}] → SENDING response.create() [SYSTEM PROMPT PERSONA PATH]`);
          this.sendResponseCreate({
            type: 'response.create',
            response: {
              instructions: `${greetingLangMandate}\n[USER TURN]: "${userSpeech}"\nRespond warmly and clearly in ${detectedLanguage} as a professional enterprise support agent. If asked about our services or company overview, introduce our primary services clearly.`,
            },
          });
          return;
        }

        // ── Competitor Shield Guard ──────────────────────────────────────────
        const competitorMatch = detectCompetitor(userSpeech, this.tenantConfig.agent.name);
        if (competitorMatch) {
          console.log(`[PIPELINE ${ts()}] 🚫 COMPETITOR DETECTED: "${competitorMatch}" — skipping retrieval, returning fallback immediately`);

          const fallbackText = isUrdu
            ? this.tenantConfig.agent.RetrievalConfig?.fallbackMessageUrdu ||
              'معذرت، میں صرف ہماری کمپنی کی خدمات اور ویب سائٹ کی معلومات کا جواب دے سکتا ہوں۔'
            : this.tenantConfig.agent.RetrievalConfig?.fallbackMessage ||
              'I can only answer questions related to our services and official knowledge base.';

          const competitorAudit: VoiceAuditRecord = {
            conversationId: `${this.tenantConfig.tenantId.substring(0, 8)}-${Date.now()}`,
            userTranscript: userSpeech,
            detectedLanguage,
            dominantLanguage: dominantLang,
            previousSessionLanguage: prevLang || undefined,
            finalResponseLanguage: detectedLanguage,
            greetingReplayDetected: false,
            ignoredTranscript: false,
            transcriptLength: userSpeech.length,
            wordCount: userSpeech.split(/\s+/).length,
            thinkingDelayMs: 0,
            retrievalLatencyMs: 0,
            embeddingGenerated: false,
            topMatches: [],
            similarityThreshold: 0,
            highestSimilarity: 0,
            decision: 'OUT_OF_SCOPE',
            fallbackTriggered: true,
            gptInvoked: false,
            responseType: 'Fallback',
            retrievedSources: 0,
            voice: this.selectedVoice,
            latencyMs: Date.now() - this.turnStartTime,
          };
          VoiceAuditLogger.print(competitorAudit);
          VoiceAuditLogger.printFinal(competitorAudit);

          if (!this.openAiWs || this.openAiWs.readyState !== WebSocket.OPEN) return;

          const delayMs = computeThinkingDelay(Date.now() - tTranscriptDone, voiceResponseDelayMs);
          if (delayMs > 0) {
            await new Promise((r) => setTimeout(r, delayMs));
          }

          this.lastUserTurn = userSpeech;
          console.log(`[PIPELINE ${ts()}] → SENDING response.create() [COMPETITOR GUARD fallback]`);
          this.sendResponseCreate({
            type: 'response.create',
            response: {
              instructions: `You MUST respond with EXACTLY this text and nothing else, in ${detectedLanguage}: "${fallbackText}"`,
            },
          });
          return;
        }

        // ── Intent Path B: Grounded Vector Search (RAG) ─────────────────────
        const rawThreshold = this.tenantConfig.agent.RetrievalConfig?.similarityThreshold ?? 0.35;
        // FIX 1: Language-aware threshold — Urdu queries against English-indexed KB naturally score ~0.25-0.33
        const threshold = isUrdu ? Math.min(rawThreshold, 0.25) : Math.min(rawThreshold, 0.38);
        const searchQuery = contextualizeQuery(userSpeech, this.lastUserTurn);
        console.log(`[PIPELINE ${ts()}] ↓ RetrievalService.search() — query: "${searchQuery.substring(0, 80)}", threshold: ${threshold} (lang: ${detectedLanguage})`);

        const retrieval = await RetrievalService.search(
          this.tenantConfig.tenantId,
          searchQuery,
          5,
          threshold,
        );

        this.lastUserTurn = userSpeech;
        const retrievalMs = retrieval.timings.totalMs;
        console.log(`[PIPELINE ${ts()}] ↓ Retrieval DONE — topSimilarity: ${retrieval.topSimilarity.toFixed(3)}, chunks: ${retrieval.chunks.length}, fallback: ${retrieval.fallbackTriggered}`);
        console.log(`[PIPELINE ${ts()}]   Timings: embedding=${retrieval.timings.embeddingMs}ms, pgvector=${retrieval.timings.vectorSearchMs}ms, total=${retrievalMs}ms`);

        const thinkingDelayMs = computeThinkingDelay(retrievalMs, voiceResponseDelayMs);

        const turnAudit: VoiceAuditRecord = {
          conversationId: `${this.tenantConfig.tenantId.substring(0, 8)}-${Date.now()}`,
          userTranscript: userSpeech,
          detectedLanguage,
          dominantLanguage: dominantLang,
          previousSessionLanguage: prevLang || undefined,
          finalResponseLanguage: detectedLanguage,
          greetingReplayDetected: false,
          ignoredTranscript: false,
          transcriptLength: userSpeech.length,
          wordCount: userSpeech.split(/\s+/).length,
          thinkingDelayMs,
          retrievalLatencyMs: retrievalMs,
          embeddingGenerated: true,
          topMatches: retrieval.chunks.slice(0, 3).map((c) => ({
            chunkId: String(c.id ?? '?'),
            similarity: c.similarity,
          })),
          similarityThreshold: threshold,
          highestSimilarity: retrieval.topSimilarity,
          decision: retrieval.fallbackTriggered ? 'OUT_OF_SCOPE' : 'RAG',
          fallbackTriggered: retrieval.fallbackTriggered,
          gptInvoked: true,
          responseType: retrieval.fallbackTriggered ? 'Fallback' : 'RAG',
          retrievedSources: retrieval.chunks.length,
          voice: this.selectedVoice,
          latencyMs: 0,
        };
        this.pendingTurnAudit = turnAudit;
        VoiceAuditLogger.print(turnAudit);

        if (!this.openAiWs || this.openAiWs.readyState !== WebSocket.OPEN) return;

        if (thinkingDelayMs > 0) {
          console.log(`[PIPELINE ${ts()}] ⏱ Natural thinking delay: ${thinkingDelayMs}ms before response.create()`);
          await new Promise((r) => setTimeout(r, thinkingDelayMs));
        }

        const agentName = this.tenantConfig.agent.name?.trim() || 'EFU General Insurance';

        // FIX 3: Per-turn mandatory language & gender directive (prevents OpenAI Realtime from reverting to male verbs or wrong language)
        const langGenderMandate = isUrdu
          ? `[STRICT LANGUAGE & GENDER MANDATE]: You MUST respond 100% in URDU. You are a FEMALE virtual assistant — use ONLY female Urdu verbs (e.g. "کر سکتی ہوں", "سمجھتی ہوں", "بتاتی ہوں", "بتا سکتی ہوں"). NEVER use male verbs ("سکتا ہوں", "کرتا ہوں", "سمجھتا ہوں"). Do NOT use Hindi words.`
          : `[STRICT LANGUAGE MANDATE]: The user is speaking ENGLISH. You MUST respond 100% in ENGLISH. Do NOT speak Urdu.`;

        // FIX 2: Insurance keyword safety net — detect insurance-related terms in any language before refusing
        const INSURANCE_KEYWORDS = /\b(insurance|insur|claim|claims|policy|policies|premium|motor|health|travel|marine|fire|engineering|corporate|accident|theft|comprehensive|third.?party|coverage|renewal|renew|hospital|medical|baggage|cargo|indemnity|liability|انشورنس|کلیم|پالیسی|موٹر|ہیلتھ|ٹریول|گاڑی|ایکسیڈنٹ|چوری|ہسپتال|میڈیکل|بیمہ|سامان|کارگو|آگ|فائر|سمندری|انجینئرنگ|کمپریہنسیو|تھرڈ|پارٹی|کوریج|ری?نیوال|پریمیم)\b/i;
        const hasInsuranceKeyword = INSURANCE_KEYWORDS.test(userSpeech);

        if (retrieval.fallbackTriggered) {
          // FIX 4: Improved follow-up detection — checks conversation history, word count, keywords, AND insurance terms
          const isFollowUp = !!this.lastUserTurn && (
            userSpeech.split(/\s+/).length < 7 || 
            /\b(it|other|others|this|that|also|more|cost|price|details|besides|difference|compare|dono|doosri|doosra|elawa|alawa|aur|batao|konsa|konsi|mazeed|pehla|dosra|teesra|farq|muqabla|دوسرا|دوسری|علاوہ|اور|بتاؤ|مزید|پہلا|تیسرا|فرق|مقابلہ|درمیان|ڈیفرنس)\b/i.test(userSpeech)
          );

          if (isFollowUp || hasInsuranceKeyword) {
            // Insurance-related query or follow-up — answer using conversation context, NOT strict refusal
            const directive = hasInsuranceKeyword && !isFollowUp
              ? `[INSURANCE QUERY — LOW RETRIEVAL MATCH]: The user asked about ${agentName} insurance services but no exact knowledge base chunk matched. Answer the query naturally and helpfully in ${detectedLanguage} using your knowledge of ${agentName} products. If you don't have specific details, offer to connect them with official ${agentName} support channels.`
              : `[TURN DIRECTIVE]: Answer the user's follow-up query naturally and accurately in ${detectedLanguage} using recent conversation history regarding ${agentName} services.`;

            console.log(`[PIPELINE ${ts()}] → SENDING response.create() [${hasInsuranceKeyword ? 'INSURANCE KEYWORD SAFETY NET' : 'MULTI-TURN FOLLOW-UP'} DIRECTIVE]`);
            this.sendResponseCreate({
              type: 'response.create',
              response: {
                instructions: `${langGenderMandate}\n${directive}`,
              },
            });
          } else {
            console.log(`[PIPELINE ${ts()}] → SENDING response.create() [STRICT OUT-OF-SCOPE REFUSAL DIRECTIVE]`);
            this.sendResponseCreate({
              type: 'response.create',
              response: {
                instructions: `${langGenderMandate}\n[STRICT OUT-OF-SCOPE DIRECTIVE]: The user's query is NOT related to insurance. You MUST politely refuse in ${detectedLanguage}. State clearly that you are the AI assistant for ${agentName} and can only assist with ${agentName} insurance services. Under NO circumstances provide instructions, troubleshooting, or general knowledge for non-insurance topics.`,
              },
            });
          }
        } else {
          // ── RAG — inject retrieved context TURN-SCOPED inside response.create (Token Optimized) ──────
          const contextOnly = retrieval.contextText;
          const totalPipelineMs = Date.now() - tTranscriptDone;

          console.log(`[PIPELINE ${ts()}] → SENDING response.create() [TOKEN OPTIMIZED TURN-SCOPED RAG] (${retrieval.chunks.length} chunks) — pipeline: ${totalPipelineMs}ms`);

          this.sendResponseCreate({
            type: 'response.create',
            response: {
              instructions: `${langGenderMandate}\n[KNOWLEDGE CONTEXT FOR THIS TURN ONLY — Answer the user's question clearly and helpfully in ${detectedLanguage} using this official ${agentName} knowledge base context. STRICT RELEVANCE GUARD: If the query is general geography, country trivia, or non-insurance topics, ONLY explain relevant ${agentName} insurance products and politely state you can only assist with ${agentName} services]:\n${contextOnly}`,
            },
          });
        }
      }
    });

    // ── 8. Cleanup & Closure ──────────────────────────────────────────────────
    this.socket.on('close', () => {
      console.log(`[SESSION LIFECYCLE] Browser client DISCONNECTED`);
      if (this.openAiWs && this.openAiWs.readyState === WebSocket.OPEN) {
        this.openAiWs.close();
      }
    });

    this.openAiWs.on('close', () => {
      console.log(`[SESSION LIFECYCLE] OpenAI WS CLOSED`);
      if (this.socket.readyState === WebSocket.OPEN) {
        this.socket.close();
      }
    });

    this.openAiWs.on('error', (err: any) => {
      StructuredLogger.error('[SESSION] OpenAI WS Error', { error: err?.message || err });
      if (this.socket.readyState === WebSocket.OPEN) {
        this.socket.send(JSON.stringify({ type: 'error', message: 'Voice session error' }));
      }
    });

    this.socket.on('error', (err: any) => {
      StructuredLogger.error('[SESSION] Client WS Error', { error: err?.message || err });
    });
  }
}
