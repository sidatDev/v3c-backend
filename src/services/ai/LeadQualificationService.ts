import prisma from '../../lib/prisma';
import { openai } from '../../utils/openai';

export interface QualificationResult {
  evaluated: boolean;
  confidenceScore?: number;
  isQualified?: boolean;
  summary?: string;
  reasoning?: string;
  keyIntents?: string[];
  reason?: string;
}

export class LeadQualificationService {
  /**
   * Evaluates a completed visitor session transcript to score and qualify leads
   */
  static async evaluateSession(visitorSessionId: number, tenantId?: string, interestedClientId?: number): Promise<QualificationResult> {
    try {
      if (!visitorSessionId) {
        console.warn('[LeadQualification] Aborted evaluation: missing visitorSessionId');
        return { evaluated: false, reason: 'missing_session_id' };
      }

      console.log(`[LeadQualification] Starting evaluation trigger for session #${visitorSessionId} (tenantId: ${tenantId || 'auto'}, interestedClientId: ${interestedClientId || 'auto'})...`);

      // 1. Brief delay to allow any in-flight message DB inserts to complete
      await new Promise(resolve => setTimeout(resolve, 800));

      // 2. Locate InterestedClient for this session
      let interestedClient: any = null;
      if (interestedClientId) {
        interestedClient = await prisma.interestedClient.findUnique({
          where: { id: interestedClientId },
          include: { Tenant: true }
        });
        if (interestedClient && !interestedClient.visitorSessionId) {
          await prisma.interestedClient.update({
            where: { id: interestedClient.id },
            data: { visitorSessionId }
          });
          console.log(`[LeadQualification] Linked provided InterestedClient #${interestedClient.id} to session #${visitorSessionId}`);
        }
      }

      if (!interestedClient) {
        interestedClient = await prisma.interestedClient.findFirst({
          where: { visitorSessionId },
          orderBy: { createdAt: 'desc' },
          include: { Tenant: true }
        });
      }

      // Fallback: If not linked to visitorSessionId, check recent unlinked submission in same tenant
      if (!interestedClient && tenantId) {
        interestedClient = await prisma.interestedClient.findFirst({
          where: {
            tenantId,
            createdAt: { gte: new Date(Date.now() - 30 * 60 * 1000) }
          },
          orderBy: { createdAt: 'desc' },
          include: { Tenant: true }
        });

        if (interestedClient) {
          await prisma.interestedClient.update({
            where: { id: interestedClient.id },
            data: { visitorSessionId }
          });
          console.log(`[LeadQualification] Successfully linked recent InterestedClient #${interestedClient.id} to session #${visitorSessionId}`);
        }
      }

      if (!interestedClient) {
        console.warn(`[LeadQualification] No InterestedClient found for session #${visitorSessionId} — skipping scoring`);
        return { evaluated: false, reason: 'no_interested_client_found' };
      }

      const activeTenantId = tenantId || interestedClient.tenantId;
      const tenantName = interestedClient.Tenant?.name || 'V3C';

      // 3. Fetch conversation transcript
      const messages = await prisma.conversation.findMany({
        where: {
          OR: [
            { visitorSessionId },
            { interestedClientId: interestedClient.id }
          ]
        },
        orderBy: { createdAt: 'asc' }
      });

      // Tie any untied messages to interestedClientId
      await prisma.conversation.updateMany({
        where: { visitorSessionId, interestedClientId: null },
        data: { interestedClientId: interestedClient.id }
      });

      if (messages.length === 0 && !interestedClient.message) {
        console.log(`[LeadQualification] Session #${visitorSessionId} has neither chat messages nor initial inquiry message — cannot qualify`);
        return { evaluated: false, reason: 'insufficient_content' };
      }

      const transcript = messages.length > 0
        ? messages.map(m => `${m.sender.toUpperCase()}: ${m.message}`).join('\n')
        : '(No conversational dialogue exchanged)';

      console.log(`[LeadQualification] Analyzing client #${interestedClient.id} (${interestedClient.name}) with ${messages.length} message(s)...`);

      // 4. Call OpenAI LLM for evaluation
      const response = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        temperature: 0.2,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content: `You are an expert sales lead qualification analyst for ${tenantName}.
Analyze the inquiry details and conversation transcript between the visitor and the AI assistant.
Evaluate whether this visitor has genuine commercial intent and should be qualified as a prospective client.

Return a JSON object with:
- "confidence_score": integer from 0 to 100 (where 0 is casual/spam/accidental, 50 is reasonable buying interest, 100 is ready buyer with immediate requirements).
- "is_qualified": boolean (true if confidence_score >= 50, otherwise false).
- "summary": 2-3 sentence executive summary of the client's needs, asked products/services, and urgency.
- "reasoning": 1-2 sentence explanation of why this confidence score was assigned.
- "key_intents": array of 1-4 short string tags summarizing core needs (e.g. ["quote_request", "policy_renewal", "pricing_inquiry"]).`
          },
          {
            role: 'user',
            content: `Client Information:
Name: ${interestedClient.name}
Email: ${interestedClient.email || 'N/A'}
Phone: ${interestedClient.phone || 'N/A'}
Initial Inquiry: ${interestedClient.message || 'None provided'}

Conversation Transcript:
${transcript}`
          }
        ]
      });

      const raw = response.choices[0]?.message?.content || '{}';
      const parsed = JSON.parse(raw);

      const confidenceScore = Math.min(100, Math.max(0, Math.round(Number(parsed.confidence_score) || 0)));
      const isQualified = confidenceScore >= 50;
      const summary = parsed.summary || 'Lead analyzed from conversation session.';
      const reasoning = parsed.reasoning || null;
      const keyIntents = Array.isArray(parsed.key_intents) ? parsed.key_intents.map(String) : [];

      console.log(`[LeadQualification] Evaluation completed for client #${interestedClient.id} (${interestedClient.name}): Score=${confidenceScore}/100, Qualified=${isQualified}`);

      // 5. If confidence_score >= 50, persist to PotentialClient
      if (isQualified && activeTenantId) {
        const potential = await prisma.potentialClient.upsert({
          where: { interestedClientId: interestedClient.id },
          create: {
            interestedClientId: interestedClient.id,
            confidenceScore,
            summary,
            reasoning,
            keyIntents,
            tenantId: activeTenantId,
            evaluatedAt: new Date()
          },
          update: {
            confidenceScore,
            summary,
            reasoning,
            keyIntents,
            tenantId: activeTenantId,
            evaluatedAt: new Date()
          }
        });
        console.log(`[LeadQualification] Upserted PotentialClient #${potential.id} for InterestedClient #${interestedClient.id}`);
      }

      return {
        evaluated: true,
        confidenceScore,
        isQualified,
        summary,
        reasoning,
        keyIntents
      };
    } catch (err: any) {
      console.error(`[LeadQualification] Failed to evaluate session #${visitorSessionId}:`, err?.message || err);
      return { evaluated: false, reason: err?.message || 'evaluation_error' };
    }
  }
}
