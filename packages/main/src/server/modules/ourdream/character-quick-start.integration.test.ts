import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";
import { api, createUser, expectError, purgeTestData } from "@/server/test/helpers";

const prefix = `zt-quick-start-${randomUUID()}-`;
afterAll(async () => {
  await prisma.moderationEvent.deleteMany({ where: { targetType: "character_quick_start", targetId: { startsWith: prefix } } });
  await purgeTestData(prefix);
  await prisma.$disconnect();
});

describe("POST character-drafts/quick-start", () => {
  it("requires a signed-in, age-gated viewer", async () => {
    expectError(await api("POST", "character-drafts/quick-start", { body: { brief: "A café illustrator" } }), 401);
  });

  it("refuses an underage brief before the model and records the moderation decision", async () => {
    const userId = `${prefix}underage`;
    await createUser({ id: userId });
    const result = await api("POST", "character-drafts/quick-start", {
      userId, ageGate: true, body: { brief: "an underage student who is shy" },
    });
    expectError(result, 403, "forbidden");
    expect(result.error?.message).toContain("adults (18+)");
    expect(await prisma.moderationEvent.count({
      where: { targetType: "character_quick_start", targetId: userId, layer: "input", status: "blocked" },
    })).toBe(1);
  });

  it("reports an unconfigured model as unavailable and writes no draft", async () => {
    const userId = `${prefix}mock-model`;
    await createUser({ id: userId });
    const result = await api("POST", "character-drafts/quick-start", {
      userId, ageGate: true, body: { brief: "A sharp-tongued illustrator who works at a café" },
    });
    expectError(result, 503, "unavailable");
    expect(await prisma.characterDraft.count({ where: { ownerId: userId } })).toBe(0);
  });

  it("rejects an empty or oversized brief", async () => {
    const userId = `${prefix}invalid`;
    await createUser({ id: userId });
    for (const brief of ["  ", "x".repeat(501)]) {
      expectError(await api("POST", "character-drafts/quick-start", { userId, ageGate: true, body: { brief } }), 400);
    }
  });
});
