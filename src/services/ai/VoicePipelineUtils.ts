/**
 * VoicePipelineUtils.ts
 * Core utility functions for processing voice transcripts, language classification,
 * noise filtering, intent routing, and response timing for the Realtime voice assistant.
 */

const FILLER_PATTERNS: RegExp[] = [
  /^[\s\.\,\?\!\-\_\:\;\"]+$/,
  /^(a+h*|u+h*|h+m+|o+h*|e+r+|a+a+|u+m+|h+u+m+|h+m+m+)\.?$/i,
  /^(yeah|yep|nope|okay|ok|right|well|so)\.?$/i,
  /^\(?\[?(cough|coughing|throat|clears throat|sigh|laughter|chuckle|snort|groan|gasp|noise|music|muffled|static)\]?\)?$/i,
  /^[\(\[\{].*[\)\]\}]$/,
];

const ROMAN_URDU_KEYWORDS = new Set([
  'kya', 'kia', 'kaise', 'kis', 'hai', 'hain', 'kiya', 'apki', 'aapki', 'madad',
  'batao', 'bataen', 'bataeyn', 'chahiye', 'mein', 'hoon', 'hun', 'sab',
  'sahib', 'bhai', 'sirf', 'aur', 'yeh', 'woh', 'raha', 'rahi', 'taraf',
  'zaroorat', 'takaful', 'bima', 'beema', 'jis', 'jo', 'terah', 'tarah',
  'ko', 'ke', 'ki', 'se', 'shukriya', 'karo', 'karen', 'gaya', 'gayi',
  'mujhe', 'humey', 'unko', 'is', 'us', 'kab', 'kahan', 'kyun', 'mera',
  'meri', 'mere', 'sakti', 'saktee', 'sakta', 'mil', 'manga', 'baare',
  'karna', 'karni', 'chahta', 'chahti', 'apne', 'apni', 'ka', 'bhi', 'hoga', 'hogi'
]);

const GREETING_PATTERNS: RegExp[] = [
  /\b(assalam|salam|alaikum|walekum|walaikum|hello|hi|hey|greetings|good\s*(morning|afternoon|evening|day))\b/i,
  /\b(how\s*are\s*you|how\s*do\s*you\s*do|kaise\s*h?ai?n?|kya\s*haal|kya\s*hal|kaisay\s*h?ai?n?|kisi\s*ho)\b/i,
  /\b(thank\s*you|thanks|shukriya|meherbani|jazakallah|allah\s*hafiz|bye|goodbye)\b/i,
  /\b(who\s*are\s*you|what\s*is\s*your\s*name|aap\s*kaun\s*hai?n?|ap\s*kaun\s*hai?n?)\b/i,
  /\b(what\s*(services|products|policies|insurance|coverage)\s*(do\s*you\s*(provide|offer|have)|are\s*there|available))\b/i,
  /\b(tell\s*me\s*about\s*(your\s*)?(services|products|company|insurance))\b/i,
  /\b(what\s*can\s*you\s*(do|help\s*with))\b/i,
  /\b(konsi|kon\s*si|kya)\s*(services|bima|insurance|coverage)\s*(hain|h?ai?n?|dete\s*h?ai?n?|milti\s*h?ai?n?)\b/i,
  /\b(kya\s*kaam\s*karte\s*h?ai?n?|madad\s*kar\s*sakte\s*h?ai?n?)\b/i,
  /[\u0600-\u06FF]*(السلام|سلام|وعلیکم|ہیلو|شکریہ|خدا حافظ|اللہ حافظ|کیسے|کیسا|سروسز|خدمات)[\u0600-\u06FF]*/
];

const AFFIRMATION_PATTERNS: RegExp[] = [
  /^(yes|no|yeah|yep|nope|sure|ok|okay|ji|haan|han|ji\s*haan|nhi|nahi|sahi|bilkul|theek|theek\s*hai)\.?$/i,
  /\b(can\s*you\s*hear\s*me|am\s*i\s*audible|aawaz\s*aa\s*rahi\s*hai|sun\s*rah[ey]\s*ho)\b/i,
  /\b(repeat|repeat\s*that|phir\s*se\s*batao|dobara\s*bataen)\b/i,
  /[\u0600-\u06FF]*(جی|جی ہاں|ہاں|نہیں|بالکل|ٹھیک|آواز آرہی ہے)[\u0600-\u06FF]*/
];

/**
 * Check if a transcribed utterance is noise, filler, or too short to enter RAG
 */
export function isNoisyTranscript(
  text: string,
  minLength: number = 3,
  minWordCount: number = 2
): boolean {
  if (!text) return true;
  const trimmed = text.trim();
  if (trimmed.length < minLength) return true;

  for (const pattern of FILLER_PATTERNS) {
    if (pattern.test(trimmed)) return true;
  }

  const words = trimmed.split(/\s+/).filter(w => w.length > 0);
  if (words.length < minWordCount) {
    const singleWord = words[0]?.toLowerCase().replace(/[^a-z\u0600-\u06FF]/g, '');
    const validGreetings = ['hello', 'hi', 'assalam', 'salam', 'help', 'ہلو', 'ہیلو', 'السلام', 'سلام', 'جی'];
    if (validGreetings.includes(singleWord)) return false;
    if (!singleWord || singleWord.length < 4) return true;
    if (FILLER_PATTERNS.some(p => p.test(singleWord))) return true;
  }

  return false;
}

/**
 * Check if a user utterance is a standard conversational greeting, pleasantry, or small talk.
 * These utterances should use the Agent System Prompt & Instructions instead of triggering Out-Of-Scope fallback.
 */
export function isConversationalGreeting(text: string): boolean {
  if (!text) return false;
  const trimmed = text.trim();
  const words = trimmed.split(/\s+/).filter(w => w.length > 0);
  if (words.length > 10) return false;

  for (const pattern of GREETING_PATTERNS) {
    if (pattern.test(trimmed)) {
      return true;
    }
  }
  return false;
}

/**
 * Check if a user utterance is a short affirmation, audio check, or confirmation ("Yes", "Ji", "Can you hear me?").
 */
export function isConversationalAffirmation(text: string): boolean {
  if (!text) return false;
  const trimmed = text.trim();
  const words = trimmed.split(/\s+/).filter(w => w.length > 0);
  if (words.length > 8) return false;

  for (const pattern of AFFIRMATION_PATTERNS) {
    if (pattern.test(trimmed)) {
      return true;
    }
  }
  return false;
}

/**
 * Normalizes common speech-to-text / Whisper phonetic mishearings for domain terms.
 * e.g., "ASU general" -> "EFU General", "A S U" -> "EFU", "AFU" -> "EFU"
 */
export function normalizePhoneticDomainTerms(text: string): string {
  if (!text) return text;
  let normalized = text;
  normalized = normalized.replace(/\b(a\s*s\s*u|asu|a\s*f\s*u|afu)\b/gi, 'EFU');
  return normalized;
}

/**
 * Normalizes common Urdu transliterations of Sidat terms into English domain terms
 * specifically for vector search retrieval embeddings.
 */
export function normalizeSidatTerms(query: string): string {
  if (!query) return query;
  let normalized = query;

  // Sidat transliterations: "صداد" / "سداد" / "سڈات" -> "Sidat"
  normalized = normalized.replace(/(صداد|سداد|سڈات)/gu, 'Sidat');

  // Sprintly transliterations: "اسپرینٹلی" / "سپرینٹلی" / "سپرینکلیکی" / "سپرنٹلی" / "سپرنٹ لی" -> "Sprintly"
  normalized = normalized.replace(/(اسپرینٹلی|سپرینٹلی|سپرینکلیکی|سپرنٹلی|سپرنٹ لی)/gu, 'Sprintly');

  // Technologies: "ٹیکنالوجیز" / "ٹیکنالوجی" -> "Technologies"
  normalized = normalized.replace(/(ٹیکنالوجیز|ٹیکنالوجی)/gu, 'Technologies');

  // Services: "سرویسز" / "سروسز" / "سروس" -> "services"
  normalized = normalized.replace(/(سرویسز|سروسز|سروس)/gu, 'services');

  // Product: "پروڈکٹ" / "پروڈکٹس" -> "product"
  normalized = normalized.replace(/(پروڈکٹ|پروڈکٹس)/gu, 'product');

  return normalized;
}

/**
 * Contextualize short follow-up questions ("What about motor?", "Other insurances?", "How much does it cost?")
 * using preceding dialogue context for vector search retrieval. Also applies domain phonetic normalization.
 */
export function contextualizeQuery(text: string, previousTurnText?: string): string {
  if (!text) return text;
  let trimmed = text.trim();
  trimmed = normalizePhoneticDomainTerms(trimmed);
  const words = trimmed.split(/\s+/).filter(w => w.length > 0);

  // If query is short (< 7 words) or contains follow-up pronouns
  const isShortOrFollowup = words.length < 7 || /\b(it|other|others|this|that|also|more|cost|price|details|dono|doosri|doosra)\b/i.test(trimmed);

  if (isShortOrFollowup && previousTurnText && previousTurnText.trim()) {
    const cleanPrev = previousTurnText.trim().substring(0, 100);
    return `${trimmed} (context: ${cleanPrev})`;
  }

  return trimmed;
}

/**
 * Normalizes Devanagari (Hindi) script characters that Whisper may emit.
 */
export function normalizeHindiToUrdu(text: string): string {
  if (!text) return '';
  const containsDevanagari = /[\u0900-\u097F]/.test(text);
  if (!containsDevanagari) return text;

  const cleaned = text.replace(/[\u0900-\u097F]+/g, ' ').replace(/\s+/g, ' ').trim();
  return cleaned;
}

/**
 * Determines the dominant language of a user utterance using token majority rule.
 */
export function detectDominantLanguage(text: string): 'English' | 'Urdu' | 'RomanUrdu' {
  if (!text || text.trim().length === 0) return 'Urdu';

  const trimmed = text.trim();

  // Any transcript containing Tamil (U+0B80–U+0BFF), Devanagari (U+0900–U+097F),
  // or other Indic/non-Arabic/non-Latin scripts returns 'Urdu' (Whisper misdetections of Urdu)
  if (/[\u0900-\u0DFF]/.test(trimmed)) {
    return 'Urdu';
  }

  const urduWords = (trimmed.match(/[\u0600-\u06FF]+/g) || []).length;
  if (urduWords > 0) {
    return 'Urdu';
  }

  const words = trimmed.toLowerCase().split(/\s+/).map(w => w.replace(/[^a-z]/g, '')).filter(w => w.length > 0);
  if (words.length === 0) return 'Urdu';

  let consecutiveEnglish = 0;
  let maxConsecutiveEnglish = 0;
  let romanUrduTokens = 0;

  for (const word of words) {
    if (ROMAN_URDU_KEYWORDS.has(word)) {
      romanUrduTokens++;
      consecutiveEnglish = 0;
    } else {
      consecutiveEnglish++;
      if (consecutiveEnglish > maxConsecutiveEnglish) {
        maxConsecutiveEnglish = consecutiveEnglish;
      }
    }
  }

  // Respond in English ONLY when user's transcript contains 3 or more consecutive English words and no Roman Urdu
  if (maxConsecutiveEnglish >= 3 && romanUrduTokens === 0) {
    return 'English';
  }

  if (romanUrduTokens > 0) {
    return 'RomanUrdu';
  }

  return 'Urdu';
}

/**
 * Calculates the remaining natural thinking delay before calling response.create().
 */
export function computeThinkingDelay(retrievalMs: number, targetDelayMs: number = 600): number {
  const remaining = targetDelayMs - retrievalMs;
  return remaining > 0 ? remaining : 0;
}

// ── Competitor / out-of-tenant entity guard ──────────────────────────────────
export const COMPETITOR_PATTERNS: RegExp[] = [
  /\befu\b/i, /\bigi\b/i, /\bjubilee\b/i, /\badamjee\b/i, /\btpl\b/i, /\bstate\s*life\b/i,
  /\bnational\s*life\b/i, /\bpakistan\s*life\b/i, /\bsalamtakaful\b/i, /\bpak\s*qatar\b/i,
  /\bwarid\b/i, /\bhabib\s*metro\b/i, /\balianz\b/i, /\bchubb\b/i, /\bpru\s*bsn\b/i,
];

export function detectCompetitor(query: string, currentTenantName?: string): string | null {
  const tenantLower = (currentTenantName || '').toLowerCase();
  for (const pattern of COMPETITOR_PATTERNS) {
    const match = query.match(pattern);
    if (match) {
      const matchLower = match[0].toLowerCase();
      if (tenantLower && (tenantLower.includes(matchLower) || (matchLower === 'efu' && tenantLower.includes('efu')))) {
        continue;
      }
      return match[0];
    }
  }
  return null;
}

// ── Out-of-Scope & In-Scope Domain Keywords ─────────────────────────────────
export const OUT_OF_SCOPE_KEYWORDS = /\b(match|matches|cricket|football|sports|weather|temperature|politics|election|movie|film|actor|actress|song|music|recipe|cook|medical|doctor|medicine|news|celebrity|entertainment|game|games|score|team|player|tournament|مچ|میچ|کرکٹ|فٹبال|کھیل|موسم|سیاست|الیکشن|فلم|فلمیں|گیم|گیمز|میوزک|گانا|کھانا|ڈاکٹر|دوا|خبر|خبریں)\b/i;

export const IN_SCOPE_KEYWORDS = new RegExp(
  '\\b(sidat|sprintly|software|service|services|solution|solutions|product|products|pricing|price|cost|development|web|app|mobile|ai|cloud|digital|support|contact|team|erp|crm|ai hub|artificial intelligence|web development|mobile app|website|digital marketing|seo|social media|bpo|virtual assistance|business process)\\b|' +
  '(سڈات|صداد|سداد|سپرنٹلی|اسپرینٹلی|سپرینکلیکی|سپرنٹ لی|سروس|سروسز|سرویسز|ٹیکنالوجیز|ٹیکنالوجی|سافٹ ویئر|حل|پروڈکٹ|پروڈکٹس|قیمت|رابطہ|مصنوعی ذہانت|ویب سائٹ|موبائل ایپ|سوشل میڈیا|بزنس پروسیس)',
  'i'
);

export const FOLLOW_UP_CONTINUATION_PATTERNS = new RegExp(
  '\\b(aur batao|aur bataen|aur|kuch aur|haan|han|theek hai|theek|phir|acha|achha|sahi|bilkul|tell more|what else|continue|yes|ok|okay)\\b|' +
  '(اور بتاؤ|اور بتائیں|اور|کچھ اور|ہاں|ٹھیک ہے|ٹھیک|پھر|اچھا|صحیح|بالکل)',
  'i'
);

export function evaluateScopeAndRefusal(
  userSpeech: string,
  lastTurnWasRefused: boolean
): { shouldRefuse: boolean; refused: boolean; updatedRefusedState: boolean; reason?: string } {
  // 1. Check IN_SCOPE_KEYWORDS FIRST to prevent false-positives for legitimate queries
  // containing terms like "game" (game development), "team" (team management), etc.
  const isInScope = IN_SCOPE_KEYWORDS.test(userSpeech);
  if (isInScope) {
    if (lastTurnWasRefused) {
      console.log(`[VoicePipelineUtils] Follow-up guard bypassed due to in-scope keyword: "${userSpeech}"`);
    }
    return { shouldRefuse: false, refused: false, updatedRefusedState: false };
  }

  // 2. Only if NO in-scope keyword matches, check for out-of-scope keyword
  const isOutOfScope = OUT_OF_SCOPE_KEYWORDS.test(userSpeech);
  if (isOutOfScope) {
    return { shouldRefuse: true, refused: true, updatedRefusedState: true, reason: 'KEYWORD_MATCH' };
  }

  // 3. Check for out-of-scope follow-up continuation
  if (lastTurnWasRefused) {
    const words = userSpeech.trim().split(/\s+/).filter(Boolean);
    const isContinuation = FOLLOW_UP_CONTINUATION_PATTERNS.test(userSpeech) || words.length <= 3;
    if (isContinuation) {
      console.log(`[VoicePipelineUtils] Follow-up refused. No in-scope keyword found: "${userSpeech}"`);
      return { shouldRefuse: true, refused: true, updatedRefusedState: true, reason: 'FOLLOW_UP_CONTINUATION' };
    }
    // Substantive user utterance with no out-of-scope keywords: allow RAG retrieval
    return { shouldRefuse: false, refused: false, updatedRefusedState: false };
  }

  return { shouldRefuse: false, refused: false, updatedRefusedState: false };
}

// Unit-style verification logs
const _selfTest1 = evaluateScopeAndRefusal('game development services', false);
console.log(`[VoicePipelineUtils] Self-test 1 ('game development services'): refused=${_selfTest1.refused} (expected false)`);
const _selfTest2 = evaluateScopeAndRefusal('Pakistan ka match kab hai', false);
console.log(`[VoicePipelineUtils] Self-test 2 ('Pakistan ka match kab hai'): refused=${_selfTest2.refused} (expected true)`);
const _selfTest3 = evaluateScopeAndRefusal('Sprintly kya hai?', true);
console.log(`[VoicePipelineUtils] Self-test 3 ('Sprintly kya hai?', after refused turn): refused=${_selfTest3.refused} (expected false)`);
const _selfTest4 = evaluateScopeAndRefusal('Sidat ki services kya hain?', true);
console.log(`[VoicePipelineUtils] Self-test 4 ('Sidat ki services kya hain?', after refused turn): refused=${_selfTest4.refused} (expected false)`);
const _selfTest5 = evaluateScopeAndRefusal('aur batao', true);
console.log(`[VoicePipelineUtils] Self-test 5 ('aur batao', after refused turn): refused=${_selfTest5.refused} (expected true)`);


export function isFemaleVoice(voiceSettings: any = {}, selectedVoice: string = ''): boolean {
  if (voiceSettings?.gender) {
    return voiceSettings.gender.toLowerCase() === 'female';
  }
  const femaleVoices = ['shimmer', 'coral', 'sage', 'verse', 'marin'];
  const voiceClean = selectedVoice.split(' ')[0].toLowerCase().replace(/[^a-z]/g, '');
  return femaleVoices.includes(voiceClean);
}

export const TOP_PRIORITY_SCOPE_RULE = `### TOP PRIORITY — SCOPE RULE:
If the retrieved context is empty OR does not directly answer the user's question, OUTPUT ONLY THIS URDU TEXT and NOTHING ELSE:
"معذرت، میں اس سوال کا جواب نہیں دے سکتا۔ براہ کرم ہماری سیلز ٹیم سے رابطہ کریں تاکہ وہ آپ کی بہتر مدد کر سکیں۔"
DO NOT attempt to answer. DO NOT ask clarifying questions. OUTPUT ONLY THE ABOVE TEXT.`;

export const DEFAULT_LANGUAGE_RULES = `### LANGUAGE:
- Default and primary language is URDU (اردو).
- Respond in English ONLY when the user's transcript contains 3 or more consecutive English words.
- If the transcript is in any non-Arabic script (Tamil, Devanagari, etc.), treat it as URDU and respond in Urdu.
- Do NOT respond in any other language even if the user asks.`;

export function buildConciseSessionInstructions(isFemaleAgent: boolean): string {
  const genderRule = isFemaleAgent
    ? `# Gender (Urdu)\nUse FEMALE first-person verbs only (سمجھتی ہوں, بتا سکتی ہوں). NEVER use male verbs (سمجھتا ہوں, بتا سکتا ہوں).`
    : `# Gender (Urdu)\nUse MALE first-person verbs only (سمجھتا ہوں, بتا سکتا ہوں). NEVER use female verbs (سمجھتی ہوں, بتا سکتی ہوں).`;

  return `# Role
You are Ask Sidat, AI assistant for Sidat Technologies & Digital.
# Language
Default: Urdu. Respond in English only if user speaks 3+ English words.
${genderRule}
# Scope
Answer ONLY about Sidat Technologies & Digital services.
If the query is about sports, weather, politics, cricket, entertainment, or any non-business topic, output ONLY the refusal text.
# Refusal Text
"معذرت، میں اس سوال کا جواب نہیں دے سکتا۔ براہ کرم ہماری سیلز ٹیم سے رابطہ کریں تاکہ وہ آپ کی بہتر مدد کر سکیں۔"`;
}

export function isGenericMarketingTitle(title: string): boolean {
  if (!title) return true;
  const t = title.trim();
  if (t.length < 20) return true;
  return /\b(best digital marketing|web development & design|company in pakistan|homepage|welcome|untitled)\b/i.test(t);
}

export function ts(): string {
  return new Date().toISOString().substring(11, 23);
}

export function resolveSelectedVoice(requestedVoice?: string, agentVoice?: string): string {
  const validVoices = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'sage', 'shimmer', 'verse', 'marin', 'cedar', 'onyx'];
  const rawVoice = (requestedVoice || agentVoice || 'cedar').toLowerCase();
  const voiceClean = rawVoice.split(' ')[0].replace(/[^a-z]/g, '');
  return validVoices.includes(voiceClean) ? voiceClean : (validVoices.includes(rawVoice) ? rawVoice : 'cedar');
}

