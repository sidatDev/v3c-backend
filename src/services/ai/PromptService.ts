import { TenantConfig } from '../cache/TenantConfigCache';

export interface PromptBuildParams {
  tenantConfig: TenantConfig;
  retrievedContext?: string;
  summary?: string;
  recentMessages?: { sender: 'visitor' | 'ai' | 'user' | 'assistant'; message: string }[];
  currentMessage?: string;
  language?: string;
  isVoice?: boolean;
  voice?: string;
}

export class PromptService {
  /**
   * Constructs the unified system prompt & messages array for AI completion/orchestration
   */
  static buildSystemPrompt(params: PromptBuildParams): string {
    const { tenantConfig, retrievedContext, summary, language = 'en', isVoice = false, voice } = params;
    const { agent, personaPrompt, guardrailsPrompt } = tenantConfig;
    const vSettings = (agent.voiceSettings as any) || {};
    const basePromptLower = (agent.systemPrompt || '').toLowerCase();
    let isFemaleVoice = false;

    if (vSettings.gender) {
      isFemaleVoice = vSettings.gender.toLowerCase() === 'female';
    } else if (basePromptLower.includes('male virtual assistant') || basePromptLower.includes('male assistant') || basePromptLower.includes('male urdu grammar')) {
      isFemaleVoice = false;
    } else if (basePromptLower.includes('female virtual assistant') || basePromptLower.includes('female assistant') || basePromptLower.includes('female urdu grammar')) {
      isFemaleVoice = true;
    } else {
      const rawVoiceParam = voice || agent.voice || 'cedar';
      const voiceClean = rawVoiceParam.split(' ')[0].toLowerCase().replace(/[^a-z]/g, '');
      const femaleVoices = ['shimmer', 'coral', 'sage', 'verse', 'marin', 'nova'];
      isFemaleVoice = femaleVoices.includes(voiceClean);
    }

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
      ? 'CRITICAL GENDER GRAMMAR RULE (URDU/ROMAN URDU):\n' +
        '1. You are a FEMALE virtual assistant. ALWAYS use female first-person grammatical verbs for yourself (e.g. "bata deti hoon", "bataati hoon", "kehti hoon", "samajhti hoon", "bata sakti hoon", "karti hoon", "samjhaungi", "سکتی ہوں", "دیتی ہوں", "سمجھاؤں گی").\n' +
        '2. RAG GENDER ADAPTATION: If the retrieved knowledge base source chunks contain male verbs, convert them to female verbs for yourself.'
      : 'CRITICAL GENDER GRAMMAR RULE (URDU/ROMAN URDU):\n' +
        '1. FIRST-PERSON MALE GENDER: You are a MALE virtual assistant. When communicating in Urdu or Roman Urdu, ALWAYS use MALE first-person grammatical verbs and agreement for yourself (e.g. "bata deta hoon", "bataata hoon", "bata sakta hoon", "kehta hoon", "samajhta hoon", "karta hoon", "raha hoon", "samjhaunga", "میں کر سکتا ہوں", "کرتا ہوں", "رہا ہوں", "سمجھتا ہوں", "دیتا ہوں", "سمجھاؤں گا"). ABSOLUTELY NEVER use female first-person verbs for yourself such as "bataati hoon", "batati hoon", "bata deti hoon", "bata sakti hoon", "kehti hoon", "saktee hoon", "karti hoon", "samjhaungi", "دیتی ہوں", "بتاتی ہوں", "سکتی ہوں", "کرتی ہوں", "سمجھاؤں گی".\n' +
        '2. SECOND-PERSON RESPECTFUL USER ADDRESS: When addressing the user/visitor in Urdu or Roman Urdu, ALWAYS use polite neutral/male second-person forms (e.g. "aap bata sakte hain", "aap pooch sakte hain", "aap chahte hain", "آپ بتا سکتے ہیں", "پوچھ سکتے ہیں"). NEVER address the visitor with female endings like "bata sakti hain", "bataati hain", "chahti hain", "بتا سکتی ہیں", "بتاتی ہیں", "چاہتی ہیں".\n' +
        '3. RAG SOURCE GENDER ADAPTATION: If retrieved knowledge base chunks contain female verbs (e.g. "bata deti hoon", "bataati hoon"), YOU MUST CONVERT AND ADAPT them to male verbs ("bata deta hoon", "bataata hoon"). NEVER copy female verbs from knowledge base text.';

    // Helper to truncate text to approximate token budget (1 token ~ 4 chars)
    const capTokens = (text: string, maxTokens: number): string => {
      const maxChars = maxTokens * 4;
      if (!text || text.length <= maxChars) return text;
      return text.substring(0, maxChars) + '... [truncated]';
    };

    const tenantName = agent.name?.trim() || 'Sidat Technologies & Digital';
    let basePrompt = agent.systemPrompt || '';
    if (!basePrompt || basePrompt.includes('V3C Platform')) {
      basePrompt = `You are the official AI Virtual Customer Assistant for ${tenantName}. Answer visitor questions clearly and accurately regarding ${tenantName} services, AI solutions, digital transformation, and customer support.`;
    }

    let promptParts: string[] = [];

    // 1. Base System Prompt (<2000 tokens / 8000 chars)
    promptParts.push(`### System Role & Instructions:\n${capTokens(basePrompt, 2000)}`);

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
      promptParts.push(`### CRITICAL VOICE SYSTEM RULES:
1. You are the official virtual customer support assistant EXCLUSIVELY for ${tenantName}.
2. For standard greetings and pleasantries ("Hello", "Salam", "How are you?"), reply warmly in character.
3. For all service and company inquiries, you MUST rely ONLY on the official retrieved knowledge base context provided for the turn.
4. STRICT SCOPE GUARD: Do NOT answer general knowledge, coding, math, world news, or non-${tenantName} queries using outside model memory.
5. If a question is outside our official Knowledge Base or asks about non-company topics/competitors, output the designated fallback refusal.`);
    }

