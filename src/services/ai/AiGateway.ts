import { openai } from '../../utils/openai';
import { StructuredLogger } from '../logger/StructuredLogger';
import { AiLogService } from '../logger/AiLogService';
import { MeteringService } from '../billing/MeteringService';
import { XPayService } from '../billing/XPayService';
import { ByokRouterService, ByokKeySource } from './ByokRouterService';

export interface CompletionRequest {
  model?: string;
  messages: { role: 'system' | 'user' | 'assistant'; content: string }[];
  temperature?: number;
  maxTokens?: number;
  tenantId?: string;
  agentId?: string;
  sessionId?: string | number;
  mode?: 'chat' | 'voice';
}

export interface CompletionResponse {
  reply: string;
  promptTokens: number;
  completionTokens: number;
  model: string;
  keySource?: ByokKeySource;
}

export class AiGateway {
  /**
   * Execute chat completion with BYOK dynamic key routing, automatic retries, and token logging
   */
  static async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const startTime = Date.now();
    const temperature = request.temperature ?? 0.5;
    const maxTokens = request.maxTokens ?? 500;

    // Phase 5 Hard Stop Enforcement: block LLM call if tenant token balance is 100% depleted
    if (request.tenantId) {
      const depleted = await XPayService.isQuotaDepleted(request.tenantId);
      if (depleted) {
        console.warn(`[AiGateway] Hard-stop enforced: Token balance depleted for tenant ${request.tenantId}`);
        return {
          reply: 'Our AI assistant is temporarily paused because this workspace has reached 100% of its monthly token quota. Please top up a token bundle in the Billing Dashboard or leave your contact details for a human representative.',
          promptTokens: 0,
          completionTokens: 0,
          model: request.model || 'gpt-4o-mini',
          keySource: 'platform_default'
        };
      }
    }

    // Phase 3 BYOK Model Router: dynamically resolve client & model from tenant Secret vault
    let routed = await ByokRouterService.resolveCompletionClient(request.tenantId, request.model);
    let activeClient = routed.client;
    let model = routed.model;
    let keySource: ByokKeySource = routed.keySource;

    let retries = 0;
    const maxRetries = 2;

    while (retries <= maxRetries) {
      try {
        const response = await activeClient.chat.completions.create({
          model,
          messages: request.messages,
          temperature,
          max_tokens: maxTokens
        });

        const reply = response.choices[0]?.message?.content || 'I am sorry, I could not generate a response right now.';
        const promptTokens = response.usage?.prompt_tokens || 0;
        const completionTokens = response.usage?.completion_tokens || 0;
        const latencyMs = Date.now() - startTime;

        StructuredLogger.info('[AiGateway] Completion successful', {
          tenantId: request.tenantId,
          sessionId: request.sessionId,
          mode: request.mode || 'chat',
          promptTokens,
          completionTokens,
          latencyMs,
          model,
          keySource
        });

        if (request.tenantId) {
          const userMessage = request.messages.find(m => m.role === 'user')?.content;
          AiLogService.logRequest({
            tenantId: request.tenantId,
            agentId: request.agentId,
            visitorSessionId: request.sessionId ? Number(request.sessionId) : undefined,
            mode: request.mode || 'chat',
            userQuery: userMessage,
            modelUsed: model,
            promptTokens,
            completionTokens,
            latencyMs
          });

          try {
            await MeteringService.recordUsage(
              request.tenantId,
              request.agentId || null,
              model,
              promptTokens,
              completionTokens
            );
          } catch (meterErr: any) {
            console.warn('[AiGateway] Metering record error:', meterErr?.message || meterErr);
          }
        }

        return {
          reply,
          promptTokens,
          completionTokens,
          model,
          keySource
        };
      } catch (err: any) {
        // If tenant BYOK key is invalid/unauthorized, automatically fall back to platform OpenAI key
        if (keySource !== 'platform_default' && (err?.status === 401 || String(err?.message || '').includes('401') || String(err?.message || '').includes('Incorrect API key'))) {
          console.warn(`[AiGateway] Tenant BYOK key (${keySource}) failed with 401 for tenant ${request.tenantId}; falling back to platform_default.`);
          activeClient = openai;
          model = model.includes('/') ? model.split('/').pop() || 'gpt-4o-mini' : model;
          keySource = 'platform_default';
        }

        retries++;
        StructuredLogger.warn(`[AiGateway] Completion attempt ${retries} failed`, {
          error: err?.message || err,
          retries,
          keySource
        });

        if (retries > maxRetries) {
          StructuredLogger.error('[AiGateway] All completion retries exhausted', {
            tenantId: request.tenantId,
            sessionId: request.sessionId,
            error: err?.message || err
          });

          return {
            reply: 'I am currently experiencing technical difficulties. Please try again or leave your contact details for our support team.',
            promptTokens: 0,
            completionTokens: 0,
            model,
            keySource
          };
        }

        // Exponential backoff delay
        await new Promise(res => setTimeout(res, retries * 500));
      }
    }

    return {
      reply: 'An unexpected error occurred.',
      promptTokens: 0,
      completionTokens: 0,
      model,
      keySource
    };
  }
}
