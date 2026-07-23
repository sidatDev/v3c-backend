import prisma from '../../lib/prisma';
import { randomUUID } from 'crypto';
import { StructuredLogger } from './StructuredLogger';

export interface LogAiRequestParams {
  tenantId: string;
  agentId?: string;
  visitorSessionId?: number;
  mode?: 'chat' | 'voice';
  languageDetected?: string;
  userQuery?: string;
  retrievedChunkCount?: number;
  avgSimilarityScore?: number;
  sourcesUsed?: string[];
  modelUsed?: string;
  voiceUsed?: string;
  promptTokens?: number;
  completionTokens?: number;
  latencyMs?: number;
  fallbackTriggered?: boolean;
  fallbackMode?: string;
  topicLinksShown?: string[];
  errorMessage?: string;
}

export class AiLogService {
  /**
   * Persist AI request telemetry to DB for Observability & Audit
   */
  static async logRequest(params: LogAiRequestParams): Promise<void> {
    try {
      const promptTokens = params.promptTokens || 0;
      const completionTokens = params.completionTokens || 0;
      
      // Approximate pricing per 1K tokens ($0.00015 input, $0.0006 output for gpt-4o-mini)
      const estimatedCost = (promptTokens * 0.00015 + completionTokens * 0.0006) / 1000;

      await prisma.aiLog.create({
        data: {
          id: randomUUID(),
          tenantId: params.tenantId,
          agentId: params.agentId || null,
          visitorSessionId: params.visitorSessionId || null,
          requestId: `req-${randomUUID()}`,
          mode: params.mode || 'chat',
          languageDetected: params.languageDetected || 'en',
          userQuery: params.userQuery || null,
          retrievedChunkCount: params.retrievedChunkCount || 0,
          avgSimilarityScore: params.avgSimilarityScore || null,
          sourcesUsed: params.sourcesUsed || [],
          modelUsed: params.modelUsed || 'gpt-4o-mini',
          voiceUsed: params.voiceUsed || null,
          promptTokens,
          completionTokens,
          latencyMs: params.latencyMs || 0,
          estimatedCost,
          fallbackTriggered: params.fallbackTriggered ?? false,
          fallbackMode: params.fallbackMode || null,
          topicLinksShown: params.topicLinksShown || [],
          confidenceScore: params.avgSimilarityScore || null,
          errorMessage: params.errorMessage || null
        }
      });
    } catch (err: any) {
      StructuredLogger.warn('[AiLogService] Failed to persist AI log to DB', { error: err?.message || err });
    }
  }
}
