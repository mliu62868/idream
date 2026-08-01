import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { POST as pauseServing } from "@/app/api/v2/admin/characters/[id]/commands/pause/route";
import { POST as resumeServing } from "@/app/api/v2/admin/characters/[id]/commands/resume/route";
import { POST as publishRelease } from "@/app/api/v2/admin/characters/[id]/releases/[releaseId]/commands/publish/route";
import { POST as rollbackRelease } from "@/app/api/v2/admin/characters/[id]/releases/[releaseId]/commands/rollback/route";
import { POST as scheduleRelease } from "@/app/api/v2/admin/characters/[id]/releases/[releaseId]/commands/schedule/route";
import { prisma } from "@/server/lib/db";
import { CHARACTER_RELEASE_POLICY_VERSION } from "@/server/modules/admin-v2/characters/release-executor";

describe("Character authoritative command replay before mutable preflight", () => {
  const suffix = randomUUID();
  const actorId = `character-command-replay-admin-${suffix}`;
  const publishCharacterId = `character-command-replay-publish-${suffix}`;
  const publishProjectId = `character-command-replay-publish-project-${suffix}`;
  const publishReleaseId = `character-command-replay-publish-release-${suffix}`;
  const scheduleCharacterId = `character-command-replay-schedule-${suffix}`;
  const scheduleProjectId = `character-command-replay-schedule-project-${suffix}`;
  const scheduleReleaseId = `character-command-replay-schedule-release-${suffix}`;
  const rollbackCharacterId = `character-command-replay-rollback-${suffix}`;
  const rollbackProjectId = `character-command-replay-rollback-project-${suffix}`;
  const rollbackSourceReleaseId = `character-command-replay-rollback-source-${suffix}`;
  const rollbackCurrentReleaseId = `character-command-replay-rollback-current-${suffix}`;
  const servingCharacterId = `character-command-replay-serving-${suffix}`;
  const servingProjectId = `character-command-replay-serving-project-${suffix}`;
  const servingReleaseId = `character-command-replay-serving-release-${suffix}`;

  function request(input: {
    readonly entityVersion: number;
    readonly confirmation: string;
    readonly key: string;
    readonly scheduledAt?: string;
    readonly reasonSummary?: string;
  }) {
    const [characterId, releaseIdOrAction, releaseAction] = input.confirmation.split(":");
    const action = releaseAction ?? releaseIdOrAction;
    const pathname = releaseAction
      ? `/api/v2/admin/characters/${characterId}/releases/${releaseIdOrAction}/commands/${action}`
      : `/api/v2/admin/characters/${characterId}/commands/${action}`;
    return new Request(`http://localhost${pathname}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-idream-user-id": actorId,
        "x-idream-role": "admin",
        "idempotency-key": input.key,
        "if-match": `"${input.entityVersion}"`,
        "x-request-id": randomUUID(),
      },
      body: JSON.stringify({
        entityVersion: input.entityVersion,
        ...(input.scheduledAt ? { scheduledAt: input.scheduledAt } : {}),
        reason: {
          code: "response_loss_replay",
          summary:
            input.reasonSummary ??
            "Replay the exact accepted Character command",
        },
        confirmation: input.confirmation,
      }),
    });
  }

  async function commandId(response: Response) {
    const body = await response.json() as {
      data: { commandId: string };
    };
    expect(response.status, JSON.stringify(body)).toBe(202);
    return body.data.commandId;
  }

  beforeAll(async () => {
    await prisma.user.create({
      data: {
        id: actorId,
        email: `${actorId}@example.test`,
        role: "admin",
        status: "active",
      },
    });
    await prisma.character.createMany({
      data: [
        {
          id: publishCharacterId,
          name: "Publish replay Character",
          age: 28,
          description: "Exercises exact publish command replay.",
          systemPrompt: "Stay in persona.",
          source: "official",
          status: "approved",
          visibility: "private",
          appearance: {},
          advancedDetails: {},
        },
        {
          id: scheduleCharacterId,
          name: "Schedule replay Character",
          age: 29,
          description: "Exercises exact schedule command replay.",
          systemPrompt: "Stay in persona.",
          source: "official",
          status: "approved",
          visibility: "private",
          appearance: {},
          advancedDetails: {},
        },
        {
          id: rollbackCharacterId,
          name: "Rollback replay Character",
          age: 30,
          description: "Exercises exact rollback command replay.",
          systemPrompt: "Stay in persona.",
          source: "official",
          status: "approved",
          visibility: "public",
          appearance: {},
          advancedDetails: {},
        },
        {
          id: servingCharacterId,
          name: "Serving replay Character",
          age: 31,
          description: "Exercises exact serving command replay.",
          systemPrompt: "Stay in persona.",
          source: "official",
          status: "approved",
          visibility: "public",
          appearance: {},
          advancedDetails: {},
        },
      ],
    });
    await prisma.characterProject.createMany({
      data: [
        {
          id: publishProjectId,
          characterId: publishCharacterId,
          phase: "launch_ready",
          audience: {},
          successCriteria: ["publish replay"],
        },
        {
          id: scheduleProjectId,
          characterId: scheduleCharacterId,
          phase: "launch_ready",
          audience: {},
          successCriteria: ["schedule replay"],
        },
        {
          id: rollbackProjectId,
          characterId: rollbackCharacterId,
          phase: "live_management",
          audience: {},
          successCriteria: ["rollback replay"],
        },
        {
          id: servingProjectId,
          characterId: servingCharacterId,
          phase: "live_management",
          audience: {},
          successCriteria: ["serving replay"],
        },
      ],
    });
    await prisma.characterRelease.createMany({
      data: [
        {
          id: publishReleaseId,
          projectId: publishProjectId,
          revisionId: `${publishReleaseId}-revision`,
          characterContentVersionId: `${publishReleaseId}-content`,
          generationProvenance: {},
          releasePlacementManifest: {},
          snapshotHash: `${publishReleaseId}-snapshot`,
          status: "approved",
          version: 3,
        },
        {
          id: scheduleReleaseId,
          projectId: scheduleProjectId,
          revisionId: `${scheduleReleaseId}-revision`,
          characterContentVersionId: `${scheduleReleaseId}-content`,
          generationProvenance: {},
          releasePlacementManifest: {},
          snapshotHash: `${scheduleReleaseId}-snapshot`,
          status: "approved",
          version: 4,
        },
        {
          id: rollbackSourceReleaseId,
          projectId: rollbackProjectId,
          revisionId: `${rollbackSourceReleaseId}-revision`,
          characterContentVersionId: `${rollbackSourceReleaseId}-content`,
          generationProvenance: {},
          releasePlacementManifest: {},
          snapshotHash: `${rollbackSourceReleaseId}-snapshot`,
          status: "superseded",
          version: 2,
        },
        {
          id: rollbackCurrentReleaseId,
          projectId: rollbackProjectId,
          revisionId: `${rollbackCurrentReleaseId}-revision`,
          characterContentVersionId: `${rollbackCurrentReleaseId}-content`,
          generationProvenance: {},
          releasePlacementManifest: {},
          snapshotHash: `${rollbackCurrentReleaseId}-snapshot`,
          status: "published",
          version: 1,
        },
        {
          id: servingReleaseId,
          projectId: servingProjectId,
          revisionId: `${servingReleaseId}-revision`,
          characterContentVersionId: `${servingReleaseId}-content`,
          generationProvenance: {},
          releasePlacementManifest: {},
          snapshotHash: `${servingReleaseId}-snapshot`,
          status: "published",
          version: 1,
        },
      ],
    });
    await prisma.releaseValidationRun.create({
      data: {
        releaseId: publishReleaseId,
        snapshotHash: `${publishReleaseId}-snapshot`,
        policyVersion: CHARACTER_RELEASE_POLICY_VERSION,
        result: "passed",
        finishedAt: new Date(),
      },
    });
    await prisma.characterServing.createMany({
      data: [
        {
          id: `${rollbackCharacterId}-serving`,
          characterId: rollbackCharacterId,
          currentReleaseId: rollbackCurrentReleaseId,
          state: "live",
          version: 5,
        },
        {
          id: `${servingCharacterId}-serving`,
          characterId: servingCharacterId,
          currentReleaseId: servingReleaseId,
          state: "live",
          version: 1,
        },
      ],
    });
  });

  afterAll(async () => {
    const commands = await prisma.controlPlaneCommand.findMany({
      where: { actorId },
      select: { id: true },
    });
    const commandIds = commands.map((command) => command.id);
    await prisma.controlPlaneCommandAttempt.deleteMany({
      where: { commandId: { in: commandIds } },
    });
    await prisma.controlPlaneCommand.deleteMany({
      where: { id: { in: commandIds } },
    });
    await prisma.releaseValidationRun.deleteMany({
      where: { releaseId: publishReleaseId },
    });
    await prisma.characterServing.deleteMany({
      where: {
        characterId: {
          in: [rollbackCharacterId, servingCharacterId],
        },
      },
    });
    await prisma.characterRelease.deleteMany({
      where: {
        projectId: {
          in: [
            publishProjectId,
            scheduleProjectId,
            rollbackProjectId,
            servingProjectId,
          ],
        },
      },
    });
    await prisma.characterProject.deleteMany({
      where: {
        id: {
          in: [
            publishProjectId,
            scheduleProjectId,
            rollbackProjectId,
            servingProjectId,
          ],
        },
      },
    });
    await prisma.character.deleteMany({
      where: {
        id: {
          in: [
            publishCharacterId,
            scheduleCharacterId,
            rollbackCharacterId,
            servingCharacterId,
          ],
        },
      },
    });
    await prisma.user.delete({ where: { id: actorId } });
  });

  it("replays Publish after Release state and version drift", async () => {
    const key = randomUUID();
    const firstId = await commandId(await publishRelease(
      request({
        entityVersion: 3,
        confirmation: `${publishCharacterId}:${publishReleaseId}:publish`,
        key,
      }),
      {
        params: Promise.resolve({
          id: publishCharacterId,
          releaseId: publishReleaseId,
        }),
      },
    ));
    await prisma.characterRelease.update({
      where: { id: publishReleaseId },
      data: { status: "published", version: 9 },
    });
    const replayId = await commandId(await publishRelease(
      request({
        entityVersion: 3,
        confirmation: `${publishCharacterId}:${publishReleaseId}:publish`,
        key,
      }),
      {
        params: Promise.resolve({
          id: publishCharacterId,
          releaseId: publishReleaseId,
        }),
      },
    ));
    expect(replayId).toBe(firstId);
  });

  it("replays Schedule before mutable time/state checks and rejects changed scheduledAt", async () => {
    const key = randomUUID();
    const scheduledAt = new Date(Date.now() + 3_600_000).toISOString();
    const firstId = await commandId(await scheduleRelease(
      request({
        entityVersion: 4,
        confirmation: `${scheduleCharacterId}:${scheduleReleaseId}:schedule`,
        key,
        scheduledAt,
      }),
      {
        params: Promise.resolve({
          id: scheduleCharacterId,
          releaseId: scheduleReleaseId,
        }),
      },
    ));
    await prisma.characterRelease.update({
      where: { id: scheduleReleaseId },
      data: { status: "scheduled", version: 8 },
    });
    const replayId = await commandId(await scheduleRelease(
      request({
        entityVersion: 4,
        confirmation: `${scheduleCharacterId}:${scheduleReleaseId}:schedule`,
        key,
        scheduledAt,
      }),
      {
        params: Promise.resolve({
          id: scheduleCharacterId,
          releaseId: scheduleReleaseId,
        }),
      },
    ));
    expect(replayId).toBe(firstId);

    const changed = await scheduleRelease(
      request({
        entityVersion: 4,
        confirmation: `${scheduleCharacterId}:${scheduleReleaseId}:schedule`,
        key,
        scheduledAt: new Date(Date.now() + 7_200_000).toISOString(),
      }),
      {
        params: Promise.resolve({
          id: scheduleCharacterId,
          releaseId: scheduleReleaseId,
        }),
      },
    );
    expect(changed.status).toBe(409);
    await expect(changed.json()).resolves.toMatchObject({
      error: { code: "idempotency_conflict" },
    });
  });

  it("replays Rollback after Serving authority drift", async () => {
    const key = randomUUID();
    const firstId = await commandId(await rollbackRelease(
      request({
        entityVersion: 5,
        confirmation: `${rollbackCharacterId}:${rollbackSourceReleaseId}:rollback`,
        key,
      }),
      {
        params: Promise.resolve({
          id: rollbackCharacterId,
          releaseId: rollbackSourceReleaseId,
        }),
      },
    ));
    await prisma.characterServing.update({
      where: { characterId: rollbackCharacterId },
      data: {
        currentReleaseId: rollbackSourceReleaseId,
        version: 10,
      },
    });
    const replayId = await commandId(await rollbackRelease(
      request({
        entityVersion: 5,
        confirmation: `${rollbackCharacterId}:${rollbackSourceReleaseId}:rollback`,
        key,
      }),
      {
        params: Promise.resolve({
          id: rollbackCharacterId,
          releaseId: rollbackSourceReleaseId,
        }),
      },
    ));
    expect(replayId).toBe(firstId);
  });

  it("replays Serving actions after state drift and rejects the same key for another action", async () => {
    const key = randomUUID();
    const firstId = await commandId(await pauseServing(
      request({
        entityVersion: 1,
        confirmation: `${servingCharacterId}:pause`,
        key,
      }),
      { params: Promise.resolve({ id: servingCharacterId }) },
    ));
    await prisma.characterServing.update({
      where: { characterId: servingCharacterId },
      data: { state: "paused", version: 2 },
    });
    const replayId = await commandId(await pauseServing(
      request({
        entityVersion: 1,
        confirmation: `${servingCharacterId}:pause`,
        key,
      }),
      { params: Promise.resolve({ id: servingCharacterId }) },
    ));
    expect(replayId).toBe(firstId);

    const changedAction = await resumeServing(
      request({
        entityVersion: 1,
        confirmation: `${servingCharacterId}:resume`,
        key,
      }),
      { params: Promise.resolve({ id: servingCharacterId }) },
    );
    expect(changedAction.status).toBe(409);
    await expect(changedAction.json()).resolves.toMatchObject({
      error: { code: "idempotency_conflict" },
    });
  });
});
