import {
  characterVoiceClipReclaimResponseSchema,
  type CharacterVoiceClipReclaimResponse,
} from "@idream/shared/admin";
import { Prisma } from "@prisma/client";
import { env } from "@/server/lib/env";
import { prisma } from "@/server/lib/db";
import {
  AppError,
  Errors,
  type AppErrorCode,
} from "@/server/lib/errors";
import {
  entitlementMap,
  readableCharacter,
} from "@/server/modules/ourdream/service";
import {
  reclaimExpiredVoiceClip,
  type VoiceClipSuccessCommit,
} from "@/server/modules/ourdream/voice-clip";
import type {
  AdminActor,
  AdminV2RequestBody,
} from "@/server/modules/admin-v2/shared/authority";
import { canonicalRequestHash } from "@/server/modules/admin-v2/shared/control-plane-command";
import {
  transitionControlPlaneCommand,
  updateControlPlaneCommandMetadata,
} from "@/server/modules/admin-v2/shared/control-plane-command-transition";
import { toInputJson } from "@/server/modules/admin-v2/shared/prisma-json";

const COMMAND_TYPE = "character.voice_clip.reclaim";

type ReservedCommand = {
  readonly commandId: string;
  readonly voiceRequestId: string;
  readonly leaseOwner: string | null;
  readonly leaseExpiresAt: Date | null;
  readonly attemptCount: number;
};

type CommandFailure = {
  readonly code: AppErrorCode;
  readonly message: string;
  readonly details?: unknown;
};

// SPEC: the body the manifest declares for this operation, already parsed by the route.
// INVARIANT: the schema already binds `confirmation` to the body's own `requestId`; the
// check below is the separate one it cannot make — body vs route path.
type VoiceClipReclaimRequest = AdminV2RequestBody<
  "characterVoiceClipReclaimRequestSchema+idempotency-key"
>;

export async function reclaimCharacterVoiceClip(input: {
  readonly characterId: string;
  readonly requestId: string;
  readonly actor: AdminActor;
  readonly idempotencyKey: string;
  readonly transportRequestId: string;
  readonly request: VoiceClipReclaimRequest;
}): Promise<CharacterVoiceClipReclaimResponse> {
  const request = input.request;
  if (request.requestId !== input.requestId) {
    throw Errors.badRequest("Request body and route identify different Voice requests");
  }
  const payload = {
    characterId: input.characterId,
    requestId: input.requestId,
    confirmation: request.confirmation,
    reason: request.reason,
  };
  const reservation = await reserveCommand({
    actor: input.actor,
    idempotencyKey: input.idempotencyKey,
    transportRequestId: input.transportRequestId,
    characterId: input.characterId,
    voiceRequestId: input.requestId,
    payload,
  });
  if (reservation.kind === "replay") return reservation.response;
  if (reservation.kind === "failure") {
    throw new AppError(
      reservation.failure.code,
      reservation.failure.message,
      reservation.failure.details,
    );
  }

  const onSuccessCommit: VoiceClipSuccessCommit = async (tx, terminal) => {
    const response = characterVoiceClipReclaimResponseSchema.parse({
      ...terminal,
      status: "succeeded",
      replayed: false,
    });
    await finalizeSuccessfulCommand(tx, {
      reservation: reservation.command,
      actor: input.actor,
      reason: request.reason,
      characterId: input.characterId,
      response,
    });
  };

  try {
    const reclaimed = await reclaimExpiredVoiceClip({
      characterId: input.characterId,
      requestId: input.requestId,
      deps: { entitlementMap, readableCharacter },
      onSuccessCommit,
    });
    const response = characterVoiceClipReclaimResponseSchema.parse({
      ...reclaimed,
      replayed: false,
    });
    if (reclaimed.status !== "succeeded") {
      await prisma.$transaction((tx) =>
        finalizeSuccessfulCommand(tx, {
          reservation: reservation.command,
          actor: input.actor,
          reason: request.reason,
          characterId: input.characterId,
          response,
        }),
      );
    }
    return response;
  } catch (cause) {
    await finalizeFailedCommand({
      reservation: reservation.command,
      actor: input.actor,
      reason: request.reason,
      characterId: input.characterId,
      cause,
    }).catch(() => undefined);
    throw cause;
  }
}

