import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { characterWorkspaceDetailSchema } from "@idream/shared/admin";
import { prisma } from "@/server/lib/db";
import { POST as refreshReleaseMonitor } from "@/app/api/v2/admin/characters/[id]/releases/[releaseId]/monitors/[window]/refresh/route";
import { GET as getCharacterWorkspaceRoute } from "@/app/api/v2/admin/characters/[id]/route";
import { getCharacterWorkspace, updateCharacterProjectDraft } from "./workspace";

describe("Character operator workspace", () => {
  const suffix = randomUUID();
  const characterId = `workspace-character-${suffix}`;
  const projectId = `workspace-project-${suffix}`;
  const contentId = `workspace-content-${suffix}`;
  const revisionId = `workspace-revision-${suffix}`;
  const releaseId = `workspace-release-${suffix}`;
  const requestId = `workspace-request-${suffix}`;
  const readOnlyActorId = `workspace-readonly-${suffix}`;

  beforeAll(async () => {
    await prisma.user.create({ data: { id: readOnlyActorId, email: `${readOnlyActorId}@example.test`, role: "user" } });
    await prisma.adminUserPermission.create({
      data: {
        userId: readOnlyActorId,
        permissionKey: "character.release.read",
        effect: "grant",
        reason: "Verify monitor refresh remains a review-only command",
        createdById: readOnlyActorId,
      },
    });
    await prisma.adminUserPermission.create({
      data: {
        userId: readOnlyActorId,
        permissionKey: "character.project.read",
        effect: "grant",
        reason: "Verify composite workspace requires every exposed authority permission",
        createdById: readOnlyActorId,
      },
    });
    await prisma.character.create({
      data: {
        id: characterId,
        name: "Mara",
        age: 28,
        description: "A precise, grounded evening companion.",
        source: "official",
        appearance: {},
        advancedDetails: { firstMessage: "You made it. What do you need to put down tonight?" },
      },
    });
    await prisma.characterProject.create({
      data: {
        id: projectId,
        characterId,
        phase: "qa",
        audience: {
          audience: "People decompressing after demanding work",
          companionNeed: "A reliable transition out of work mode",
          targetPlacementKeys: ["feed_card"],
        },
        hypothesis: "Specific openings improve qualified conversation",
        differentiation: "Calm direction without generic affirmation",
        successCriteria: ["QCE improves without D7 regression"],
        activeKey: `workspace:${suffix}`,
      },
    });
    await prisma.characterContentVersion.create({
      data: {
        id: contentId,
        characterId,
        version: 1,
        contentHash: `workspace-hash-${suffix}`,
        personaSnapshot: { name: "Mara", description: "A precise, grounded evening companion." },
        openingSnapshot: { firstMessage: "You made it." },
        appearanceSnapshot: { style: "realistic" },
        sourceType: "workspace_test",
      },
    });
    await prisma.characterRevision.create({
      data: {
        id: revisionId,
        projectId,
        revision: 1,
        characterContentVersionId: contentId,
        projectSnapshot: {},
      },
    });
    await prisma.characterRelease.create({
      data: {
        id: releaseId,
        projectId,
        revisionId,
        characterContentVersionId: contentId,
        generationProvenance: {},
        releasePlacementManifest: {},
        snapshotHash: `workspace-snapshot-${suffix}`,
        readiness: "blocked",
        status: "draft",
      },
    });
    await prisma.characterServing.create({
      data: { id: `workspace-serving-${suffix}`, characterId, state: "inactive" },
    });
  });

  afterAll(async () => {
    await prisma.adminUserPermission.deleteMany({ where: { userId: readOnlyActorId } });
    await prisma.mainOutboxEvent.deleteMany({ where: { aggregateId: projectId } });
    await prisma.adminAuditLog.deleteMany({ where: { requestId } });
    await prisma.characterServing.deleteMany({ where: { characterId } });
    await prisma.characterRelease.deleteMany({ where: { projectId } });
    await prisma.characterRevision.deleteMany({ where: { projectId } });
    await prisma.characterContentVersion.deleteMany({ where: { characterId } });
    await prisma.characterProject.deleteMany({ where: { id: projectId } });
    await prisma.character.deleteMany({ where: { id: characterId } });
    await prisma.user.deleteMany({ where: { id: readOnlyActorId } });
    await prisma.$disconnect();
  });

  it("returns a truthful draft preview and incomplete release evidence", async () => {
    const detail = characterWorkspaceDetailSchema.parse(await getCharacterWorkspace(characterId));
    expect(detail.preview).toMatchObject({
      live: null,
      draft: { label: "Draft Preview", contentVersionId: contentId, releaseId },
      changedFields: ["new_release"],
    });
    expect(detail.releases[0]).toMatchObject({ release: { readiness: "blocked" }, checks: [], monitors: [] });
  });

  it("autosaves with optimistic concurrency and writes audit/outbox atomically", async () => {
    const saved = await updateCharacterProjectDraft({
      characterId,
      expectedVersion: 1,
      actor: { id: `workspace-actor-${suffix}`, role: "admin" },
      phase: "launch_ready",
      ownerId: null,
      audience: "People decompressing after demanding work",
      companionNeed: "A reliable transition out of work mode",
      hypothesis: "A more specific opening improves qualified conversation",
      differentiation: "Calm direction without generic affirmation",
      targetPlacementKeys: ["feed_card"],
      successCriteria: ["QCE improves without D7 regression"],
      plannedLaunchAt: null,
      reason: "Autosave Character Project changes",
      requestId,
    });
    expect(saved).toMatchObject({ phase: "launch_ready", version: 2 });
    expect(await prisma.adminAuditLog.count({ where: { requestId } })).toBe(1);
    expect(await prisma.mainOutboxEvent.count({ where: { aggregateId: projectId } })).toBe(1);

    await expect(updateCharacterProjectDraft({
      characterId,
      expectedVersion: 1,
      actor: { id: `workspace-actor-${suffix}`, role: "admin" },
      phase: "retired",
      ownerId: null,
      audience: "stale",
      companionNeed: "stale",
      hypothesis: "stale",
      differentiation: "stale",
      targetPlacementKeys: [],
      successCriteria: ["stale"],
      plannedLaunchAt: null,
      reason: "Stale tab save",
      requestId: `${requestId}-conflict`,
    })).rejects.toMatchObject({ status: 409 });
    expect(await prisma.characterProject.findUniqueOrThrow({ where: { id: projectId } })).toMatchObject({
      phase: "launch_ready",
      version: 2,
    });
  });

  it("does not let a read-only release grant refresh monitor authority", async () => {
    const response = await refreshReleaseMonitor(
      new Request(`http://localhost/api/v2/admin/characters/${characterId}/releases/${releaseId}/monitors/24h/refresh`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-idream-user-id": readOnlyActorId,
          "x-idream-role": "user",
        },
        body: JSON.stringify({ entityVersion: 1 }),
      }),
      { params: Promise.resolve({ id: characterId, releaseId, window: "24h" }) },
    );
    expect(response.status).toBe(403);
  });

  it("does not expose Release, Monitor, or Performance DTOs through project-only access", async () => {
    const response = await getCharacterWorkspaceRoute(
      new Request(`http://localhost/api/v2/admin/characters/${characterId}`, {
        headers: { "x-idream-user-id": readOnlyActorId, "x-idream-role": "user" },
      }),
      { params: Promise.resolve({ id: characterId }) },
    );
    expect(response.status).toBe(403);
  });
});
