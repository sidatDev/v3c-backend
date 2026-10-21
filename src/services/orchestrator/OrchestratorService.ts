/**
 * OrchestratorService.ts
 * Central decision engine for routing, classifying, and approving/rejecting inbound messages.
 * Step 3: TypeSafe Jev model (~typesafe/jev-latest via OpenRouter) with strict timeout & keyword fallback.
 */

import { V3CMessage } from '../gateway/ChannelGateway';
import { ScopeGuard } from './ScopeGuard';
import { IntentClassifier, Intent } from './IntentClassifier';
import { EscalationService } from '../escalation/EscalationService';
import { MeteringService } from '../billing/MeteringService';
import { ByokRouterService } from '../ai/ByokRouterService';
import prisma from '../../lib/prisma';

export interface DecisionResult {
  approved: boolean;
  reason: string;
}

export interface JevCheckResult {
  isBusiness: boolean;
  source: 'jev' | 'fallback';
}

/**
 * Classifies message intent via TypeSafe Jev model on OpenRouter.
 * Implements a strict 2000ms AbortController timeout with automatic fallback
 * to ScopeGuard.isBusinessRelated(content) upon any error, timeout, or missing key.
 */
export async function checkWithJev(content: string, tenantId?: string): Promise<JevCheckResult> {
  const { apiKey } = await ByokRouterService.getOpenRouterKey(tenantId);
  if (!apiKey || apiKey.trim() === '' || apiKey.includes('your-openrouter-api-key')) {
    console.warn('[ORCHESTRATOR] jev_failed_fallback: OPENROUTER_API_KEY is not configured');
    return {
      isBusiness: ScopeGuard.isBusinessRelated(content),
      source: 'fallback',
    };
  }

  const endpoint = process.env.OPENROUTER_DECISIONS_URL || 'https://openrouter.ai/api/alpha/decisions';
  const controller = new AbortController();
  const timeoutMs = 2000;
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    let requestBody: any;
    if (endpoint.includes('chat/completions')) {
      requestBody = {
        model: '~typesafe/jev-latest',
        messages: [
          {
            role: 'user',
            content: `Is the following message related to business, services, software, IT, or corporate inquiries vs general/unrelated topics (sports, cricket, weather, movies, politics)? Message: "${content}". Respond ONLY with "true" if business/in-scope or "false" if out-of-scope.`,
          },
        ],
      };
    } else {
      // OpenRouter Decisions API schema for ~typesafe/jev-latest
      requestBody = {
        model: '~typesafe/jev-latest',
        state: content,
        questions: {
          is_business: {
            type: 'noul',
            instructions: 'Is the user message related to business, software, website, digital marketing, AI, or corporate services inquiry?',
            criteria: {
              true: 'The user is inquiring about services, pricing, company info, software, technology, or business help.',
              false: 'The user is talking about sports, cricket, weather, movies, politics, recipes, or general irrelevant chatter.',
            },
          },
        },
      };
    }

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`OpenRouter returned HTTP ${response.status} ${response.statusText}`);
    }

    const data: any = await response.json();

    let isAffirmative = false;
    if (data?.answers?.is_business?.noul !== undefined) {
      // noul probability threshold: >= 0.5 indicates business-related
      isAffirmative = data.answers.is_business.noul >= 0.5;
    } else if (data?.choices?.[0]?.message?.content) {
      const text = String(data.choices[0].message.content).trim().toLowerCase();
      isAffirmative = text.includes('true') || text.includes('yes');
    } else {
      throw new Error('Unrecognized response format from Jev API');
    }

    if (tenantId) {
      const promptTokens = data?.usage?.prompt_tokens ?? 100;
      const completionTokens = data?.usage?.completion_tokens ?? 10;
      await MeteringService.recordUsage(tenantId, null, 'jev-latest', promptTokens, completionTokens);
    }

    return {
      isBusiness: isAffirmative,
      source: 'jev',
    };
  } catch (err: any) {
    clearTimeout(timeoutId);
    console.warn('[ORCHESTRATOR] jev_failed_fallback:', err?.name === 'AbortError' ? 'timeout after 2000ms' : err?.message || err);
    return {
      isBusiness: ScopeGuard.isBusinessRelated(content),
      source: 'fallback',
    };
  }
}

