/**
 * VoicePipelineUtils.ts
 * Core utility functions for processing voice transcripts, language classification,
 * noise filtering, and response timing for the Realtime voice assistant.
 */

// Common filler/non-speech sound patterns from Whisper transcription
const FILLER_PATTERNS: RegExp[] = [
  /^[\s\.\,\?\!\-\_\:\;\"]+$/,
  /^(a+h*|u+h*|h+m+|o+h*|e+r+|a+a+|u+m+)\.?$/i,
  /^(yeah|yep|nope|okay|ok|right|well|so)\.?$/i,
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

  // Check if string matches known filler patterns
  for (const pattern of FILLER_PATTERNS) {
    if (pattern.test(trimmed)) return true;
  }

  // Count distinct words (alphanumeric sequences)
  const words = trimmed.split(/\s+/).filter(w => w.length > 0);
  if (words.length < minWordCount) {
    // Single word: only allow if it's longer than 5 chars and not a simple noise word
    const singleWord = words[0]?.toLowerCase().replace(/[^a-z\u0600-\u06FF]/g, '');
    if (!singleWord || singleWord.length < 5) return true;
    if (['hello', 'hi', 'assalam', 'salam', 'help'].includes(singleWord)) return false;
    if (FILLER_PATTERNS.some(p => p.test(singleWord))) return true;
  }

  return false;
}

/**
 * Normalizes Devanagari (Hindi) script characters that Whisper may emit.
 * Replaces known common Devanagari tokens or strips Devanagari characters
 * to ensure Hindi script never pollutes logs or DB.
 */
export function normalizeHindiToUrdu(text: string): string {
  if (!text) return '';
  // Check if text contains Devanagari characters (U+0900 to U+097F)
  const containsDevanagari = /[\u0900-\u097F]/.test(text);
  if (!containsDevanagari) return text;

  // Remove Devanagari script characters or replace with empty space
  const cleaned = text.replace(/[\u0900-\u097F]+/g, ' ').replace(/\s+/g, ' ').trim();
  return cleaned;
}

/**
 * Determines the dominant language of a user utterance using token majority rule.
 * Fixes issue where a single trailing word (e.g. "yaar", "ji") flips an English query to Urdu.
 */
export function detectDominantLanguage(text: string): 'English' | 'Urdu' | 'RomanUrdu' {
  if (!text || text.trim().length === 0) return 'English';

  const trimmed = text.trim();
  const urduScriptChars = (trimmed.match(/[\u0600-\u06FF]/g) || []).length;
  
  // If native Urdu script (Nastaliq) is dominant, it is Urdu
  if (urduScriptChars > trimmed.length * 0.2 || urduScriptChars >= 3) {
    return 'Urdu';
  }

  // Tokenize words
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

  // Majority classification
  if (romanUrduTokens > englishTokens) {
    return 'RomanUrdu';
  }

  return 'English';
}

/**
 * Calculates the remaining natural thinking delay before calling response.create().
 * Ensures perception of natural speech timing (~400–800ms) without adding unnecessary delay
 * if retrieval already took significant time.
 */
export function computeThinkingDelay(retrievalMs: number, targetDelayMs: number = 600): number {
  const remaining = targetDelayMs - retrievalMs;
  return remaining > 0 ? remaining : 0;
}
