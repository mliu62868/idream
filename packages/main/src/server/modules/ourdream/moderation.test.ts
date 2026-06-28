import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";
import { api, createCharacter, createUser, expectOk, purgeTestData } from "@/server/test/helpers";

// SPEC: an "actioned"/underage takedown must actually remove content. Feed items
// wrap a character (id encoded as `character:<id>`), so reporting one as underage
// must hide the backing character — not silently mark the report handled.

const P = "zt-mod-";

beforeAll(async () => {
  await purgeTestData(P);
});

afterAll(async () => {
  await purgeTestData(P);
  await prisma.$disconnect();
});

describe("underage report auto-takedown", () => {
  it("removes the backing character when a feed_item is reported as underage", async () => {
    const ownerId = `${P}owner`;
    const reporterId = `${P}reporter`;
    const charId = `${P}char-feeditem`;
    await createUser({ id: ownerId });
    await createUser({ id: reporterId });
    await createCharacter({ id: charId, creatorId: ownerId, visibility: "public", status: "approved" });

    const report = await api("POST", "reports", {
      userId: reporterId,
      ageGate: true,
      body: {
        targetType: "feed_item",
        targetId: `character:${charId}`,
        category: "underage_content",
      },
    });
    expectOk(report);

    const character = await prisma.character.findUniqueOrThrow({ where: { id: charId } });
    expect(character.status).toBe("removed");
  });

  it("still records the report when an underage target can't be resolved", async () => {
    const reporterId = `${P}reporter2`;
    await createUser({ id: reporterId });

    // Unknown target type: auto-takedown can't act, but the priority-1 report must
    // still be created (and triaged) rather than failing the submission.
    const report = await api("POST", "reports", {
      userId: reporterId,
      ageGate: true,
      body: {
        targetType: "mystery_surface",
        targetId: `${P}whatever`,
        category: "underage_content",
      },
    });
    expectOk(report);
    expect(report.data.report.priority).toBe(1);
  });
});