async function reserveCommand(input: {
  readonly actor: AdminActor;
  readonly idempotencyKey: string;
  readonly transportRequestId: string;
  readonly characterId: string;
  readonly voiceRequestId: string;
  readonly payload: {
    readonly characterId: string;
    readonly requestId: string;
    readonly confirmation: string;
    readonly reason: string;
  };
}): Promise<
  | { readonly kind: "owner"; readonly command: ReservedCommand }
  | {
      readonly kind: "replay";
      readonly response: CharacterVoiceClipReclaimResponse;
    }
  | { readonly kind: "failure"; readonly failure: CommandFailure }
> {
  const scope = `${env.APP_ENV}:${input.actor.id}`;
  const target = { type: "voice_clip_request", id: input.voiceRequestId };
  const requestHash = canonicalRequestHash({
    commandType: COMMAND_TYPE,
    target,
    payload: input.payload,
    retryMode: "idempotent",
  });
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`${scope}:${input.idempotencyKey}`}))`;
    const existing = await tx.controlPlaneCommand.findUnique({
      where: {
        scope_idempotencyKey: {
          scope,
          idempotencyKey: input.idempotencyKey,
        },
      },
    });
    if (existing) {
      if (
        existing.requestHash !== requestHash ||
        existing.commandType !== COMMAND_TYPE ||
        existing.targetType !== target.type ||
        existing.targetId !== target.id
      ) {
        throw Errors.conflict("Idempotency key is bound to another Voice reclaim", {
          existingRequestHash: existing.requestHash,
          submittedRequestHash: requestHash,
        });
      }
      if (existing.status === "succeeded" && existing.result) {
        const response = characterVoiceClipReclaimResponseSchema.parse({
          ...(existing.result as Record<string, unknown>),
          replayed: true,
        });
        return { kind: "replay" as const, response };
      }
      if (existing.status === "failed") {
        return {
          kind: "failure" as const,
          failure: parseStoredCommandFailure(existing.error, existing.id),
        };
      }
      const now = new Date();
      if (
        existing.status === "running" &&
        (!existing.leaseExpiresAt || existing.leaseExpiresAt <= now)
      ) {
        const voiceRequest = await tx.voiceClipRequest.findUnique({
          where: { id: input.voiceRequestId },
        });
        if (!voiceRequest || voiceRequest.characterId !== input.characterId) {
          throw Errors.conflict(
            "Voice reclaim receipt no longer matches its target request",
            { commandId: existing.id, requestId: input.voiceRequestId },
          );
        }
        if (["succeeded", "failed", "skipped"].includes(voiceRequest.status)) {
          const failure: CommandFailure = {
            code: "conflict",
            message:
              "Voice request reached a terminal state without an attributable reclaim receipt",
            details: {
              commandId: existing.id,
              requestId: voiceRequest.id,
              voiceStatus: voiceRequest.status,
              voiceAttemptNo: voiceRequest.attemptNo,
              reason: "voice_terminal_without_command_receipt",
            },
          };
          const persisted = await persistFailedCommand(tx, {
            reservation: {
              commandId: existing.id,
              voiceRequestId: voiceRequest.id,
              leaseOwner: existing.leaseOwner,
              leaseExpiresAt: existing.leaseExpiresAt,
              attemptCount: existing.attemptCount,
            },
            actor: input.actor,
            reason: input.payload.reason,
            characterId: input.characterId,
            failure,
          });
          if (!persisted) {
            throw Errors.conflict(
              "Voice reclaim command authority changed during crash repair",
              { commandId: existing.id },
            );
          }
          return { kind: "failure" as const, failure };
        }
        if (
          voiceRequest.status === "running" &&
          voiceRequest.leaseExpiresAt &&
          voiceRequest.leaseExpiresAt > now
        ) {
          throw Errors.conflict(
            "Voice synthesis is still running for this reclaim command",
            {
              commandId: existing.id,
              requestId: voiceRequest.id,
              leaseExpiresAt: voiceRequest.leaseExpiresAt.toISOString(),
              reason: "command_in_progress",
            },
          );
        }
        if (existing.attemptCount >= existing.maxAttempts) {
          throw Errors.conflict("Voice reclaim command exhausted its takeover budget", {
            commandId: existing.id,
            attempts: existing.attemptCount,
          });
        }
        const reclaimedCommand = await updateControlPlaneCommandMetadata(tx, {
          commandId: existing.id,
          expected: {
            from: "running",
            leaseOwner: existing.leaseOwner,
            leaseExpiresAt: existing.leaseExpiresAt,
            attemptCount: existing.attemptCount,
          },
          data: {
            requestId: input.transportRequestId,
            attemptCount: { increment: 1 },
            leaseOwner: `voice-reclaim:${input.transportRequestId}`,
            leaseExpiresAt: new Date(now.getTime() + 5 * 60_000),
            heartbeatAt: now,
          },
          onConflict: "return-null",
        });
        if (!reclaimedCommand) {
          throw Errors.conflict(
            "Voice reclaim command authority changed during takeover",
            { commandId: existing.id },
          );
        }
        return {
          kind: "owner" as const,
          command: {
            commandId: reclaimedCommand.id,
            voiceRequestId: input.voiceRequestId,
            leaseOwner: reclaimedCommand.leaseOwner,
            leaseExpiresAt: reclaimedCommand.leaseExpiresAt,
            attemptCount: reclaimedCommand.attemptCount,
          },
        };
      }
      throw Errors.conflict("Voice reclaim command is already terminal or in progress", {
        commandId: existing.id,
        status: existing.status,
        ...(existing.status === "running"
          ? { reason: "command_in_progress" }
          : {}),
      });
    }
    const command = await tx.controlPlaneCommand.create({
      data: {
        scope,
        idempotencyKey: input.idempotencyKey,
        commandType: COMMAND_TYPE,
        targetType: target.type,
        targetId: target.id,
        actorId: input.actor.id,
        requestId: input.transportRequestId,
        requestHash,
        requestPayload: toInputJson(input.payload),
        retryMode: "idempotent",
        status: "running",
        attemptCount: 1,
        maxAttempts: 3,
        leaseOwner: `voice-reclaim:${input.transportRequestId}`,
        leaseExpiresAt: new Date(Date.now() + 5 * 60_000),
        heartbeatAt: new Date(),
      },
    });
    return {
      kind: "owner" as const,
      command: {
        commandId: command.id,
        voiceRequestId: input.voiceRequestId,
        leaseOwner: command.leaseOwner,
        leaseExpiresAt: command.leaseExpiresAt,
        attemptCount: command.attemptCount,
      },
    };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

async function finalizeSuccessfulCommand(
  tx: Prisma.TransactionClient,
  input: {
    readonly reservation: ReservedCommand;
    readonly actor: AdminActor;
    readonly reason: string;
    readonly characterId: string;
    readonly response: CharacterVoiceClipReclaimResponse;
  },
) {
  const updated = await transitionControlPlaneCommand(tx, {
    commandId: input.reservation.commandId,
    to: "succeeded",
    expected: {
      from: "running",
      leaseOwner: input.reservation.leaseOwner,
      leaseExpiresAt: input.reservation.leaseExpiresAt,
      attemptCount: input.reservation.attemptCount,
    },
    data: {
      result: toInputJson(input.response),
      leaseOwner: null,
      leaseExpiresAt: null,
      heartbeatAt: new Date(),
      finishedAt: new Date(),
    },
    onConflict: "return-null",
  });
  if (!updated) {
    throw Errors.conflict("Voice reclaim command authority changed before commit", {
      commandId: input.reservation.commandId,
    });
  }
  await tx.adminAuditLog.create({
    data: {
      actorId: input.actor.id,
      actorRole: input.actor.role,
      action: "character.voice_clip.reclaimed",
      targetType: "voice_clip_request",
      targetId: input.response.requestId,
      reason: input.reason,
      before: toInputJson({
        characterId: input.characterId,
        status: "running",
        attemptNo: input.response.attemptNo - 1,
      }),
      after: toInputJson({
        characterId: input.characterId,
        status: input.response.status,
        attemptNo: input.response.attemptNo,
        mediaAssetId: input.response.mediaAssetId,
        provider: input.response.provider,
        commandId: input.reservation.commandId,
      }),
      requestId: input.reservation.commandId,
    },
  });
}

async function finalizeFailedCommand(input: {
  readonly reservation: ReservedCommand;
  readonly actor: AdminActor;
  readonly reason: string;
  readonly characterId: string;
  readonly cause: unknown;
}) {
  const failure = serializeCommandFailure(input.cause);
  await prisma.$transaction((tx) =>
    persistFailedCommand(tx, {
      reservation: input.reservation,
      actor: input.actor,
      reason: input.reason,
      characterId: input.characterId,
      failure,
    }),
  );
}

async function persistFailedCommand(
  tx: Prisma.TransactionClient,
  input: {
    readonly reservation: ReservedCommand;
    readonly actor: AdminActor;
    readonly reason: string;
    readonly characterId: string;
    readonly failure: CommandFailure;
  },
) {
  const updated = await transitionControlPlaneCommand(tx, {
    commandId: input.reservation.commandId,
    to: "failed",
    expected: {
      from: "running",
      leaseOwner: input.reservation.leaseOwner,
      leaseExpiresAt: input.reservation.leaseExpiresAt,
      attemptCount: input.reservation.attemptCount,
    },
    data: {
      error: toInputJson(input.failure),
      leaseOwner: null,
      leaseExpiresAt: null,
      heartbeatAt: new Date(),
      finishedAt: new Date(),
    },
    onConflict: "return-null",
  });
  if (!updated) return false;
  await tx.adminAuditLog.create({
    data: {
      actorId: input.actor.id,
      actorRole: input.actor.role,
      action: "character.voice_clip.reclaim_failed",
      targetType: "voice_clip_request",
      targetId: input.reservation.voiceRequestId,
      reason: input.reason,
      after: toInputJson({
        characterId: input.characterId,
        commandId: input.reservation.commandId,
        failure: input.failure,
      }),
      requestId: input.reservation.commandId,
    },
  });
  return true;
}

const appErrorCodes = new Set<AppErrorCode>([
  "bad_request",
  "unauthorized",
  "forbidden",
  "payment_required",
  "not_found",
  "gone",
  "conflict",
  "rate_limited",
  "unavailable",
  "internal",
]);

function serializeCommandFailure(cause: unknown): CommandFailure {
  if (cause instanceof AppError) {
    return {
      code: cause.code,
      message: cause.message,
      ...(cause.details === undefined ? {} : { details: cause.details }),
    };
  }
  return {
    code: "internal",
    message: cause instanceof Error ? cause.message : String(cause),
  };
}

function parseStoredCommandFailure(
  value: Prisma.JsonValue | null,
  commandId: string,
): CommandFailure {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, Prisma.JsonValue>;
    if (
      typeof record.code === "string" &&
      appErrorCodes.has(record.code as AppErrorCode) &&
      typeof record.message === "string"
    ) {
      return {
        code: record.code as AppErrorCode,
        message: record.message,
        ...(Object.hasOwn(record, "details")
          ? { details: record.details }
          : {}),
      };
    }
  }
  throw Errors.conflict("Voice reclaim command has an invalid failed receipt", {
    commandId,
    reason: "invalid_failed_command_receipt",
  });
}