    // 7. Ground Truth Retrieved Context (RAG, <1000 tokens)
    if (retrievedContext && retrievedContext.trim()) {
      promptParts.push(`### CRITICAL RULE — Knowledge Base Ground Context (STRICT GROUNDING):\n` +
        `You have been provided with official reference knowledge below. You MUST:\n` +
        `1. Answer using ONLY official ${tenantName} information from this knowledge base.\n` +
        `2. Reproduce exact details without making up services or referencing non-${tenantName} entities.\n\n` +
        `Knowledge Base Content:\n${capTokens(retrievedContext, 1000)}`);
    } else {
      promptParts.push(`### Knowledge Base Context:\nNo specific reference knowledge found for this query.`);
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

    const { agent } = params.tenantConfig;
    const vSettings = (agent.voiceSettings as any) || {};
    const basePromptLower = (agent.systemPrompt || '').toLowerCase();
    let isFemaleVoice = false;

    if (vSettings.gender) {
      isFemaleVoice = vSettings.gender.toLowerCase() === 'female';
    } else if (basePromptLower.includes('male virtual assistant') || basePromptLower.includes('male assistant') || basePromptLower.includes('male urdu grammar')) {
      isFemaleVoice = false;
    } else if (basePromptLower.includes('female virtual assistant') || basePromptLower.includes('female assistant') || basePromptLower.includes('female urdu grammar')) {
      isFemaleVoice = true;
    } else {
      const rawVoiceParam = params.voice || agent.voice || 'cedar';
      const voiceClean = rawVoiceParam.split(' ')[0].toLowerCase().replace(/[^a-z]/g, '');
      const femaleVoices = ['shimmer', 'coral', 'sage', 'verse', 'marin', 'nova'];
      isFemaleVoice = femaleVoices.includes(voiceClean);
    }

    const finalDirective = isFemaleVoice
      ? '[MANDATORY PERSONA RULE]: Respond strictly as a FEMALE assistant using female Urdu/Roman Urdu verbs ("bata deti hoon", "samjhaungi", "karti hoon").'
      : '[MANDATORY PERSONA RULE]: Respond strictly as a MALE assistant using MALE Urdu/Roman Urdu verbs ("bata deta hoon", "samjhaunga", "karta hoon", "bata sakta hoon"). ABSOLUTELY DO NOT use female verbs like "bata deti hoon", "samjhaungi", "karti hoon", or "bata sakti hoon".';

    messages.push({ role: 'system', content: finalDirective });

    return messages;
  }

