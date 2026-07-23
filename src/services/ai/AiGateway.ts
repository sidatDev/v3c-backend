import { openai } from '../../utils/openai';
import { StructuredLogger } from '../logger/StructuredLogger';

export interface CompletionRequest {
  model?: string;
  messages: { role: 'system' | 'user' | 'assistant'; content: string }[];
  temperature?: number;
  maxTokens?: number;
  tenantId?: string;
  sessionId?: string | number;
  mode?: 'chat' | 'voice';
}

export interface CompletionResponse {
  reply: string;
  promptTokens: number;
  completionTokens: number;
  model: string;
}

export class AiGateway {
  /**
   * Execute chat completion with automatic retries and token logging
   */
  static async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const startTime = Date.now();
    const model = request.model || 'gpt-4o-mini';
    const temperature = request.temperature ?? 0.5;
    const maxTokens = request.maxTokens ?? 500;

    let retries = 0;
    const maxRetries = 2;

    while (retries <= maxRetries) {
      try {
        const response = await openai.chat.completions.create({
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
          model
        });

        return {
          reply,
          promptTokens,
          completionTokens,
          model
        };
      } catch (err: any) {
        retries++;
        StructuredLogger.warn(`[AiGateway] Completion attempt ${retries} failed`, {
          error: err?.message || err,
          retries
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
            model
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
      model
    };
  }
}
