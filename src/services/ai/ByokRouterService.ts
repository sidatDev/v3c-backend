/**
 * ByokRouterService.ts
 * Phase 3: Bring Your Own Key (BYOK) Model Router.
 * Dynamically resolves and decrypts tenant-scoped LLM API keys and model preferences
 * from the AES-256-GCM Secret vault, with automatic fallback to platform credentials.
 */

import OpenAI from 'openai';
import prisma from '../../lib/prisma';
import { decrypt } from '../../lib/crypto';
import { openai as platformOpenAi } from '../../utils/openai';

export type ByokKeySource = 'byok_openai' | 'byok_openrouter' | 'platform_default';

export interface TenantByokConfig {
  openaiApiKey?: string;
  openrouterApiKey?: string;
  defaultModel?: string;
  fetchedAt: number;
}

export interface RoutedCompletionClient {
  client: OpenAI;
  model: string;
  keySource: ByokKeySource;
  isByok: boolean;
}

const CACHE_TTL_MS = 60 * 1000; // 60 seconds
const tenantSecretsCache = new Map<string, TenantByokConfig>();

export class ByokRouterService {
  /**
   * Invalidates cached BYOK secrets for a tenant (called when secrets are upserted/deleted).
   */
  static invalidateCache(tenantId?: string): void {
    if (!tenantId) {
      tenantSecretsCache.clear();
      return;
    }
    tenantSecretsCache.delete(tenantId);
  }

  /**
   * Loads and decrypts BYOK secrets (`OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `BYOK_DEFAULT_MODEL`)
   * for a given tenant from the Secret table.
   */
  static async getTenantByokConfig(tenantId?: string): Promise<TenantByokConfig> {
    if (!tenantId) {
      return { fetchedAt: Date.now() };
    }

    const cached = tenantSecretsCache.get(tenantId);
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
      return cached;
    }

    const config: TenantByokConfig = { fetchedAt: Date.now() };

    try {
      const secrets = await prisma.secret.findMany({
        where: {
          tenantId,
          keyName: {
            in: ['OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'BYOK_DEFAULT_MODEL'],
          },
        },
      });

      for (const sec of secrets) {
        try {
          const val = decrypt(sec.encryptedValue, sec.iv, sec.authTag).trim();
          if (!val) continue;

          if (sec.keyName === 'OPENAI_API_KEY') {
            config.openaiApiKey = val;
          } else if (sec.keyName === 'OPENROUTER_API_KEY') {
            config.openrouterApiKey = val;
          } else if (sec.keyName === 'BYOK_DEFAULT_MODEL') {
            config.defaultModel = val;
          }
        } catch (decErr: any) {
          console.warn(
            `[ByokRouterService] Failed to decrypt secret ${sec.keyName} for tenant ${tenantId}:`,
            decErr?.message || decErr
          );
        }
      }
    } catch (err: any) {
      console.warn(`[ByokRouterService] Failed to query secrets for tenant ${tenantId}:`, err?.message || err);
    }

    tenantSecretsCache.set(tenantId, config);
    return config;
  }

  /**
   * Resolves the OpenAI / OpenRouter SDK client and model for a tenant completion request.
   */
  static async resolveCompletionClient(
    tenantId?: string,
    requestedModel?: string
  ): Promise<RoutedCompletionClient> {
    const byok = await this.getTenantByokConfig(tenantId);
    const effectiveModel = byok.defaultModel || requestedModel || 'gpt-4o-mini';

    const isOpenRouterModel = effectiveModel.includes('/');

    // 1. Route via Tenant OpenRouter BYOK if model is an OpenRouter slug (e.g. openai/gpt-4o-mini, anthropic/claude-3.5-sonnet)
    //    or if tenant only configured OPENROUTER_API_KEY
    if (byok.openrouterApiKey && (isOpenRouterModel || !byok.openaiApiKey)) {
      const client = new OpenAI({
        apiKey: byok.openrouterApiKey,
        baseURL: 'https://openrouter.ai/api/v1',
      });
      return {
        client,
        model: effectiveModel,
        keySource: 'byok_openrouter',
        isByok: true,
      };
    }

    // 2. Route via Tenant OpenAI BYOK if OPENAI_API_KEY is present in vault
    if (byok.openaiApiKey) {
      const cleanModel = isOpenRouterModel ? effectiveModel.split('/').pop() || 'gpt-4o-mini' : effectiveModel;
      const client = new OpenAI({
        apiKey: byok.openaiApiKey,
      });
      return {
        client,
        model: cleanModel,
        keySource: 'byok_openai',
        isByok: true,
      };
    }

    // 3. Fallback to Platform Default OpenAI Client
    const fallbackModel = isOpenRouterModel ? effectiveModel.split('/').pop() || 'gpt-4o-mini' : effectiveModel;
    return {
      client: platformOpenAi,
      model: fallbackModel,
      keySource: 'platform_default',
      isByok: false,
    };
  }

  /**
   * Resolves the OpenRouter API key for OrchestratorService (Jev / RAG confidence checks).
   */
  static async getOpenRouterKey(tenantId?: string): Promise<{ apiKey: string | undefined; isByok: boolean }> {
    if (tenantId) {
      const byok = await this.getTenantByokConfig(tenantId);
      if (byok.openrouterApiKey) {
        return { apiKey: byok.openrouterApiKey, isByok: true };
      }
    }
    return { apiKey: process.env.OPENROUTER_API_KEY, isByok: false };
  }
}

export default ByokRouterService;