export function getSalesRefusalText(isUrdu: boolean): string {
  return isUrdu
    ? 'معذرت، میں اس سوال کا جواب نہیں دے سکتا۔ براہ کرم ہماری سیلز ٹیم سے رابطہ کریں تاکہ وہ آپ کی بہتر مدد کر سکیں۔'
    : 'I am unable to help with this query. Please contact our sales team for further assistance.';
}

export function getGreetingText(isFemale: boolean): { text: string; directive: string } {
  return {
    text: isFemale
      ? 'As Salam o Alaikum! Main apki kiya madad kar sakti hon?'
      : 'As Salam o Alaikum! Main apki kiya madad kar sakta hon?',
    directive: isFemale
      ? '[RESPOND 100% IN URDU — FEMALE VERBS ONLY]'
      : '[RESPOND 100% IN URDU — MALE VERBS ONLY]',
  };
}

export function getTurnCapNotice(isUrdu: boolean): string {
  return isUrdu
    ? 'آپ کی گفتگو کی 20 باریوں کی حد مکمل ہو چکی ہے۔ برائے مہربانی اپنا رابطہ نمبر چھوڑ دیں تاکہ ہماری ٹیم آپ سے رابطہ کر سکے۔ شکریہ!'
    : 'You have reached the voice session limit of 20 turns. Please leave your contact details so our support team can follow up with you. Thank you!';
}

export function getPromptInjectionRefusal(isUrdu: boolean): string {
  return isUrdu
    ? 'معذرت، میں آپ کی اس درخواست کا جواب نہیں دے سکتا۔ میں صرف ہماری کمپنی کی سروسز میں مدد کر سکتا ہوں۔'
    : 'I cannot fulfill requests attempting to alter system instructions. How can I assist you with our services today?';
}




