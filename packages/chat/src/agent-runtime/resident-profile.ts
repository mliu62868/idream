/**
 * SPEC: turn the memory tool's free-text user profile into the facts a
 * companion may actually rely on, or nothing at all.
 *
 * INTENT: the profile is the only input that enters the system prompt on every
 * single turn, and it is generated as free prose by a separate maintenance
 * model. Chat consumed it as an opaque string, so whatever that model wrote
 * became "what you know about this person". A survey of 25 real relationship
 * workspaces on 2026-09-13 found the empty state alone phrased six different
 * ways ("- None", "No core user-profile observations extracted.", "No facts or
 * observations to reconcile.", …) — each one reaching the Character as a
 * statement about the user, in the extraction tool's own vocabulary. Three
 * workspaces carried the same fact twice with a stray "1. " prefix, and one
 * carried the extractor's own reasoning about why something was NOT a fact.
 *
 * INVARIANT: this only removes what is structurally identifiable as
 * non-content — empty-state placeholders, the extractor talking about its own
 * job, list-numbering debris and exact duplicates. A real observation is never
 * dropped because it looks unimportant. Whether the user actually said it is
 * decided once per maintain pass against their own words (profile-evidence.ts);
 * rendering only consults that verdict.
 */

/** Whole-line empty states; "No pets" and other negative facts are real content. */
const EMPTY_STATE = [
  /^(?:none|nothing(?:\s+to\s+reconcile)?|n\/a)[.。]*$/iu,
  /^no\s+(?:core\s+)?(?:new\s+)?(?:user[- ]?profile\s+)?(?:facts?|observations?|details?|information)(?:\s+or\s+observations?)?(?:\s+(?:were\s+)?extracted(?:\s+from\s+(?:the\s+)?(?:target|provided)\s+messages?)?|\s+to\s+reconcile)?[.。]*$/iu,
];

/**
 * The extractor narrating its own process rather than stating a fact. These
 * describe the extraction, not the person, and read as bizarre when a Character
 * treats them as something it remembers.
 */
const EXTRACTOR_META = [
  /\brather than a persistent attribute\b/iu,
  /\b(?:profile\s+)?observation\s+extraction\b/iu,
  /\bextraction\s+system\b/iu,
  /\bno\s+(?:core\s+)?observations?\s+(?:to\s+record|recorded)\b/iu,
  // "The user's name is not stated in the provided message." — the extractor
  // reporting an absence from its input, stored with confidence=explicit and
  // read back to the user as "that's what's on record for me" (2026-10-04,
  // 4 of 5 relationship workspaces in the user-view audit).
  /\b(?:not|never)\s+(?:explicitly\s+)?(?:stated|mentioned|provided|specified|given|disclosed)\s+in\s+(?:the\s+)?(?:provided|given|supplied|target|current|this|these)?\s*(?:messages?|conversation|text|input|transcript)\b/iu,
];

/** Identity of a profile line across the profile card, facts and verdicts. */
export function profileLineKey(value: string): string {
  return value.toLowerCase().replace(/\s+/gu, " ").replace(/[.。]+$/u, "").trim();
}

/**
 * Extract the usable facts from one wake profile. An empty result means the
 * relationship has nothing durable yet — the caller must then say nothing,
 * rather than tell the Character that nothing was extracted.
 */
export function residentProfileFacts(raw: string): string[] {
  const facts: string[] = [];
  const seen = new Set<string>();
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    // Markdown headings are the tool's own framing ("# User Profile", and in at
    // least one workspace "# Agent Memory"); the section header is ours to write.
    if (!trimmed || trimmed.startsWith("#")) continue;
    const withoutBullet = trimmed.replace(/^[-*•]\s*/u, "");
    // "1. " debris appears when the maintenance model re-emits a numbered list
    // into a bulleted one; the same fact then shows up twice, once with each.
    const text = withoutBullet.replace(/^\d+[.)]\s*/u, "").trim();
    if (!text) continue;
    if (EMPTY_STATE.some((pattern) => pattern.test(text))) continue;
    if (EXTRACTOR_META.some((pattern) => pattern.test(text))) continue;
    const key = profileLineKey(text);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    facts.push(text);
  }
  return facts;
}

/** Renders only lines the user's own words were verified to support. */
export function renderResidentProfile(profile: string, supported: ReadonlySet<string>): string {
  const facts = residentProfileFacts(profile).filter((fact) => supported.has(profileLineKey(fact)));
  if (facts.length === 0) return "";
  return [
    "What you know about the person you are talking to, from earlier conversations:",
    "",
    ...facts.map((fact) => `- ${fact}`),
  ].join("\n");
}