/**
 * Decides whether an incoming channel message is approved for AI processing
 * or rejected with an immediate refusal response.
 */
export async function decide(msg: V3CMessage): Promise<DecisionResult> {
  const result = await checkWithJev(msg.content, msg.tenantId);
  const tag = result.source === 'jev' ? '(jev)' : '(keyword fallback)';
  const reason = result.isBusiness
    ? result.source === 'jev'
      ? 'jev_approved'
      : 'business_related'
    : result.source === 'jev'
    ? 'jev_rejected'
    : 'out_of_scope_keyword';

  if (result.isBusiness) {
    console.log(`[ORCHESTRATOR] approve ${tag} messageId: ${msg.messageId} reason: ${reason}`);
    return {
      approved: true,
      reason,
    };
  }

  console.log(`[ORCHESTRATOR] reject ${tag} messageId: ${msg.messageId} reason: ${reason}`);
  return {
    approved: false,
    reason,
  };
}

/**
 * Validates whether the top retrieved RAG context chunk directly answers the user's query.
 * Calls OpenRouter ~typesafe/jev-latest with 2000ms timeout.
 * Fallback: On error or timeout, defaults to true (trusting similarity threshold to avoid over-blocking).
 */
export async function validateRagConfidence(
  query: string,
  topChunkText: string,
  tenantId?: string,
  agentId?: string | null
): Promise<boolean> {
  const { apiKey } = await ByokRouterService.getOpenRouterKey(tenantId);
  if (!apiKey || apiKey.trim() === '' || apiKey.includes('your-openrouter-api-key')) {
    console.warn('[ORCHESTRATOR] rag_confidence_failed_fallback: OPENROUTER_API_KEY is not configured');
    return true;
  }

  const endpoint = process.env.OPENROUTER_DECISIONS_URL || 'https://openrouter.ai/api/alpha/decisions';
  const controller = new AbortController();
  const timeoutMs = 2000;
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    let requestBody: any;
    if (endpoint.includes('chat/completions')) {
      requestBody = {
        model: '~typesafe/jev-latest',
        messages: [
          {
            role: 'user',
            content: `Does the provided text contain direct, relevant information to answer the user's query? Reply boolean.\nQuery: "${query}"\nContext: "${topChunkText}"`,
          },
        ],
      };
    } else {
      requestBody = {
        model: '~typesafe/jev-latest',
        state: {
          user_query: query,
          retrieved_context: topChunkText,
        },
        questions: {
          is_relevant: {
            type: 'noul',
            instructions: "Does the provided text contain direct, relevant information to answer the user's query? Reply boolean.",
            criteria: {
              true: "The provided text directly contains factual information to answer the user's query.",
              false: "The provided text does not contain relevant information, is unrelated, or only shares incidental keywords.",
            },
          },
        },
      };
    }

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`OpenRouter returned HTTP ${response.status} ${response.statusText}`);
    }

    const data: any = await response.json();

    let isConfident = false;
    if (data?.answers?.is_relevant?.noul !== undefined) {
      isConfident = data.answers.is_relevant.noul >= 0.5;
    } else if (data?.choices?.[0]?.message?.content) {
      const text = String(data.choices[0].message.content).trim().toLowerCase();
      isConfident = text.includes('true') || text.includes('yes');
    } else {
      throw new Error('Unrecognized response format from Jev API for RAG confidence');
    }

    if (isConfident) {
      console.log('[ORCHESTRATOR] rag_confidence approve (jev)');
    } else {
      console.log('[ORCHESTRATOR] rag_confidence reject (jev)');
    }

    if (tenantId) {
      const promptTokens = data?.usage?.prompt_tokens ?? 100;
      const completionTokens = data?.usage?.completion_tokens ?? 10;
      await MeteringService.recordUsage(tenantId, agentId || null, 'jev-latest', promptTokens, completionTokens);
    }

    return isConfident;
  } catch (err: any) {
    clearTimeout(timeoutId);
    console.warn('[ORCHESTRATOR] rag_confidence_failed_fallback:', err?.name === 'AbortError' ? 'timeout after 2000ms' : err?.message || err);
    // Trust existing RetrievalService similarity threshold on failure/timeout
    return true;
  }
}
/**
 * Routes a message to the appropriate specialist or primary agent for a tenant.
 * Classifies intent via IntentClassifier, then queries Prisma for an active agent matching:
 * 1. tenantId === tenantId AND type === intent AND isActive === true
 * Fallbacks:
 * 2. tenantId === tenantId AND isDefault === true AND isActive === true
 * 3. tenantId === tenantId AND type === 'primary' AND isActive === true
 * 4. tenantId === tenantId AND isActive === true (first active agent)
 * 5. Global active agent fallback
 */
