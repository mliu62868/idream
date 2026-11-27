import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { todayAllWorkQuerySchema, type TodayAllWorkQuery, type TodayProjection } from "@idream/shared/admin";
import { effectivePermissions } from "@/server/admin/effective-permissions";
import { resolvePermissions } from "@/server/admin/permissions";
import { prisma } from "@/server/lib/db";
import { claimTodayWorkItem } from "./claim";
import { updateOperationalWorkPreference } from "./preferences";
import { buildTodayAllWork, buildTodayProjection } from "./query";

function allWorkQuery(partial: Partial<TodayAllWorkQuery>): TodayAllWorkQuery {
  return todayAllWorkQuerySchema.parse(partial);
}

function creativeIds(queue: TodayProjection["myShift"]) {
  return queue.items.filter((item) => item.sourceType === "creative_run").map((item) => item.sourceId).sort();
}

/**
 * SPEC: a Character-scoped creative.run.* grant sees and claims, in Today, exactly the Creative
 *       Runs under its assigned Characters; a global grant sees what it always saw.
 */
describe("Today Creative Run character scope", () => {
  const suffix = randomUUID();
  const adminId = `today-scope-admin-${suffix}`;
  const creatorId = `today-scope-creator-${suffix}`;
  const characterA = `today-scope-character-a-${suffix}`;
  const characterB = `today-scope-character-b-${suffix}`;
  const runA1 = `today-scope-run-a1-${suffix}`; // assigned Character, unassigned owner
  const runA2 = `today-scope-run-a2-${suffix}`; // assigned Character, owned by the creator
  const runB = `today-scope-run-b-${suffix}`; // other Character
  const runOps = `today-scope-run-ops-${suffix}`; // no Character target
  const runAResolved = `today-scope-run-a-resolved-${suffix}`;
  const runBResolved = `today-scope-run-b-resolved-${suffix}`;
  const runIds = [runA1, runA2, runB, runOps, runAResolved, runBResolved];
  const mentionA = `today-scope-mention-a-${suffix}`;
  const mentionB = `today-scope-mention-b-${suffix}`;
  const commandA = `today-scope-command-a-${suffix}`;
  const commandB = `today-scope-command-b-${suffix}`;
  const hiddenIds = [runB, runOps, runBResolved, mentionB, commandB];
  const now = new Date();
  const overdue = new Date(now.getTime() - 60 * 60 * 1_000);
  const creator = { id: creatorId, role: "analyst" };
  const admin = { id: adminId, role: "admin" };

  function claimRequest(sourceId: string, entityVersion = 1) {
    return new Request("http://localhost/api/v2/admin/today/claim", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-idream-user-id": creatorId,
        "x-idream-role": "analyst",
        "idempotency-key": `today-scope-claim:${sourceId}`,
        "x-request-id": `today-scope-claim-${sourceId}`,
      },
      body: JSON.stringify({ sourceType: "creative_run", sourceId, entityVersion }),
    });
  }

  beforeAll(async () => {
    await prisma.user.createMany({ data: [
      { id: adminId, email: `${adminId}@example.test`, role: "admin", status: "active" },
      // INTENT: analyst gives dashboard.read and no creative.run.* of its own, so every Creative
      //         Run permission this actor holds comes from the Character-scoped bundle.
      { id: creatorId, email: `${creatorId}@example.test`, role: "analyst", status: "active" },
    ] });
    await prisma.adminUserGrantBundle.create({ data: {
      userId: creatorId,
      bundleKey: "character_creator",
      scope: { characterIds: [characterA] },
      reason: "Today creative scope fixture",
      createdById: adminId,
    } });
    const run = (id: string, data: Record<string, unknown>) => ({
      id,
      title: `Scope ${id}`,
      purpose: "character",
      presetIds: [],
      createdById: adminId,
      priority: "high",
      lifecycleState: "active",
      workflowStage: "review",
      ...data,
    });
    await prisma.contentProductionBatch.createMany({ data: [
      run(runA1, { targetType: "character", targetId: characterA, ownerId: null }),
      run(runA2, { targetType: "character", targetId: characterA, ownerId: creatorId, dueAt: overdue }),
      run(runB, { targetType: "character", targetId: characterB, ownerId: null }),
      run(runOps, { targetType: "campaign", targetId: `campaign-${suffix}`, ownerId: null, purpose: "campaign" }),
      run(runAResolved, { targetType: "character", targetId: characterA, lifecycleState: "closed", verificationState: "passed" }),
      run(runBResolved, { targetType: "character", targetId: characterB, lifecycleState: "closed", verificationState: "passed" }),
    ] });
    await prisma.adminCollaborationActivity.createMany({ data: [
      { id: mentionA, targetType: "creative_run", targetId: runA1, kind: "comment", actorId: adminId, body: "A", mentionedIds: [creatorId], metadata: {}, idempotencyKey: mentionA },
      { id: mentionB, targetType: "creative_run", targetId: runB, kind: "comment", actorId: adminId, body: "B", mentionedIds: [creatorId], metadata: {}, idempotencyKey: mentionB },
    ] });
    await prisma.controlPlaneCommand.createMany({ data: [
      [commandA, runA1],
      [commandB, runB],
    ].map(([id, targetId]) => ({
      id,
      scope: id,
      idempotencyKey: id,
      commandType: "creative.run.retry",
      targetType: "creative_run",
      targetId,
      actorId: creatorId,
      requestId: id,
      requestHash: id,
      status: "failed",
    })) });
    await prisma.operationalWorkPreference.createMany({ data: [
      { actorId: creatorId, sourceType: "creative_run", sourceId: runA1, watching: true },
      // A preference left over from before the scope narrowed must not resurface the Run.
      { actorId: creatorId, sourceType: "creative_run", sourceId: runB, watching: true, pinned: true },
      ...[runA1, runB, runOps, runAResolved, runBResolved].map((sourceId) => ({ actorId: adminId, sourceType: "creative_run", sourceId, pinned: true })),
    ] });
  });

  afterAll(async () => {
    await prisma.operationalWorkPreference.deleteMany({ where: { actorId: { in: [adminId, creatorId] } } });
    await prisma.controlPlaneCommand.deleteMany({ where: { actorId: creatorId } });
    await prisma.adminCollaborationActivity.deleteMany({ where: { actorId: adminId } });
    await prisma.mainOutboxEvent.deleteMany({ where: { aggregateId: { in: runIds } } });
    await prisma.adminAuditLog.deleteMany({ where: { actorId: { in: [adminId, creatorId] } } });
    await prisma.contentProductionBatch.deleteMany({ where: { id: { in: runIds } } });
    await prisma.adminUserGrantBundle.deleteMany({ where: { userId: creatorId } });
    await prisma.user.deleteMany({ where: { id: { in: [adminId, creatorId] } } });
    await prisma.$disconnect();
  });

  it("leaves a global grant's Today unchanged, including non-Character Runs", async () => {
    const permissions = resolvePermissions("admin");
    const projection = await buildTodayProjection({ actor: admin, permissions, now });
    expect(creativeIds(projection.unassigned)).toEqual(expect.arrayContaining([runA1, runB, runOps]));
    for (const id of [runA1, runB, runOps]) {
      expect(projection.unassigned.items.find((item) => item.sourceId === id)?.claim).toEqual({ entityVersion: 1 });
    }
    expect(creativeIds(projection.recentlyResolved)).toEqual(expect.arrayContaining([runAResolved, runBResolved]));

    const allWork = await buildTodayAllWork({ actor: admin, permissions, now, query: allWorkQuery({ domain: "creative_run", limit: 50 }) });
    expect(allWork.items.map((item) => item.sourceId)).toEqual(expect.arrayContaining([runA1, runA2, runB, runOps]));
    // Every active Run in the database, exactly as before scoping existed.
    await expect(prisma.contentProductionBatch.count({ where: { lifecycleState: "active" } })).resolves.toBe(allWork.totalCount);
  });

  it("shows a scoped creator only the Runs, mentions and commands of its assigned Characters", async () => {
    const permissions = await effectivePermissions(creatorId, "analyst");
    expect(permissions.has("creative.run.read")).toBe(true);
    const projection = await buildTodayProjection({ actor: creator, permissions, now });

    expect(creativeIds(projection.nextBestActions)).toEqual([runA1, runA2].sort());
    // 2 Runs + the command on runA1 + the mention on runA1.
    expect(projection.nextBestActions.totalCount).toBe(4);
    expect(projection.nextBestActions.items.map((item) => item.sourceId)).toEqual(expect.arrayContaining([commandA, mentionA]));
    expect(creativeIds(projection.myShift)).toEqual([runA2]);
    expect(projection.myShift.totalCount).toBe(3);
    expect(projection.unassigned.items.map((item) => item.sourceId)).toEqual([runA1]);
    expect(projection.unassigned.totalCount).toBe(1);
    expect(projection.unassigned.items[0]?.claim).toEqual({ entityVersion: 1 });
    expect(projection.recentlyResolved.items.map((item) => item.sourceId)).toEqual([runAResolved]);
    expect(projection.recentlyResolved.totalCount).toBe(1);
    expect(projection.watching.items.map((item) => item.sourceId)).toEqual([runA1]);
    expect(projection.watching.totalCount).toBe(1);

    const allWork = await buildTodayAllWork({ actor: creator, permissions, now, query: allWorkQuery({ domain: "creative_run", limit: 50 }) });
    expect(allWork.items.map((item) => item.sourceId).sort()).toEqual([runA1, runA2].sort());
    expect(allWork.totalCount).toBe(2);
    const everything = await buildTodayAllWork({ actor: creator, permissions, now, query: allWorkQuery({ limit: 50 }) });
    expect(everything.totalCount).toBe(4);
    expect(everything.items).toHaveLength(4);

    for (const body of [JSON.stringify(projection), JSON.stringify(allWork), JSON.stringify(everything)]) {
      for (const hidden of hiddenIds) expect(body).not.toContain(hidden);
    }
  });

  it("claims a Run under an assigned Character", async () => {
    await expect(claimTodayWorkItem(claimRequest(runA1))).resolves.toMatchObject({
      sourceType: "creative_run",
      sourceId: runA1,
      ownerId: creatorId,
      entityVersion: 2,
    });
    await expect(prisma.contentProductionBatch.findUniqueOrThrow({ where: { id: runA1 } })).resolves.toMatchObject({ ownerId: creatorId, version: 2 });
  });

  it("refuses to claim a Run outside the scope with the authority seam's 403 shape", async () => {
    await expect(claimTodayWorkItem(claimRequest(runB))).rejects.toMatchObject({
      status: 403,
      message: "Character is outside the effective permission scope",
      details: { permission: "creative.run.write", characterId: characterB },
    });
    await expect(claimTodayWorkItem(claimRequest(runOps))).rejects.toMatchObject({
      status: 403,
      message: "Character is outside the effective permission scope",
      details: { permission: "creative.run.write", characterId: null },
    });
    // An unknown Run does not reveal whether it exists.
    await expect(claimTodayWorkItem(claimRequest(`today-scope-missing-${suffix}`))).rejects.toMatchObject({
      status: 403,
      details: { permission: "creative.run.write", characterId: null },
    });
    const untouched = await prisma.contentProductionBatch.findMany({ where: { id: { in: [runB, runOps] } } });
    expect(untouched.map((row) => [row.ownerId, row.version])).toEqual([[null, 1], [null, 1]]);
    await expect(prisma.controlPlaneCommand.count({ where: { actorId: creatorId, commandType: "today.work.claim" } })).resolves.toBe(1);
  });

  it("accepts Creative Run preferences only inside the scope", async () => {
    const permissions = await effectivePermissions(creatorId, "analyst");
    const update = (sourceType: "creative_run" | "control_plane_command" | "collaboration_mention", sourceId: string, expectedVersion: number) =>
      updateOperationalWorkPreference({
        actor: creator,
        permissions,
        sourceType,
        sourceId,
        pinned: true,
        requestId: `today-scope-pref-${sourceId}`,
        expectedVersion,
      });

    await expect(update("creative_run", runA1, 1)).resolves.toMatchObject({ sourceId: runA1, pinned: true });
    await expect(update("collaboration_mention", mentionA, 0)).resolves.toMatchObject({ sourceId: mentionA, pinned: true });
    await expect(update("control_plane_command", commandA, 0)).resolves.toMatchObject({ sourceId: commandA, pinned: true });
    for (const [sourceType, sourceId, characterId] of [
      ["creative_run", runB, characterB],
      ["creative_run", runOps, null],
      ["collaboration_mention", mentionB, characterB],
      ["control_plane_command", commandB, characterB],
    ] as const) {
      await expect(update(sourceType, sourceId, 0)).rejects.toMatchObject({
        status: 403,
        details: { permission: "creative.run.read", characterId },
      });
    }
  });
});
