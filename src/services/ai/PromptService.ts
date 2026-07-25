import { TenantConfig } from '../cache/TenantConfigCache';

export interface PromptBuildParams {
  tenantConfig: TenantConfig;
  retrievedContext?: string;
  summary?: string;
  recentMessages?: { sender: 'visitor' | 'ai' | 'user' | 'assistant'; message: string }[];
  currentMessage?: string;
  language?: string;
  isVoice?: boolean;
}

export class PromptService {
  /**
   * Constructs the unified system prompt & messages array for AI completion/orchestration
   */
  static buildSystemPrompt(params: PromptBuildParams): string {
    const { tenantConfig, retrievedContext, summary, language = 'en', isVoice = false } = params;
    const { agent, personaPrompt, guardrailsPrompt } = tenantConfig;

    const femaleVoices = ['shimmer', 'coral', 'sage', 'verse', 'marin'];
    const selectedVoiceLower = (agent.voice || 'shimmer').toLowerCase();
    const isFemaleVoice = femaleVoices.includes(selectedVoiceLower);

    let langInstruction = '';
    if (agent.autoLanguageDetection) {
      langInstruction = `CRITICAL DOMINANT LANGUAGE MATCHING RULE:
1. Detect the DOMINANT language of the user's utterance by overall word count, NOT by a single word or suffix.
2. If the utterance is primarily English (even if it ends with words like "yaar" or "ji"), respond strictly in English.
3. If the utterance is primarily Urdu or Roman Urdu, respond in proper Urdu script/Roman Urdu.
4. NEVER switch language mid-response or flip languages for single-word borrowings.
5. STRICTLY NO HINDI (Devanagari script/vocabulary). You exclusively serve Pakistani customers in Urdu and English.`;
    } else if (language === 'ur' || language === 'Urdu') {
      langInstruction = 'CRITICAL: You MUST respond ONLY in Urdu (اردو). Use proper Urdu vocabulary and script. STRICTLY NO HINDI (Devanagari).';
    } else {
      langInstruction = 'CRITICAL: You MUST respond ONLY in English.';
    }

    const genderInstruction = isFemaleVoice
      ? 'CRITICAL GENDER GRAMMAR RULE (URDU/HINDI): You are a FEMALE virtual assistant. When communicating in Urdu or Roman Urdu, ALWAYS use female first-person grammatical verbs and agreement (e.g. use "samajhtee hoon", "samajhti hoon", "saktee hoon", "karr saktee hoon", "rahee hoon", "karti hoon"). NEVER use male grammatical gender endings like "samajhta hoon", "sakta hoon", "karta hoon", or "raha hoon".'
      : 'CRITICAL GENDER GRAMMAR RULE (URDU/HINDI): You are a MALE virtual assistant. When communicating in Urdu or Roman Urdu, use male first-person grammatical verbs and agreement (e.g. use "samajhta hoon", "sakta hoon", "karta hoon", "raha hoon").';

    // Helper to truncate text to approximate token budget (1 token ~ 4 chars)
    const capTokens = (text: string, maxTokens: number): string => {
      const maxChars = maxTokens * 4;
      if (!text || text.length <= maxChars) return text;
      return text.substring(0, maxChars) + '... [truncated]';
    };

    const tenantName = agent.name?.trim() || 'EFU General Insurance';
    let basePrompt = agent.systemPrompt || '';
    if (!basePrompt || basePrompt.includes('V3C Platform')) {
      basePrompt = `You are the official AI Virtual Customer Assistant for ${tenantName}. Answer visitor questions clearly and accurately regarding ${tenantName} services, insurance policies, motor, health, travel, fire, and marine coverage options.`;
    }

    let promptParts: string[] = [];

    // 1. Base System Prompt (<800 tokens)
    promptParts.push(`### System Role & Instructions:\n${capTokens(basePrompt, 800)}`);

    // 2. Language & Gender Constraints
    promptParts.push(`### Language & Gender Rules:\n${langInstruction}\n\n${genderInstruction}`);

    // 3. Guardrails & Policy Protocol (~200 tokens)
    if (guardrailsPrompt && guardrailsPrompt.trim()) {
      promptParts.push(`### Safety, Guardrails & Policy Protocol:\n${capTokens(guardrailsPrompt, 200)}`);
    }

    // 5. Conversation Summary (if exists from rolling memory, <300 tokens)
    if (summary && summary.trim()) {
      promptParts.push(`### Conversation History Summary:\n${capTokens(summary, 300)}`);
    }

    // 6. Voice Scope Constraint & Strict Knowledge Base Protocol
    if (isVoice) {
      promptParts.push(`### CRITICAL VOICE SYSTEM RULES (STRICT EFU SCOPE):
1. You are the official virtual customer support assistant EXCLUSIVELY for EFU General Insurance.
2. For standard greetings and pleasantries ("Hello", "Salam", "How are you?"), reply warmly in character.
3. For all service, policy, and coverage inquiries, you MUST rely ONLY on the official retrieved EFU knowledge base context provided for the turn.
4. STRICT SCOPE GUARD: Do NOT answer general knowledge, coding, math, world news, or non-EFU queries using outside model memory.
5. If a question is outside our official EFU Knowledge Base or asks about non-EFU topics/competitors, you MUST output the designated fallback refusal.`);
    }

    // 7. Ground Truth Retrieved Context (RAG, <1000 tokens)
    if (retrievedContext && retrievedContext.trim()) {
      promptParts.push(`### CRITICAL RULE — EFU Knowledge Base Ground Context (STRICT GROUNDING):\n` +
        `You have been provided with official reference knowledge below. You MUST:\n` +
        `1. Answer using ONLY official EFU General Insurance information from this knowledge base.\n` +
        `2. STRICT RELEVANCE GUARD: If the query is general geography, country trivia, or non-insurance topics (e.g. "Tell me about Pakistan"), ONLY explain relevant ${tenantName} insurance products (e.g. EFU Travel Insurance coverage for Pakistan) and politely state that you can only assist with ${tenantName} services.\n` +
        `3. Reproduce exact details without making up policies or referencing non-EFU entities.\n\n` +
        `Knowledge Base Content:\n${capTokens(retrievedContext, 1000)}`);
    } else {
      promptParts.push(`### Knowledge Base Context:\nNo specific EFU reference knowledge found for this query.`);
    }

    return promptParts.join('\n\n').trim();
  }

  /**
   * Format full chat completion messages payload
   */
  static buildMessages(params: PromptBuildParams): { role: 'system' | 'user' | 'assistant'; content: string }[] {
    const systemPrompt = this.buildSystemPrompt(params);
    const messages: { role: 'system' | 'user' | 'assistant'; content: string }[] = [
      { role: 'system', content: systemPrompt }
    ];

    if (params.recentMessages && params.recentMessages.length > 0) {
      for (const msg of params.recentMessages) {
        const role = msg.sender === 'visitor' || msg.sender === 'user' ? 'user' : 'assistant';
        messages.push({ role, content: msg.message });
      }
    }

    if (params.currentMessage && params.currentMessage.trim()) {
      // Only push if last message in recentMessages isn't identical
      const last = messages[messages.length - 1];
      if (!last || last.role !== 'user' || last.content !== params.currentMessage.trim()) {
        messages.push({ role: 'user', content: params.currentMessage.trim() });
      }
    }

    return messages;
  }
}
