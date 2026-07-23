import WebSocket from 'ws';
import { TenantConfigCache, TenantConfig } from '../cache/TenantConfigCache';
import { PromptService } from './PromptService';
import { RetrievalService } from './RetrievalService';
import { KnowledgeTools, KNOWLEDGE_TOOLS } from '../tools/KnowledgeTools';
import { ConversationService } from './ConversationService';
import { StructuredLogger } from '../logger/StructuredLogger';

export interface VoiceSessionParams {
  socket: WebSocket;
  sessionId?: string;
  agentId?: string;
  publicKey?: string;
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

  private currentTranscript: string = '';
  private aiTranscriptBuffer: string = '';

  private agentId?: string;
  private publicKey?: string;

  constructor(params: VoiceSessionParams) {
    this.socket = params.socket;
    this.sessionIdNum = params.sessionId ? parseInt(params.sessionId, 10) : null;
    this.agentId = params.agentId;
    this.publicKey = params.publicKey;
    this.language = params.language === 'ur' ? 'Urdu' : 'English';
  }

  async start(): Promise<void> {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      this.socket.send(JSON.stringify({ type: 'error', message: 'OpenAI API Key not configured' }));
      this.socket.close();
      return;
    }

    // 1. Resolve Tenant Configuration
    try {
      this.tenantConfig = await TenantConfigCache.getTenantConfig(this.publicKey, this.agentId);
    } catch (err: any) {
      StructuredLogger.error('[RealtimeSessionManager] Failed to resolve tenant config', { error: err?.message });
      this.socket.send(JSON.stringify({ type: 'error', message: 'Tenant configuration failure' }));
      this.socket.close();
      return;
    }

    const { tenantId, agent } = this.tenantConfig;

    // 2. Load DB Session & Lead if sessionId provided
    if (this.sessionIdNum) {
      const sessionCtx = await ConversationService.getSessionContext(this.sessionIdNum, tenantId);
      this.dbSession = sessionCtx.dbSession;
      this.leadId = sessionCtx.leadId;
    }

    // 3. Construct Lean Base Instructions (System + Persona + Guardrails; NO static giant KB)
    const baseInstructions = PromptService.buildSystemPrompt({
      tenantConfig: this.tenantConfig,
      language: this.language
    });

    const selectedVoice = (agent.voice || 'alloy').toLowerCase();
    const openAiUrl = 'wss://api.openai.com/v1/realtime?model=gpt-realtime-mini';

    this.openAiWs = new WebSocket(openAiUrl, {
      headers: {
        Authorization: `Bearer ${apiKey}`
      }
    });

    this.openAiWs.on('open', () => {
      StructuredLogger.info('[RealtimeSessionManager] Connected to OpenAI Realtime GA API', {
        tenantId,
        voice: selectedVoice,
        agentName: agent.name
      });

      // Send GA Session Update with lean prompt & tools
      const sessionConfig = {
        type: 'session.update',
        session: {
          type: 'realtime',
          voice: selectedVoice,
          instructions: `${baseInstructions}\nLanguage Instruction: You MUST respond ONLY in ${this.language}. Do not switch languages.`,
          input_audio_format: 'pcm16',
          output_audio_format: 'pcm16',
          tools: KNOWLEDGE_TOOLS,
          tool_choice: 'auto',
          turn_detection: {
            type: 'server_vad',
            threshold: 0.5,
            prefix_padding_ms: 300,
            silence_duration_ms: 500
          }
        }
      };

      this.openAiWs?.send(JSON.stringify(sessionConfig));

      // Trigger initial server-side greeting after short delay
      setTimeout(() => {
        if (this.openAiWs && this.openAiWs.readyState === WebSocket.OPEN) {
          const greetingText = agent.initialGreetingMessage || 'Hello! How can I help you today?';
          const greetingPrompt = this.language === 'Urdu'
            ? `براہ کرم سلام کہیں اور کہیں: "${greetingText}"`
            : `Please greet the visitor warmly using this exact message: "${greetingText}"`;

          this.openAiWs.send(JSON.stringify({
            type: 'conversation.item.create',
            item: {
              type: 'message',
              role: 'user',
              content: [{ type: 'input_text', text: greetingPrompt }]
            }
          }));

          this.openAiWs.send(JSON.stringify({ type: 'response.create' }));

          if (this.socket.readyState === WebSocket.OPEN) {
            this.socket.send(JSON.stringify({ type: 'session.ready' }));
          }
        }
      }, 600);
    });

    // 4. Handle incoming messages from Browser Client
    this.socket.on('message', (message: WebSocket.RawData) => {
      if (this.openAiWs && this.openAiWs.readyState === WebSocket.OPEN) {
        this.openAiWs.send(message.toString());
      }
    });

