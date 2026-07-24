import WebSocket from 'ws';
import { TenantConfigCache, TenantConfig } from '../cache/TenantConfigCache';
import { PromptService } from './PromptService';
import { RetrievalService } from './RetrievalService';
import { ConversationService } from './ConversationService';
import { StructuredLogger } from '../logger/StructuredLogger';
import { VoiceAuditLogger, VoiceAuditRecord } from '../logger/VoiceAuditLogger';

// ── Competitor / out-of-tenant entity guard ──────────────────────────────────
// These companies are never in scope for any tenant. If a user query explicitly
// names one of them, we skip embedding + pgvector entirely and return the
// configured fallback immediately.
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
      // Skip if the matched competitor name is part of the current tenant's own name
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

  // Per-turn state
  private aiTranscriptBuffer: string = '';
  private pendingTurnAudit: VoiceAuditRecord | null = null;
  private turnStartTime: number = 0;
  private selectedVoice: string = 'shimmer';

  // Lifecycle guards — each must fire exactly once per session
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

    // Normalise voice to a valid OpenAI Realtime WebSocket voice name
    const validVoices = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'sage', 'shimmer', 'verse', 'marin', 'cedar'];
    const rawVoice = (agent.voice || 'shimmer').toLowerCase();
    this.selectedVoice = validVoices.includes(rawVoice) ? rawVoice : 'shimmer';

    console.log(`\n[SESSION LIFECYCLE] ▶ Session START`);
    console.log(`  Tenant     : ${agent.name} (${tenantId})`);
    console.log(`  Agent ID   : ${agent.id}`);
    console.log(`  Voice      : ${this.selectedVoice}`);
    console.log(`  Language   : ${this.language}`);

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

      /**
       * CRITICAL SESSION CONFIG
       * Voice nested inside audio.output — top-level 'voice' is rejected.
       * Transcription and VAD nested inside audio.input.
       * create_response: false — backend is the sole caller of response.create().
       */
      const sessionConfig = {
        type: 'session.update',
        session: {
          type: 'realtime',
          instructions: `${baseInstructions}\nSupported Languages: STRICTLY English and Urdu ONLY. Never detect, respond in, or recognize Hindi or any other language or script.`,
          audio: {
            input: {
              format: { type: 'audio/pcm', rate: 24000 },
              transcription: {
                model: 'gpt-realtime-whisper',
                language: 'ur',
              },
              turn_detection: {
                type: 'server_vad',
                threshold: 0.5,
                prefix_padding_ms: 300,
                silence_duration_ms: 500,
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

      // Skip high-frequency audio chunk events in trace logs
      const audioEventTypes = new Set([
        'response.audio.delta',
        'response.output_audio.delta',
        'response.audio_transcript.delta',
        'response.output_audio_transcript.delta',
      ]);
      if (!audioEventTypes.has(event.type)) {
        console.log(`[TRACE ${ts()}] ${event.type}${event.error?.message ? ' — ERROR: ' + event.error.message : ''}`);
      }

      // ── session.updated: log effective config ─────────────────────────────
      if (event.type === 'session.updated') {
        const s = event.session;
        const cr = s.audio?.input?.turn_detection?.create_response;
        const txModel = s.audio?.input?.transcription?.model;
        console.log(`\n[SESSION CONFIG — EFFECTIVE]`);
        console.log(`  Model              : ${s.model}`);
        console.log(`  Voice              : ${s.audio?.output?.voice ?? '(not set)'}`);
        console.log(`  Transcription Model: ${txModel ?? '(none — transcription DISABLED)'}`);
        console.log(`  VAD type           : ${s.audio?.input?.turn_detection?.type ?? '(none)'}`);
        console.log(`  create_response    : ${cr === false ? 'FALSE ✅ (backend controls responses)' : cr === true ? 'TRUE ⚠ (OpenAI auto-responds)' : '(not set — defaults TRUE) ⚠'}`);
        console.log(`  Instructions set   : ${s.instructions ? 'YES' : 'NO'}`);
        console.log(`─────────────────────────────────────────────────────────\n`);

        // ── Send greeting EXACTLY ONCE after session is confirmed ready ──────
        if (!this.greetingSent) {
          this.greetingSent = true;
          const greetingText = agent.initialGreetingMessage || 'Hello! How can I help you today?';
          const greetingPrompt =
            this.language === 'Urdu'
              ? `براہ کرم سلام کہیں اور کہیں: "${greetingText}"`
              : `Please greet the visitor warmly using this exact message: "${greetingText}"`;

          console.log(`[SESSION LIFECYCLE] GREETING SEND (once only) — "${greetingText}"`);

          if (this.openAiWs && this.openAiWs.readyState === WebSocket.OPEN) {
            this.openAiWs.send(JSON.stringify({
              type: 'conversation.item.create',
              item: {
                type: 'message',
                role: 'user',
                content: [{ type: 'input_text', text: greetingPrompt }],
              },
            }));
            this.openAiWs.send(JSON.stringify({ type: 'response.create' }));
          }

          if (!this.sessionReadySent && this.socket.readyState === WebSocket.OPEN) {
            this.sessionReadySent = true;
            this.socket.send(JSON.stringify({ type: 'session.ready' }));
            console.log(`[SESSION LIFECYCLE] session.ready sent to browser client`);
          }
        } else {
          console.log(`[SESSION LIFECYCLE] session.updated received again — greeting NOT re-sent (guard active)`);
        }
      }

      // ── Turn pipeline trace ───────────────────────────────────────────────
      if (event.type === 'input_audio_buffer.speech_started') {
        console.log(`\n╔══════════════════════════════════════════════════════╗`);
        console.log(`║  VOICE TURN START  @ ${ts()}  ║`);
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
        console.log(`[PIPELINE ${ts()}] ⚡ response.created${isGreeting ? ' [GREETING — expected]' : ' [USER TURN — if before transcription.completed this is a bug]'}`);
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
        const userSpeech = event.transcript.trim();
        if (!userSpeech || !this.tenantConfig) return;

        this.turnStartTime = Date.now();
        const tTranscriptDone = Date.now();

        console.log(`[PIPELINE ${ts()}] ↓ transcription.completed — "${userSpeech.substring(0, 80)}"`);

        // Strictly English and Urdu ONLY.
        const isUrduScript = /[\u0600-\u06FF]/.test(userSpeech);
        const isRomanUrduKeywords = /\b(kya|kaise|kis|hai|hain|kiya|apki|aapki|madad|batao|bataen|bataeyn|chahiye|mein|hoon|hun|sab|sahib|bhai|sirf|aur|yeh|woh|raha|rahi|taraf|zaroorat|takaful|bima|beema|jis|jo|terah|tarah|ko|ke|ki|se)\b/i.test(userSpeech);

        // Binary classification: strictly Urdu or English
        const isUrdu = this.language === 'Urdu' || isUrduScript || isRomanUrduKeywords;
        const detectedLanguage: 'Urdu' | 'English' = isUrdu ? 'Urdu' : 'English';

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
        // If the query names a competitor explicitly, skip pgvector entirely.
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

          if (this.openAiWs && this.openAiWs.readyState === WebSocket.OPEN) {
            console.log(`[PIPELINE ${ts()}] → SENDING response.create() [COMPETITOR GUARD fallback]`);
            this.openAiWs.send(JSON.stringify({
              type: 'response.create',
              response: {
                instructions: `You MUST respond with EXACTLY this text and nothing else, in ${detectedLanguage}: "${fallbackText}"`,
              },
            }));
          }
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

        const tAfterRetrieval = Date.now();
        console.log(`[PIPELINE ${ts()}] ↓ Retrieval DONE — topSimilarity: ${retrieval.topSimilarity.toFixed(3)}, chunks: ${retrieval.chunks.length}, fallback: ${retrieval.fallbackTriggered}`);
        console.log(`[PIPELINE ${ts()}]   Timings: embedding=${retrieval.timings.embeddingMs}ms, pgvector=${retrieval.timings.vectorSearchMs}ms, total=${retrieval.timings.totalMs}ms${retrieval.timings.totalMs > 400 ? ' ⚠ OVER BUDGET' : ' ✅'}`);
        console.log(`[PIPELINE ${ts()}] ↓ Decision: ${retrieval.fallbackTriggered ? 'OUT_OF_SCOPE' : 'RAG'}`);

        // Build audit record
        const turnAudit: VoiceAuditRecord = {
          conversationId: `${this.tenantConfig.tenantId.substring(0, 8)}-${Date.now()}`,
          userTranscript: userSpeech,
          detectedLanguage,
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
          // ── Branch B: RAG — inject only the retrieved context for this turn ─
          // IMPORTANT: We do NOT re-inject the session system prompt here.
          // Only the retrieved context chunk is added as a turn-scoped item.
          const tPrompt0 = Date.now();
          const contextOnly = retrieval.contextText; // raw retrieved chunks only
          const promptAssemblyMs = Date.now() - tPrompt0;

          console.log(`[PIPELINE ${ts()}] → SENDING conversation.item.create [${retrieval.chunks.length} chunks, promptAssembly=${promptAssemblyMs}ms]`);

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
          console.log(`[PIPELINE ${ts()}] → SENDING response.create() [RAG] — total pipeline from transcript: ${totalPipelineMs}ms${totalPipelineMs > 400 ? ' ⚠' : ' ✅'}`);

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
