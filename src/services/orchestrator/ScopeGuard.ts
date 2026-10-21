/**
 * ScopeGuard.ts
 * Shared scope and business-related classifier for multi-channel intake (WhatsApp, Voice, Web).
 * Evaluates whether an incoming message is related to Sidat Technologies & Digital services.
 */

export const OUT_OF_SCOPE_KEYWORDS: RegExp =
  /\b(match|matches|cricket|football|sports|weather|temperature|politics|election|movie|film|actor|actress|song|music|recipe|cook|medical|doctor|medicine|news|celebrity|entertainment|game|games|score|team|player|tournament|مچ|میچ|کرکٹ|فٹبال|کھیل|موسم|سیاست|الیکشن|فلم|فلمیں|گیم|گیمز|میوزک|گانا|کھانا|ڈاکٹر|دوا|خبر|خبریں)\b/i;

export const IN_SCOPE_KEYWORDS: RegExp = new RegExp(
  '\\b(sidat|sprintly|software|service|services|solution|solutions|product|products|pricing|price|cost|development|web|app|mobile|ai|cloud|digital|support|contact|team|erp|crm|ai hub|artificial intelligence|web development|mobile app|website|digital marketing|seo|social media|bpo|virtual assistance|business process)\\b|' +
    '(سڈات|صداد|سداد|سپرنٹلی|اسپرینٹلی|سپرینکلیکی|سپرنٹ لی|سروس|سروسز|سرویسز|ٹیکنالوجیز|ٹیکنالوجی|سافٹ ویئر|حل|پروڈکٹ|پروڈکٹس|قیمت|رابطہ|مصنوعی ذہانت|ویب سائٹ|موبائل ایپ|سوشل میڈیا|بزنس پروسیس)',
  'i'
);

export const FOLLOW_UP_CONTINUATION_PATTERNS: RegExp = new RegExp(
  '\\b(aur batao|aur bataen|aur|kuch aur|haan|han|theek hai|theek|phir|acha|achha|sahi|bilkul|tell more|what else|continue|yes|ok|okay)\\b|' +
    '(اور بتاؤ|اور بتائیں|اور|کچھ اور|ہاں|ٹھیک ہے|ٹھیک|پھر|اچھا|صحیح|بالکل)',
  'i'
);

/**
 * Standard predefined refusal message shared across channels (Urdu default).
 * Identical to the voice pipeline and RAG fallback message.
 */
export const REFUSAL_TEXT =
  'معذرت، میں اس سوال کا جواب نہیں دے سکتا۔ براہ کرم ہماری سیلز ٹیم سے رابطہ کریں تاکہ وہ آپ کی بہتر مدد کر سکیں۔';

export const REFUSAL_TEXT_EN =
  'I am unable to help with this query. Please contact our sales team for further assistance.';

/**
 * Evaluates whether text content is business-related.
 * Checks in-scope keywords first to prevent false-positives for domain queries containing terms like "game development".
 */
export function isBusinessRelated(content: string): boolean {
  if (!content) return false;
  const trimmed = content.trim();
  if (trimmed.length === 0) return false;

  // 1. In-scope matches always take precedence
  if (IN_SCOPE_KEYWORDS.test(trimmed)) {
    return true;
  }

  // 2. Out-of-scope keyword match triggers refusal
  if (OUT_OF_SCOPE_KEYWORDS.test(trimmed)) {
    return false;
  }

  // 3. Fall through (neutral conversational text, greetings, general queries)
  return true;
}

export const ScopeGuard = {
  isBusinessRelated,
  REFUSAL_TEXT,
  REFUSAL_TEXT_EN,
  IN_SCOPE_KEYWORDS,
  OUT_OF_SCOPE_KEYWORDS,
  FOLLOW_UP_CONTINUATION_PATTERNS,
};

export default ScopeGuard;
