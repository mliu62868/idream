import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";

const curatedCharacterIds = [
  "melissa-burke",
  "summoned-world",
  "sarah-mercer",
  "alexa-reeves",
  "tamsin-jacobs",
  "truth-confessional",
  "truth-stepmother",
  "stephanie",
  "kennedy-graham",
  "eleanor-dawn",
  "bailey-price",
  "sophie",
  "raya-reyes",
  "emily-coming-home",
  "diana-weird-girl",
  "lola-moonstruck",
] as const;

async function seedFunctionSource(name: string) {
  const source = await readFile(fileURLToPath(new URL("./seed.ts", import.meta.url)), "utf8");
  const start = source.indexOf(`async function ${name}(`);
  expect(start).toBeGreaterThanOrEqual(0);
  const next = source.indexOf("\nasync function ", start + 1);
  return source.slice(start, next === -1 ? undefined : next);
}

describe("seed data provenance", () => {
  it("marks system, probe, operator, and curated creator users as internal", async () => {
    const users = await prisma.user.findMany({
      where: {
        OR: [
          { id: { in: [
            "seed-system-creator",
            "seed-admin-user",
            "seed-dev-user",
            "seed-support-user",
            "seed-ops-user",
            "seed-analyst-user",
          ] } },
          { id: { startsWith: "seed-creator-" } },
        ],
      },
      select: { id: true, dataClass: true },
    });

    expect(users).toHaveLength(19);
    expect(new Set(users.map((user) => user.dataClass))).toEqual(new Set(["internal"]));
  });

  it("keeps curated cold-start content official without invented engagement", async () => {
    const characters = await prisma.character.findMany({
      where: { id: { in: [...curatedCharacterIds] } },
      select: {
        id: true,
        source: true,
        stats: {
          select: {
            likesCount: true,
            chatsCount: true,
          },
        },
      },
    });
    const collections = await prisma.mediaCollection.findMany({
      where: { id: { startsWith: "seed-collection-" } },
      select: { id: true, source: true },
    });
    const feedbackItems = await prisma.productFeedbackItem.findMany({
      where: { sourceKey: { not: null } },
      select: { sourceKey: true, voteCount: true },
      orderBy: { sourceKey: "asc" },
    });

    expect(characters).toHaveLength(16);
    expect(characters.every((character) => character.source === "official")).toBe(true);
    expect(
      characters.every(
        (character) =>
          character.stats?.likesCount === 0 && character.stats.chatsCount === 0,
      ),
    ).toBe(true);
    expect(collections).toHaveLength(3);
    expect(collections.every((collection) => collection.source === "official")).toBe(true);
    expect(feedbackItems).toEqual([
      { sourceKey: "chat-memory-review", voteCount: 0 },
      { sourceKey: "creator-collections", voteCount: 0 },
      { sourceKey: "generator-recipes", voteCount: 0 },
    ]);
  });

  it("only creates missing cold-start rows and preserves operator edits on repeat seed runs", async () => {
    const users = await seedFunctionSource("seedUsers");
    const characters = await seedFunctionSource("seedCharacters");
    const collections = await seedFunctionSource("seedCommunityCollections");
    const feedback = await seedFunctionSource("seedOfficialFeedbackItems");
    const plans = await seedFunctionSource("seedPlans");
    const presets = await seedFunctionSource("seedPresets");

    expect(users.slice(users.indexOf("const handles"))).toContain("update: {}");
    expect(characters).toMatch(/mediaAsset\.upsert\(\{[\s\S]*?update: \{\},/);
    expect(characters).toMatch(/character\.upsert\(\{[\s\S]*?update: \{\},/);
    expect(characters).toMatch(
      /characterStats\.upsert\(\{[\s\S]*?update: \{\},/,
    );
    expect(collections).not.toContain("mediaCollectionItem.deleteMany");
    expect(collections).toMatch(
      /mediaCollection\.upsert\(\{[\s\S]*?update: \{\},[\s\S]*?mediaCollectionItem\.createMany/,
    );
    expect(feedback).toMatch(
      /productFeedbackItem\.upsert\(\{[\s\S]*?update: \{\},/,
    );
    expect(plans).toMatch(/plan\.upsert\(\{[\s\S]*?update: \{\},/);
    expect(presets).toMatch(
      /generationPreset\.upsert\(\{[\s\S]*?update: \{\},/,
    );
  });
});
