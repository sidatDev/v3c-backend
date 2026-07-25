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
  if (!text || text.trim().length === 0) return 'English';

  const trimmed = text.trim();
  const latinWords = (trimmed.match(/\b[a-zA-Z]{2,}\b/g) || []).length;
  const urduWords = (trimmed.match(/[\u0600-\u06FF]+/g) || []).length;

  // If sentence has majority Latin/English words (e.g. "services do you provide"), classify as English
  if (latinWords > urduWords) {
    return 'English';
  }

  if (urduWords > 0 && urduWords >= latinWords) {
    return 'Urdu';
  }

  const words = trimmed.toLowerCase().split(/\s+/).map(w => w.replace(/[^a-z]/g, '')).filter(w => w.length > 0);
  if (words.length === 0) return 'English';

  let romanUrduTokens = 0;
  let englishTokens = 0;

  for (const word of words) {
    if (ROMAN_URDU_KEYWORDS.has(word)) {
      romanUrduTokens++;
    } else {
      englishTokens++;
    }
  }

  if (romanUrduTokens > englishTokens) {
    return 'RomanUrdu';
  }

  return 'English';
}

/**
 * Calculates the remaining natural thinking delay before calling response.create().
 */
export function computeThinkingDelay(retrievalMs: number, targetDelayMs: number = 600): number {
  const remaining = targetDelayMs - retrievalMs;
  return remaining > 0 ? remaining : 0;
}
