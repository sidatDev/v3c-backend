import WebSocket from 'ws';
import { TenantConfigCache, TenantConfig } from '../cache/TenantConfigCache';
import { PromptService } from './PromptService';
import { RetrievalService } from './RetrievalService';
import { ConversationService } from './ConversationService';
import { StructuredLogger } from '../logger/StructuredLogger';
import { VoiceAuditLogger, VoiceAuditRecord } from '../logger/VoiceAuditLogger';
import {
  isNoisyTranscript,
  normalizeHindiToUrdu,
  detectDominantLanguage,
  computeThinkingDelay
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
      if (tenantLower && tenantLower.includes(matchLower)) {
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
                language: (this.language === 'Urdu' || agent.language === 'Urdu' || (agent.supportedLanguages && agent.supportedLanguages.includes('Urdu'))) ? 'ur' : undefined,
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

      // Pass every event straight to the browser client
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

        // Send verbatim greeting EXACTLY ONCE at session initialization
        if (!this.greetingSent && this.turnCount === 0) {
          this.greetingSent = true;
          const greetingText = agent.initialGreetingMessage || 'Assalam-u-Alaikum! How can I help you today?';
          console.log(`[SESSION LIFECYCLE] GREETING SEND (verbatim, once only) — "${greetingText}"`);

          if (this.openAiWs && this.openAiWs.readyState === WebSocket.OPEN) {
            this.openAiWs.send(JSON.stringify({
              type: 'response.create',
              response: {
                instructions: `You MUST speak EXACTLY the following text, word for word, with no additions, modifications, or reinterpretation: "${greetingText}"`,
              },
            }));
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
        const isGreeting = !this.pendingTurnAudit && this.greetingSent && this.aiTranscriptBuffer === '';
        console.log(`[PIPELINE ${ts()}] ⚡ response.created${isGreeting ? ' [GREETING — expected]' : ' [USER TURN]'}`);
      }

      if (event.type === 'response.done') {
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

      // ── CORE: Backend-authoritative RAG orchestration ─────────────────────
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

        // 3. Dominant Language Classification & Session Language Memory (#4, #9)
        const prevLang = this.sessionPreferredLanguage;
        const dominantLang = detectDominantLanguage(userSpeech);

        if (this.sessionPreferredLanguage === dominantLang) {
          this.languageConfidenceStreak++;
        } else if (!this.sessionPreferredLanguage) {
          this.sessionPreferredLanguage = dominantLang;
          this.languageConfidenceStreak = 1;
        } else {
          // Switch session preferred language if confidence streak builds or utterance is substantial
          if (this.languageConfidenceStreak >= 2 || userSpeech.split(/\s+/).length >= 4) {
            console.log(`[PIPELINE ${ts()}] 🌐 Session language switched: ${this.sessionPreferredLanguage} ➔ ${dominantLang}`);
            this.sessionPreferredLanguage = dominantLang;
            this.languageConfidenceStreak = 1;
          }
        }

        const detectedLanguage: 'English' | 'Urdu' | 'RomanUrdu' = this.sessionPreferredLanguage || dominantLang;
        const isUrdu = detectedLanguage === 'Urdu' || detectedLanguage === 'RomanUrdu';

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

        // ── Tenant/entity guard — before any embedding ─────────────────────
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

          // Natural thinking delay before fallback response
          const delayMs = computeThinkingDelay(Date.now() - tTranscriptDone, voiceResponseDelayMs);
          if (delayMs > 0) {
            await new Promise((r) => setTimeout(r, delayMs));
          }

          console.log(`[PIPELINE ${ts()}] → SENDING response.create() [COMPETITOR GUARD fallback]`);
          this.openAiWs.send(JSON.stringify({
            type: 'response.create',
            response: {
              instructions: `You MUST respond with EXACTLY this text and nothing else, in ${detectedLanguage}: "${fallbackText}"`,
            },
          }));
          return;
        }

        // ── RetrievalService — identical to text chat endpoint ──────────────
        const threshold = this.tenantConfig.agent.RetrievalConfig?.similarityThreshold ?? 0.3;
        console.log(`[PIPELINE ${ts()}] ↓ RetrievalService.search() — threshold: ${threshold}`);

        const retrieval = await RetrievalService.search(
          this.tenantConfig.tenantId,
          userSpeech,
          5,
          threshold,
        );

        const retrievalMs = retrieval.timings.totalMs;
        console.log(`[PIPELINE ${ts()}] ↓ Retrieval DONE — topSimilarity: ${retrieval.topSimilarity.toFixed(3)}, chunks: ${retrieval.chunks.length}, fallback: ${retrieval.fallbackTriggered}`);
        console.log(`[PIPELINE ${ts()}]   Timings: embedding=${retrieval.timings.embeddingMs}ms, pgvector=${retrieval.timings.vectorSearchMs}ms, total=${retrievalMs}ms`);

        // Compute natural thinking delay (#1)
        const thinkingDelayMs = computeThinkingDelay(retrievalMs, voiceResponseDelayMs);

        // Build audit record
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
          gptInvoked: !retrieval.fallbackTriggered,
          responseType: retrieval.fallbackTriggered ? 'Fallback' : 'RAG',
          retrievedSources: retrieval.chunks.length,
          voice: this.selectedVoice,
          latencyMs: 0,
        };
        this.pendingTurnAudit = turnAudit;
        VoiceAuditLogger.print(turnAudit);

        if (!this.openAiWs || this.openAiWs.readyState !== WebSocket.OPEN) return;

        // Apply natural thinking delay if retrieval was fast (#1)
        if (thinkingDelayMs > 0) {
          console.log(`[PIPELINE ${ts()}] ⏱ Natural thinking delay: ${thinkingDelayMs}ms before response.create()`);
          await new Promise((r) => setTimeout(r, thinkingDelayMs));
        }

        if (retrieval.fallbackTriggered) {
          // ── Branch A: OUT_OF_SCOPE ─────────────────────────────────────────
          const fallbackText = isUrdu
            ? this.tenantConfig.agent.RetrievalConfig?.fallbackMessageUrdu ||
              'معذرت، میں صرف ہماری کمپنی کی خدمات اور ویب سائٹ کی معلومات کا جواب دے سکتا ہوں۔'
            : this.tenantConfig.agent.RetrievalConfig?.fallbackMessage ||
              'I can only answer questions related to our services and official knowledge base.';

          console.log(`[PIPELINE ${ts()}] → SENDING response.create() [FALLBACK]`);
          this.openAiWs.send(JSON.stringify({
            type: 'response.create',
            response: {
              instructions: `You MUST respond with EXACTLY this text and nothing else, in ${detectedLanguage}: "${fallbackText}"`,
            },
          }));
        } else {
          // ── Branch B: RAG — inject retrieved context for turn ─────────────
          const contextOnly = retrieval.contextText;

          console.log(`[PIPELINE ${ts()}] → SENDING conversation.item.create [${retrieval.chunks.length} chunks]`);

          this.openAiWs.send(JSON.stringify({
            type: 'conversation.item.create',
            item: {
              type: 'message',
              role: 'user',
              content: [{
                type: 'input_text',
                text: `[RETRIEVED KNOWLEDGE — THIS TURN ONLY. Answer the user's question using ONLY this context.]\n${contextOnly}`,
              }],
            },
          }));

          const totalPipelineMs = Date.now() - tTranscriptDone;
          console.log(`[PIPELINE ${ts()}] → SENDING response.create() [RAG] — total pipeline from transcript: ${totalPipelineMs}ms`);

          this.openAiWs.send(JSON.stringify({ type: 'response.create' }));
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