    // 5. Handle messages from OpenAI Realtime WS & Orchestrate Per-Turn Retrieval
    this.openAiWs.on('message', async (data: WebSocket.RawData) => {
      const msgStr = data.toString();

      // Passthrough message to Browser client
      if (this.socket.readyState === WebSocket.OPEN) {
        this.socket.send(msgStr);
      }

      try {
        const event = JSON.parse(msgStr);

        // Accumulate AI speech transcript for conversation logging
        if (event.type === 'response.output_audio_transcript.delta' && event.delta) {
          this.aiTranscriptBuffer += event.delta;
        }

        // When AI output finished, save conversation message to DB
        if (event.type === 'response.done' && this.aiTranscriptBuffer.trim()) {
          if (this.tenantConfig && this.sessionIdNum && this.leadId) {
            await ConversationService.saveMessage({
              tenantId: this.tenantConfig.tenantId,
              agentId: this.tenantConfig.agent.id,
              sessionId: this.sessionIdNum,
              visitorId: this.dbSession?.visitorId,
              leadId: this.leadId,
              sender: 'ai',
              message: this.aiTranscriptBuffer.trim()
            });
          }
          this.aiTranscriptBuffer = '';
        }

        // PER-TURN RETRIEVAL via User Speech Transcription Event
        if (event.type === 'conversation.item.input_audio_transcription.completed' && event.transcript) {
          const userSpeech = event.transcript.trim();
          if (userSpeech && this.tenantConfig) {
            StructuredLogger.info('[RealtimeSessionManager] User speech transcribed', { transcript: userSpeech });

            // Save visitor speech transcript to DB
            if (this.sessionIdNum && this.leadId) {
              await ConversationService.saveMessage({
                tenantId: this.tenantConfig.tenantId,
                agentId: this.tenantConfig.agent.id,
                sessionId: this.sessionIdNum,
                visitorId: this.dbSession?.visitorId,
                leadId: this.leadId,
                sender: 'visitor',
                message: userSpeech
              });
            }

            // Perform Backend-Orchestrated Retrieval for the user query
            const retrieval = await RetrievalService.search(this.tenantConfig.tenantId, userSpeech, 5, 0.1);

            if (retrieval.contextText && this.openAiWs && this.openAiWs.readyState === WebSocket.OPEN) {
              // Inject retrieved ground truth context item for this turn
              this.openAiWs.send(JSON.stringify({
                type: 'conversation.item.create',
                item: {
                  type: 'message',
                  role: 'user',
                  content: [{
                    type: 'input_text',
                    text: `[SYSTEM GROUND TRUTH CONTEXT FOR CURRENT TURN]\n${retrieval.contextText}`
                  }]
                }
              }));
            }
          }
        }

        // TOOL CALLING HANDLING (If OpenAI requests searchKnowledge tool)
        if (event.type === 'response.function_call_arguments.done') {
          const callId = event.call_id;
          const toolName = event.name;
          const args = JSON.parse(event.arguments || '{}');

          if (this.tenantConfig && toolName === 'searchKnowledge') {
            const toolResult = await KnowledgeTools.executeTool(toolName, args, this.tenantConfig.tenantId);

            if (this.openAiWs && this.openAiWs.readyState === WebSocket.OPEN) {
              // Send tool response to OpenAI
              this.openAiWs.send(JSON.stringify({
                type: 'conversation.item.create',
                item: {
                  type: 'function_call_output',
                  call_id: callId,
                  output: toolResult.resultText
                }
              }));

              // Request completion response using tool output
              this.openAiWs.send(JSON.stringify({ type: 'response.create' }));
            }
          }
        }
      } catch (e) {
        // Ignore non-JSON or parsing error
      }
    });

    // Cleanup & Closure
    this.socket.on('close', () => {
      if (this.openAiWs && this.openAiWs.readyState === WebSocket.OPEN) {
        this.openAiWs.close();
      }
    });

    this.openAiWs.on('close', () => {
      if (this.socket.readyState === WebSocket.OPEN) {
        this.socket.close();
      }
    });

    this.openAiWs.on('error', (err: any) => {
      StructuredLogger.error('[RealtimeSessionManager] OpenAI WS Error', { error: err?.message || err });
      if (this.socket.readyState === WebSocket.OPEN) {
        this.socket.send(JSON.stringify({ type: 'error', message: 'Voice session error' }));
      }
    });

    this.socket.on('error', (err: any) => {
      StructuredLogger.error('[RealtimeSessionManager] Client WS Error', { error: err?.message || err });
    });
  }
}
