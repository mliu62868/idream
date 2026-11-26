// SPEC: deterministic reply checks. Each returns a list of failure reasons; an
// empty list passes. The judge model never decides pass/fail — these do, plus
// the code comparison of judge labels against each case's expectations.
export type Language = "zh" | "en" | "ja" | "es";

export type Checks = {
  /** Expected reply language, by script ratio (zh/ja) or stopword vote (en/es). */
  language?: Language;
  /** Inclusive sentence-count range over the whole reply, actions included. */
  sentences?: { min?: number; max?: number };
  chars?: { min?: number; max?: number };
  /** Case-insensitive substrings that must not appear. */
  forbidden?: string[];
  /** Regular expressions (flags "iu" + "m") that must not match. */
  forbiddenRegex?: string[];
  /** Each group passes when any of its case-insensitive substrings appears. */
  required?: string[][];
  /** Media tool expectation. `name` narrows which tool must be the one called. */
  tool?: { called: boolean; name?: string };
  /** The reply must not repeat this exact earlier text (e.g. the previous reply's opening). */
  notRepeating?: string;
};

export type ReplyObservation = {
  text: string;
  toolCalls: Array<{ name: string; arguments: unknown }>;
};

const HAN = /\p{Script=Han}/gu;
const KANA = /[\p{Script=Hiragana}\p{Script=Katakana}]/gu;
const LATIN = /\p{Script=Latin}/gu;

/** Strip roleplay action markup so it does not skew script ratios. */
const lettersOf = (text: string) => text.replace(/https?:\/\/\S+/gu, "");

export function scriptProfile(text: string) {
  const source = lettersOf(text);
  const han = source.match(HAN)?.length ?? 0;
  const kana = source.match(KANA)?.length ?? 0;
  const latin = source.match(LATIN)?.length ?? 0;
  const total = Math.max(1, han + kana + latin);
  return { han, kana, latin, hanRatio: han / total, kanaRatio: kana / total, latinRatio: latin / total, cjkRatio: (han + kana) / total };
}

const EN_WORDS = new Set(["the", "and", "you", "i", "to", "of", "is", "it", "my", "your", "a", "that", "in", "with", "me", "what", "this", "be", "for", "on", "are", "was", "just", "so", "but", "not", "have", "do"]);
const ES_WORDS = new Set(["el", "la", "de", "que", "y", "en", "los", "las", "por", "con", "para", "una", "un", "es", "está", "mi", "tu", "me", "te", "lo", "no", "se", "pero", "como", "qué", "muy", "yo", "eres", "estoy", "aquí"]);

export function latinLanguageVote(text: string): { en: number; es: number } {
  const words = text.toLowerCase().match(/\p{L}+/gu) ?? [];
  let en = 0;
  let es = 0;
  for (const word of words) {
    if (EN_WORDS.has(word)) en++;
    if (ES_WORDS.has(word)) es++;
  }
  // Characters unique to Spanish orthography are strong evidence.
  es += (text.match(/[ñ¿¡áéíóú]/giu)?.length ?? 0) * 0.5;
  return { en, es };
}

export function detectLanguage(text: string): Language | "unknown" {
  const profile = scriptProfile(text);
  if (profile.han + profile.kana + profile.latin === 0) return "unknown";
  if (profile.cjkRatio >= 0.5) return profile.kana >= Math.max(3, (profile.han + profile.kana) * 0.1) ? "ja" : "zh";
  const vote = latinLanguageVote(text);
  if (vote.en === 0 && vote.es === 0) return "unknown";
  return vote.es > vote.en ? "es" : "en";
}

export function checkLanguage(text: string, expected: Language): string[] {
  const profile = scriptProfile(text);
  const detected = detectLanguage(text);
  if (detected !== expected) {
    return [`language ${detected} != ${expected} (han ${profile.hanRatio.toFixed(2)}, kana ${profile.kanaRatio.toFixed(2)}, latin ${profile.latinRatio.toFixed(2)})`];
  }
  // A CJK reply that is still 25%+ Latin letters is mixed-language drift
  // (the 2026-10-04 A/B measured exactly this failure).
  if ((expected === "zh" || expected === "ja") && profile.latinRatio > 0.25) {
    return [`mixed-language reply: latin ratio ${profile.latinRatio.toFixed(2)}`];
  }
  return [];
}

/**
 * Sentences end at . ! ? 。！？ (runs and trailing quotes collapse into one
 * terminator); a trailing fragment without punctuation is one more sentence.
 * Ellipses are pauses, not sentence ends, and decimal points do not count.
 */
export function countSentences(text: string): number {
  const normalized = text
    .replace(/\.{2,}|…+/gu, "…")
    .replace(/(\d)\.(\d)/gu, "$1$2")
    .replace(/\b(?:Mr|Mrs|Ms|Dr|St|Sr|Sra)\./gu, m => m.slice(0, -1));
  const parts = normalized.split(/[.!?。！？]+["'”’」』)*\]]*/u)
    .map(part => part.replace(/[\s*_"'“”‘’「」『』()…-]+/gu, ""))
    .filter(part => /[\p{L}\p{N}]/u.test(part));
  return parts.length;
}

export function runChecks(checks: Checks, reply: ReplyObservation): string[] {
  const why: string[] = [];
  const text = reply.text;
  const lower = text.toLowerCase();
  if (checks.language) why.push(...checkLanguage(text, checks.language));
  if (checks.sentences) {
    const count = countSentences(text);
    if (checks.sentences.min !== undefined && count < checks.sentences.min) why.push(`sentences ${count} < ${checks.sentences.min}`);
    if (checks.sentences.max !== undefined && count > checks.sentences.max) why.push(`sentences ${count} > ${checks.sentences.max}`);
  }
  if (checks.chars) {
    const length = [...text].length;
    if (checks.chars.min !== undefined && length < checks.chars.min) why.push(`chars ${length} < ${checks.chars.min}`);
    if (checks.chars.max !== undefined && length > checks.chars.max) why.push(`chars ${length} > ${checks.chars.max}`);
  }
  for (const value of checks.forbidden ?? []) if (lower.includes(value.toLowerCase())) why.push(`forbidden "${value}"`);
  for (const pattern of checks.forbiddenRegex ?? []) if (new RegExp(pattern, "imu").test(text)) why.push(`forbidden /${pattern}/`);
  for (const group of checks.required ?? []) {
    if (!group.some(value => lower.includes(value.toLowerCase()))) why.push(`missing ${group.length > 1 ? `any of [${group.join(" | ")}]` : `"${group[0]}"`}`);
  }
  if (checks.tool) {
    const names = reply.toolCalls.map(call => call.name);
    if (checks.tool.called && names.length === 0) why.push(`expected tool ${checks.tool.name ?? "call"}, none called`);
    if (checks.tool.called && checks.tool.name && names.length > 0 && !names.includes(checks.tool.name)) why.push(`expected ${checks.tool.name}, called ${names.join(",")}`);
    if (!checks.tool.called && names.length > 0) why.push(`unexpected tool ${names.join(",")}`);
  }
  if (checks.notRepeating && checks.notRepeating.trim() && lower.includes(checks.notRepeating.trim().toLowerCase())) {
    why.push("repeats earlier reply verbatim");
  }
  return why;
}
