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
});
