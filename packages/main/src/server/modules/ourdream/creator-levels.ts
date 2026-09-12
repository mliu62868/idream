/** Versioned creator-level policy. Inputs are canonical published/follower facts only. */
export const CREATOR_LEVEL_POLICY_VERSION = 1 as const;
export type CreatorLevel = "starter" | "rising" | "pro" | "studio";
export type CreatorFacts = { publishedCharacters: number; publishedComics: number; followers: number };
export function resolveCreatorLevel(facts: CreatorFacts): CreatorLevel {
  if (facts.publishedCharacters >= 25 && facts.publishedComics >= 10 && facts.followers >= 1000) return "studio";
  if (facts.publishedCharacters >= 10 && facts.publishedComics >= 3 && facts.followers >= 250) return "pro";
  if (facts.publishedCharacters >= 1 || facts.publishedComics >= 1 || facts.followers >= 25) return "rising";
  return "starter";
}
