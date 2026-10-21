/**
 * IntentClassifier.ts
 * Classifies inbound user message intent using TypeSafe Jev model (~typesafe/jev-latest via OpenRouter)
 * with strict timeout and zero-downtime fallback to 'general'.
 */

export type Intent = 'sales' | 'support' | 'complaint' | 'general';

const VALID_INTENTS: ReadonlySet<Intent> = new Set(['sales', 'support', 'complaint', 'general']);

export class IntentClassifier {
  /**
   * Classifies user message into one of: 'sales' | 'support' | 'complaint' | 'general'
   * Reuses the 2000ms AbortController timeout pattern.
   * Fallback: Returns 'general' on any timeout, network error, or missing API key.
   */
  static async classifyIntent(content: string): Promise<Intent> {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey || apiKey.trim() === '' || apiKey.includes('your-openrouter-api-key')) {
      console.warn('[INTENT_CLASSIFIER] classified as: general (fallback)');
      return 'general';
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
              content: `Classify this user message into exactly one category: 'sales' (inquiries, pricing, buying), 'support' (technical help, how-to), 'complaint' (frustration, broken service, escalation), or 'general' (greetings, other). Reply with the category name only.\n\nMessage: "${content}"`,
            },
          ],
        };
      } else {
        // OpenRouter Decisions API schema for choice questions
        requestBody = {
          model: '~typesafe/jev-latest',
          state: content,
          questions: {
            intent: {
              type: 'choice',
              instructions: "Classify this user message into exactly one category: 'sales' (inquiries, pricing, buying), 'support' (technical help, how-to), 'complaint' (frustration, broken service, escalation), or 'general' (greetings, other). Reply with the category name only.",
              criteria: {
                sales: 'Inquiries about pricing, purchasing, service offerings, packages, or hiring.',
                support: 'Technical assistance, how-to questions, setup, configuration, or bug help.',
                complaint: 'Frustration, broken service, anger, escalations, or refund demands.',
                general: 'Greetings, small talk, pleasantries, or general queries.',
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
      let extractedIntent: string | undefined;

      if (data?.answers?.intent?.choice) {
        extractedIntent = String(data.answers.intent.choice).trim().toLowerCase();
      } else if (data?.choices?.[0]?.message?.content) {
        extractedIntent = String(data.choices[0].message.content).trim().toLowerCase();
      }

      // Sanitize match to known Intent values
      let resolvedIntent: Intent = 'general';
      if (extractedIntent) {
        for (const candidate of ['sales', 'complaint', 'support', 'general'] as const) {
          if (extractedIntent.includes(candidate)) {
            resolvedIntent = candidate;
            break;
          }
        }
      }

      console.log(`[INTENT_CLASSIFIER] classified as: ${resolvedIntent} (jev)`);
      return resolvedIntent;
    } catch (err: any) {
      clearTimeout(timeoutId);
      console.warn('[INTENT_CLASSIFIER] classified as: general (fallback)');
      return 'general';
    }
  }
}

export const classifyIntent = IntentClassifier.classifyIntent;
