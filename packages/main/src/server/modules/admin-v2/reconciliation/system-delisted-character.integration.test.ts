import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";
import { auditAdminCutoverInvariants } from "./invariants";

// SPEC: 系统自己把角色移出目录之后，要么有人放回去，要么有人明确决定继续隐藏。
// INTENT: 这条下架是 `dispatchStaleReleaseRoutes` 的副作用（release-monitor.ts:174-195），
//         而此前没有任何一处会再提起它：Release 修好了就退出 Today 队列，
//         `live_public_current_release_not_ready` 只看 public 的角色——降级之后就不看了。
//         所以角色能一直躺在目录外，谁都不知道。
// INTENT: 两条用例是一对：先证明它真的会响（不然就是一条恒绿的摆设），
//         再证明运营做过可见性决定之后它会闭嘴（不然就是一条永远消不掉的噪音）。
describe("system-delisted Character invariant", () => {
  const suffix = randomUUID();
  const characterId = `delisted-character-${suffix}`;
  const projectId = `delisted-project-${suffix}`;
  const releaseId = `delisted-release-${suffix}`;
  const contentId = `delisted-content-${suffix}`;
  const servingId = `delisted-serving-${suffix}`;
  const actorId = `delisted-admin-${suffix}`;
  const delistedAt = new Date("2026-07-10T00:00:00.000Z");
  const now = new Date("2026-07-11T12:00:00.000Z");

  async function violation() {
    const report = await auditAdminCutoverInvariants(prisma, now);
    return report.checks.find((check) => check.key === "system_delisted_character_not_restored");
  }

  beforeAll(async () => {
    await prisma.user.create({
      data: { id: actorId, email: `${actorId}@example.test`, role: "admin", status: "active", dataClass: "internal" },
    });
    await prisma.character.create({
      data: {
        id: characterId,
        name: "Delisted by the route monitor",
        age: 27,
        description: "Healthy again, still off the catalog.",
        source: "official",
        status: "approved",
        // 这正是被测状态：系统降的级，没人改回来。
        visibility: "unlisted",
        appearance: {},
        advancedDetails: {},
      },
    });
    await prisma.characterProject.create({ data: { id: projectId, characterId } });
    await prisma.characterContentVersion.create({
      data: {
        id: contentId,
        characterId,
        version: 1,
        contentHash: `delisted-content-hash-${suffix}`,
        personaSnapshot: {},
        openingSnapshot: {},
        appearanceSnapshot: {},
        sourceType: "test",
      },
    });
    await prisma.characterRelease.create({
      data: {
        id: releaseId,
        projectId,
        revisionId: `delisted-revision-${suffix}`,
        characterContentVersionId: contentId,
        generationProvenance: {},
        releasePlacementManifest: {},
        snapshotHash: `delisted-snapshot-${suffix}`,
        // 角色本身已经健康了——线路问题是修好了的，欠的只有「放回目录」这一步。
        readiness: "ready",
        status: "published",
        publishedAt: new Date("2026-07-10T06:00:00.000Z"),
      },
    });
    await prisma.characterServing.create({
      data: { id: servingId, characterId, currentReleaseId: releaseId, state: "live" },
    });
    await prisma.characterReleaseEvent.create({
      data: {
        releaseId,
        characterId,
        type: "generation_route_qualification_stale",
        reason: "generation_profile_unavailable",
        fromState: { readiness: "ready" },
        // 判据就读这一个键：只有系统自己降的级才算。
        toState: { readiness: "stale", catalogVisibility: "unlisted" },
        evidence: {},
        occurredAt: delistedAt,
      },
    });
  });

  afterAll(async () => {
    await prisma.adminAuditLog.deleteMany({ where: { targetId: characterId } });
    await prisma.characterReleaseEvent.deleteMany({ where: { characterId } });
    await prisma.characterServing.deleteMany({ where: { id: servingId } });
    await prisma.characterRelease.deleteMany({ where: { id: releaseId } });
    await prisma.characterContentVersion.deleteMany({ where: { id: contentId } });
    await prisma.characterProject.deleteMany({ where: { id: projectId } });
    await prisma.character.deleteMany({ where: { id: characterId } });
    await prisma.user.deleteMany({ where: { id: actorId } });
    await prisma.$disconnect();
  });

  it("names the Character nobody put back", async () => {
    expect(await violation()).toMatchObject({
      status: "failed",
      sampleIds: expect.arrayContaining([characterId]),
    });
  });

  it("goes quiet once an operator has decided on the visibility", async () => {
    await prisma.adminAuditLog.create({
      data: {
        actorId,
        actorRole: "admin",
        action: "content.visibility.write",
        targetType: "character",
        targetId: characterId,
        reason: "Hide from Explore on purpose",
        before: { visibility: "unlisted" },
        after: { visibility: "unlisted" },
        createdAt: new Date(delistedAt.getTime() + 3_600_000),
      },
    });
    expect((await violation())?.sampleIds ?? []).not.toContain(characterId);
  });
});
