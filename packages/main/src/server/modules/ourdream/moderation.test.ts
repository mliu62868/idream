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

  it("never lets an unauthenticated request take content down", async () => {
    const ownerId = `${P}anon-owner`;
    const charId = `${P}char-anon-takedown`;
    await createUser({ id: ownerId });
    await createCharacter({
      id: charId,
      creatorId: ownerId,
      visibility: "public",
      status: "approved",
    });

    // No userId: the report channel stays open to anonymous reporters, but the
    // destructive action must not be reachable without credentials.
    const report = await api("POST", "reports", {
      body: {
        targetType: "character",
        targetId: charId,
        category: "underage_content",
      },
    });
    expectOk(report);
    expect(report.data.report.priority).toBe(1);

    await expect(
      prisma.character.findUniqueOrThrow({ where: { id: charId } }),
    ).resolves.toMatchObject({ status: "approved" });
    expect(
      await prisma.moderationReview.count({
        where: { reportId: report.data.report.id as string },
      }),
    ).toBe(0);
  });

  it("caps how many takedowns one reporter can trigger, and keeps triaging past the cap", async () => {
    const ownerId = `${P}cap-owner`;
    const reporterId = `${P}cap-reporter`;
    await createUser({ id: ownerId });
    await createUser({ id: reporterId });

    const ids = Array.from({ length: 5 }, (_, index) => `${P}char-cap-${index}`);
    for (const id of ids) {
      await createCharacter({
        id,
        creatorId: ownerId,
        visibility: "public",
        status: "approved",
      });
    }

    const statuses: string[] = [];
    for (const id of ids) {
      const report = await api("POST", `characters/${id}/report`, {
        userId: reporterId,
        ageGate: true,
        body: { category: "underage_content" },
      });
      expectOk(report);
      // Every report is still filed and triaged at priority 1, cap or not.
      expect(report.data.report.priority).toBe(1);
      const character = await prisma.character.findUniqueOrThrow({ where: { id } });
      statuses.push(character.status);
    }

    // A single free account cannot walk the whole catalog: the first few act,
    // the rest are withheld for human review.
    expect(statuses.filter((status) => status === "removed")).toHaveLength(3);
    expect(statuses.filter((status) => status === "approved")).toHaveLength(2);
  });

  it("leaves an appealable decision behind when it takes content down", async () => {
    const ownerId = `${P}appeal-owner`;
    const reporterId = `${P}appeal-reporter`;
    const charId = `${P}char-appealable`;
    await createUser({ id: ownerId });
    await createUser({ id: reporterId });
    await createCharacter({
      id: charId,
      creatorId: ownerId,
      visibility: "public",
      status: "approved",
    });

    const report = await api("POST", `characters/${charId}/report`, {
      userId: reporterId,
      ageGate: true,
      body: { category: "underage_content" },
    });
    expectOk(report);
    await expect(
      prisma.character.findUniqueOrThrow({ where: { id: charId } }),
    ).resolves.toMatchObject({ status: "removed" });

    // The appeal path resolves authority through a ModerationReview tied to the
    // report; without it the owner is taken down with no way to appeal.
    const appeal = await api("POST", "appeals", {
      userId: ownerId,
      ageGate: true,
      body: {
        targetType: "character",
        targetId: charId,
        appealText: "This character is an adult; please re-review.",
      },
    });
    expectOk(appeal);
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
