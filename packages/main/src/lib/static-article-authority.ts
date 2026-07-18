export const dedicatedStaticArticlePaths = [
  "/guides/character-cards",
  "/guides/character-card-creator",
  "/guides/sillytavern-setup-guide",
] as const;

export type DedicatedStaticArticlePath =
  (typeof dedicatedStaticArticlePaths)[number];

const dedicatedStaticArticlePathSet = new Set<string>(
  dedicatedStaticArticlePaths,
);

export function hasDedicatedStaticArticleContent(path: string) {
  return dedicatedStaticArticlePathSet.has(path);
}