  /**
   * Fail-safe post-processing sanitizer to ensure response matches target gender persona
   * even if RAG chunks or legacy conversation history contained opposite gender verbs.
   */
  static sanitizeGenderVerbs(text: string, isFemale: boolean = false): string {
    if (!text) return text;
    let result = text;

    if (!isFemale) {
      result = result
        .replace(/\b(bataati|bataatee|batati)\s+hoon\b/gi, 'bataata hoon')
        .replace(/\b(bataati|bataatee|batati)\s+hain\b/gi, 'bataate hain')
        .replace(/\bbata\s+deti\s+hoon\b/gi, 'bata deta hoon')
        .replace(/\bbata\s+(sakti|saktee|saktii)\s+hoon\b/gi, 'bata sakta hoon')
        .replace(/\bbata\s+(sakti|saktee|saktii)\s+hain\b/gi, 'bata sakte hain')
        .replace(/\b(kar|karr)\s+(sakti|saktee|saktii)\s+hoon\b/gi, 'kar sakta hoon')
        .replace(/\b(kar|karr)\s+(sakti|saktee|saktii)\s+hain\b/gi, 'kar sakte hain')
        .replace(/\b(sakti|saktee|saktii)\s+hoon\b/gi, 'sakta hoon')
        .replace(/\b(sakti|saktee|saktii)\s+hain\b/gi, 'sakte hain')
        .replace(/\b(kehti|kehtee|kehatii)\s+hoon\b/gi, 'kehta hoon')
        .replace(/\b(samajhti|samajhtee)\s+hoon\b/gi, 'samajhta hoon')
        .replace(/\b(samjhaungi|samjhaungii|samjhaoongi)\b/gi, 'samjhaunga')
        .replace(/\b(bataungi|bataungii|bataoongi)\b/gi, 'bataunga')
        .replace(/\b(karungi|karungii|karoongi)\b/gi, 'karunga')
        .replace(/\b(doongi|doongii)\b/gi, 'doonga')
        .replace(/\b(karti|kartee)\s+hoon\b/gi, 'karta hoon')
        .replace(/\b(deti|detee)\s+hoon\b/gi, 'deta hoon')
        .replace(/\bpooch\s+(saktee|sakti)\s+hain\b/gi, 'pooch sakte hain')
        .replace(/\bchahtee?\s+hain\b/gi, 'chahte hain')
        .replace(/بتاتی ہوں/g, 'بتاتا ہوں')
        .replace(/بتاتی ہیں/g, 'بتاتے ہیں')
        .replace(/بتا سکتی ہوں/g, 'بتا سکتا ہوں')
        .replace(/بتا سکتی ہیں/g, 'بتا سکتے ہیں')
        .replace(/کر سکتی ہوں/g, 'کر سکتا ہوں')
        .replace(/کر سکتی ہیں/g, 'کر سکتے ہیں')
        .replace(/سکتی ہوں/g, 'سکتا ہوں')
        .replace(/سکتی ہیں/g, 'سکتے ہیں')
        .replace(/کہتی ہوں/g, 'کہتا ہوں')
        .replace(/سمجھتی ہوں/g, 'سمجھتا ہوں')
        .replace(/سمجھاؤں گی/g, 'سمجھاؤں گا')
        .replace(/بتاؤں گی/g, 'بتاؤں گا')
        .replace(/کروں گی/g, 'کروں گا')
        .replace(/دوں گی/g, 'دوں گا')
        .replace(/کرتی ہوں/g, 'کرتا ہوں')
        .replace(/دیتی ہوں/g, 'دیتا ہوں')
        .replace(/پوچھ سکتی ہیں/g, 'پوچھ سکتے ہیں')
        .replace(/چاہتی ہیں/g, 'چاہتے ہیں');
    }

    return result;
  }
}
