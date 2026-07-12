import type { PrismaClient } from "@prisma/client";
import { acceptControlPlaneCommand } from "../shared/control-plane-command";

export const CHARACTER_RELEASE_SCHEDULER_ACTOR_ID =
  "system:character-release-scheduler";

// inactive supports the first scheduled Release; paused is deliberately held
// until an operator resumes Serving, and retired is terminal.
const DISPATCHABLE_SERVING_STATES = ["inactive", "live"] as const;

interface DispatchDueCharacterReleasePublishesInput {
  readonly dispatcherId: string;
  readonly environment?: string;
  readonly now?: Date;
  readonly limit?: number;
}

interface DispatchedScheduledReleaseCommand {
  readonly commandId: string;
  readonly releaseId: string;
  readonly replayed: boolean;
}

function scheduleOccurrenceKey(input: {
  readonly servingId: string;
  readonly servingVersion: number;
  readonly releaseId: string;
  readonly scheduledAt: Date;
}) {
  return [
    "character-release-due",
    input.servingId,
    input.servingVersion,
    input.releaseId,
    input.scheduledAt.getTime(),
  ].join(":");
}

export async function dispatchDueCharacterReleasePublishes(
  db: PrismaClient,
  input: DispatchDueCharacterReleasePublishesInput,
) {
  const now = input.now ?? new Date();
  const environment =
    input.environment ??
    process.env.APP_ENV ??
    process.env.NODE_ENV ??
    "development";
  const due = await db.characterServing.findMany({
    where: {
      state: { in: [...DISPATCHABLE_SERVING_STATES] },
      scheduledReleaseId: { not: null },
      scheduledAt: { lte: now },
    },
    orderBy: [{ scheduledAt: "asc" }, { id: "asc" }],
    take: Math.min(100, Math.max(1, input.limit ?? 25)),
    select: {
      id: true,
      version: true,
      scheduledAt: true,
      scheduledRelease: { select: { id: true, version: true } },
    },
  });

  let accepted = 0;
  let replayed = 0;
  const commands: DispatchedScheduledReleaseCommand[] = [];
  const failures: Array<{
    servingId: string;
    releaseId: string;
    error: string;
  }> = [];
  for (const serving of due) {
    const release = serving.scheduledRelease;
    const scheduledAt = serving.scheduledAt;
    if (!release || !scheduledAt) continue;
    const idempotencyKey = scheduleOccurrenceKey({
      servingId: serving.id,
      servingVersion: serving.version,
      releaseId: release.id,
      scheduledAt,
    });
    try {
      const result = await acceptControlPlaneCommand(db, {
        environment,
        actor: { id: CHARACTER_RELEASE_SCHEDULER_ACTOR_ID, role: "system" },
        idempotencyKey,
        commandType: "character.release.publish",
        target: { type: "character_release", id: release.id },
        expectedVersion: release.version,
        payload: {
          trigger: "scheduled_release_due",
          scheduledRelease: {
            servingId: serving.id,
            servingVersion: serving.version,
            releaseId: release.id,
            scheduledAt: scheduledAt.toISOString(),
          },
          reason: {
            code: "scheduled_release_due",
            summary: "Publish the due scheduled Character Release",
            details: `Scheduled for ${scheduledAt.toISOString()}`,
          },
        },
        retryMode: "idempotent",
        reason: "Due Character Release accepted by the durable scheduler",
        requestId: `${input.dispatcherId}:${idempotencyKey}`,
      });
      if (result.replayed) replayed += 1;
      else accepted += 1;
      commands.push({
        commandId: result.commandId,
        releaseId: release.id,
        replayed: result.replayed,
      });
    } catch (error) {
      failures.push({
        servingId: serving.id,
        releaseId: release.id,
        error: error instanceof Error ? error.message : "Unknown dispatcher error",
      });
    }
  }
  return {
    examined: due.length,
    accepted,
    replayed,
    failed: failures.length,
    commands,
    failures,
  };
}