export async function routeMessage(
  tenantId: string,
  content: string,
  sessionId?: string,
  visitorId?: string | null
): Promise<{ agentId: string; intent: Intent }> {
  const intent = await IntentClassifier.classifyIntent(content);

  // Phase 3: Auto-create escalation ticket on complaint intent or explicit human/agent request
  const isHumanRequest = /\b(human|agent|representative|talk to a person|live agent|insan|banda|numainda|baat karwao)\b/i.test(content);
  if ((intent === 'complaint' || isHumanRequest) && tenantId) {
    const reason = isHumanRequest ? 'human_request' : 'complaint';
    setImmediate(async () => {
      try {
        await EscalationService.createEscalation(
          tenantId,
          sessionId || 'session-pending',
          visitorId || null,
          reason
        );
        console.log(`[ESCALATION] Auto-created ticket for ${reason} intent`);
      } catch (escErr: any) {
        console.warn(`[ESCALATION] Failed to auto-create ticket for ${reason}:`, escErr?.message || escErr);
      }
    });
  }

  let foundAgent = null;

  if (tenantId) {
    // 1. Specific specialist agent by intent
    foundAgent = await prisma.agent.findFirst({
      where: {
        tenantId,
        type: intent,
        isActive: true,
      },
      orderBy: { updatedAt: 'desc' },
    });

    // 2. Fallback to default agent
    if (!foundAgent) {
      foundAgent = await prisma.agent.findFirst({
        where: {
          tenantId,
          isDefault: true,
          isActive: true,
        },
        orderBy: { updatedAt: 'desc' },
      });
    }

    // 3. Fallback to primary agent
    if (!foundAgent) {
      foundAgent = await prisma.agent.findFirst({
        where: {
          tenantId,
          type: 'primary',
          isActive: true,
        },
        orderBy: { updatedAt: 'desc' },
      });
    }

    // 4. Fallback to any active agent for the tenant
    if (!foundAgent) {
      foundAgent = await prisma.agent.findFirst({
        where: {
          tenantId,
          isActive: true,
        },
        orderBy: { updatedAt: 'desc' },
      });
    }
  }

  // 5. Global fallback if tenant has no agent or tenantId not resolved
  if (!foundAgent) {
    foundAgent = await prisma.agent.findFirst({
      where: {
        isDefault: true,
        isActive: true,
      },
      orderBy: { updatedAt: 'desc' },
    }) || await prisma.agent.findFirst({
      where: { isActive: true },
      orderBy: { updatedAt: 'desc' },
    });
  }

  if (!foundAgent) {
    throw new Error(`[ORCHESTRATOR] No active agent found for tenant ${tenantId}`);
  }

  console.log(`[ORCHESTRATOR] routed to agent: ${foundAgent.id} (intent: ${intent})`);
  return {
    agentId: foundAgent.id,
    intent,
  };
}

export const OrchestratorService = {
  checkWithJev,
  decide,
  validateRagConfidence,
  routeMessage,
};

export default OrchestratorService;

