import {
  adminRecoverableMutationCommandTypeSchema,
  adminMutationRecoveryRequestSchema,
  adminMutationRecoveryResultSchema,
  type AdminRecoverableMutationCommandType,
  type AdminMutationRecoveryRequest,
} from "@idream/shared/admin";
import { Prisma } from "@prisma/client";
import { env } from "@/server/lib/env";
import { prisma } from "@/server/lib/db";
import { Errors } from "@/server/lib/errors";
import type { PermissionKey } from "@/server/admin/permissions";
import {
  authenticatedAdminActor,
  jsonBody,
  requireActorPermission,
} from "./authority";
import { canonicalSha256 } from "./canonical-json";
import { requireIdempotencyKey } from "./idempotency";
import {
  isSerializableWriteConflict,
  isUniqueConstraintConflict,
} from "./prisma-transaction-conflict";
import { toInputJson } from "./prisma-json";

type RecoveryConfiguration = {
  readonly permission: PermissionKey;
  readonly scope: (actorId: string) => string;
  readonly tombstoneTargetType: string;
};

const recoveryConfiguration = {
  "creative.run.create": {
    permission: "creative.run.write",
    scope: (actorId) => `${env.APP_ENV}:${actorId}:creative.run.create`,
    tombstoneTargetType: "creative_run",
  },
  "character.project.create": {
    permission: "character.project.write",
    scope: (actorId) => `${env.APP_ENV}:${actorId}:character.project.create`,
    tombstoneTargetType: "character_project",
  },
  "creative.review.decision": {
    permission: "creative.run.review",
    scope: (actorId) => `${env.APP_ENV}:${actorId}`,
    tombstoneTargetType: "creative_run",
  },
  "character.identity.bootstrap": {
    permission: "character.project.write",
    scope: (actorId) => `${env.APP_ENV}:${actorId}`,
    tombstoneTargetType: "character",
  },
  "character.project.draft_image.select": {
    permission: "character.project.write",
    scope: (actorId) => `${env.APP_ENV}:${actorId}`,
    tombstoneTargetType: "character",
  },
} satisfies Record<
  AdminRecoverableMutationCommandType,
  RecoveryConfiguration
>;

function record(value: Prisma.JsonValue | null) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, Prisma.JsonValue>
    : {};
}

function stringField(
  value: Prisma.JsonValue | null,
  field: string,
) {
  const candidate = record(value)[field];
  return typeof candidate === "string" && candidate.length > 0
    ? candidate
    : null;
}

function expectedCharacterId(
  body: AdminMutationRecoveryRequest,
) {
  switch (body.commandType) {
    case "creative.run.create":
    case "character.identity.bootstrap":
    case "character.project.draft_image.select":
      return body.expectedCharacterId ?? null;
    case "character.project.create":
    case "creative.review.decision":
      return null;
  }
}

function expectedCreativeRunPurpose(
  body: AdminMutationRecoveryRequest,
) {
  return body.commandType === "creative.run.create"
    ? body.expectedPurpose ?? null
    : null;
}

function selectedPurpose(
  value: Prisma.JsonValue | null,
) {
  const candidate = stringField(value, "selectedPurpose");
  if (
    candidate === "character_cover" ||
    candidate === "character_hero" ||
    candidate === "character_chat"
  ) {
    return candidate;
  }
  return null;
}

function trustedCharacterIds(command: {
  readonly targetType: string;
  readonly targetId: string;
  readonly requestPayload: Prisma.JsonValue;
  readonly result: Prisma.JsonValue | null;
}) {
  const ids = new Set<string>();
  if (
    command.targetType === "character" &&
    command.targetId !== "uncommitted"
  ) {
    ids.add(command.targetId);
  }
  const resultCharacterId = stringField(
    command.result,
    "characterId",
  );
  if (resultCharacterId) ids.add(resultCharacterId);
  if (
    stringField(command.requestPayload, "targetType") ===
      "character"
  ) {
    const requestCharacterId = stringField(
      command.requestPayload,
      "targetId",
    );
    if (requestCharacterId) ids.add(requestCharacterId);
  }
  return [...ids];
}

function isLegacyUnboundCharacterTombstone(command: {
  readonly status: string;
  readonly targetType: string;
  readonly targetId: string;
  readonly requestPayload: Prisma.JsonValue;
  readonly result: Prisma.JsonValue | null;
  readonly error: Prisma.JsonValue | null;
}) {
  return (
    command.status === "cancelled" &&
    command.targetType === "character_project" &&
    command.targetId === "uncommitted" &&
    stringField(command.requestPayload, "recovery") ===
      "cancelled_unreplayable_snapshot" &&
    stringField(command.result, "recoveryState") ===
      "cancelled" &&
    stringField(command.error, "code") ===
      "unreplayable_client_snapshot"
  );
}

function isUnreplayableRecoveryTombstone(command: {
  readonly status: string;
  readonly requestPayload: Prisma.JsonValue;
  readonly result: Prisma.JsonValue | null;
  readonly error: Prisma.JsonValue | null;
}) {
  return (
    command.status === "cancelled" &&
    stringField(command.requestPayload, "recovery") ===
      "cancelled_unreplayable_snapshot" &&
    stringField(command.result, "recoveryState") ===
      "cancelled" &&
    stringField(command.error, "code") ===
      "unreplayable_client_snapshot"
  );
}

function assertExpectedCharacterBinding(
  body: AdminMutationRecoveryRequest,
  command: {
    readonly status: string;
    readonly targetType: string;
    readonly targetId: string;
    readonly requestPayload: Prisma.JsonValue;
    readonly result: Prisma.JsonValue | null;
  },
) {
  const expected = expectedCharacterId(body);
  if (!expected) return;
  if (body.commandType === "creative.run.create") {
    const targetType = stringField(
      command.requestPayload,
      "targetType",
    );
    const targetId = stringField(
      command.requestPayload,
      "targetId",
    );
    const purpose = stringField(
      command.requestPayload,
      "purpose",
    );
    const expectedPurpose = expectedCreativeRunPurpose(body);
    if (
      targetType !== "character" ||
      targetId !== expected ||
      (
        expectedPurpose !== null &&
        purpose !== expectedPurpose
      )
    ) {
      throw Errors.conflict(
        "Mutation receipt does not match the expected Character Run resource",
        {
          commandType: body.commandType,
          expectedPurpose,
        },
      );
    }
    return;
  }
  const resultCharacterId = stringField(
    command.result,
    "characterId",
  );
  const targetMatches =
    command.targetType === "character" &&
    command.targetId === expected;
  const resultMatches =
    resultCharacterId === expected ||
    (
      resultCharacterId === null &&
      command.status !== "succeeded"
    );
  if (!targetMatches || !resultMatches) {
    throw Errors.conflict(
      "Mutation receipt does not match the expected Character resource",
      { commandType: body.commandType },
    );
  }
}

function committedTargetId(
  commandType: AdminRecoverableMutationCommandType,
  command: {
    readonly targetId: string;
    readonly result: Prisma.JsonValue | null;
  },
) {
  switch (commandType) {
    case "creative.run.create":
      return stringField(command.result, "batchId") ?? command.targetId;
    case "character.project.create":
      return stringField(command.result, "characterId");
    case "creative.review.decision":
      return stringField(command.result, "decisionId");
    case "character.identity.bootstrap":
      return stringField(command.result, "referenceSetRevisionId");
    case "character.project.draft_image.select":
      return stringField(command.result, "selectedAssetId");
  }
}

function committedVerification(
  commandType: AdminRecoverableMutationCommandType,
  command: {
    readonly targetId: string;
    readonly requestPayload: Prisma.JsonValue;
    readonly result: Prisma.JsonValue | null;
  },
) {
  const payload = record(command.requestPayload);
  switch (commandType) {
    case "creative.run.create": {
      const runId = stringField(command.result, "batchId") ??
        command.targetId;
      return {
        kind: "creative_run" as const,
        runId,
        requestSnapshot: command.requestPayload,
      };
    }
    case "character.project.create": {
      const characterId = stringField(command.result, "characterId");
      return characterId
        ? {
            kind: "character_project" as const,
            characterId,
          }
        : null;
    }
    case "creative.review.decision": {
      const runId = stringField(command.result, "runId") ??
        stringField(command.requestPayload, "runId");
      const itemId = stringField(command.result, "itemId") ??
        command.targetId;
      const decisionId = stringField(command.result, "decisionId");
      if (!runId || !itemId || !decisionId) return null;
      const body = { ...payload };
      delete body.runId;
      return {
        kind: "creative_review_decision" as const,
        runId,
        itemId,
        decisionId,
        requestSnapshot: {
          runId,
          itemId,
          body,
        },
      };
    }
    case "character.identity.bootstrap": {
      const characterId = stringField(
        command.result,
        "characterId",
      );
      const referenceSetRevisionId = stringField(
        command.result,
        "referenceSetRevisionId",
      );
      const anchorAssetId = stringField(
        command.result,
        "anchorAssetId",
      );
      const draftImageAssetId = stringField(
        command.result,
        "draftImageAssetId",
      );
      if (
        !characterId ||
        !referenceSetRevisionId ||
        !anchorAssetId ||
        !draftImageAssetId
      ) {
        return null;
      }
      return {
        kind: "character_identity_bootstrap" as const,
        characterId,
        referenceSetRevisionId,
        anchorAssetId,
        draftImageAssetId,
      };
    }
    case "character.project.draft_image.select": {
      const characterId = stringField(
        command.result,
        "characterId",
      );
      const purpose = selectedPurpose(command.result);
      const selectedAssetId = stringField(
        command.result,
        "selectedAssetId",
      );
      if (!characterId || !purpose || !selectedAssetId) {
        return null;
      }
      return {
        kind: "character_draft_image_selection" as const,
        characterId,
        selectedPurpose: purpose,
        selectedAssetId,
      };
    }
  }
}

function recoveryState(status: string) {
  if (status === "succeeded") return "committed" as const;
  if (status === "cancelled") return "cancelled" as const;
  if (status === "failed") return "failed" as const;
  return "pending" as const;
}

function isMutationRecoveryRace(cause: unknown) {
  return (
    isSerializableWriteConflict(cause) ||
    isUniqueConstraintConflict(cause)
  );
}

export async function reconcileAdminMutationReceipt(request: Request) {
  const actor = await authenticatedAdminActor(request);
  const body = adminMutationRecoveryRequestSchema.parse(
    await jsonBody(request),
  );
  const configuration = recoveryConfiguration[body.commandType];
  const expectedCharacter = expectedCharacterId(body);
  await requireActorPermission(
    request,
    actor,
    configuration.permission,
    expectedCharacter
      ? { characterId: expectedCharacter }
      : undefined,
  );
  const idempotencyKey = requireIdempotencyKey(request);
  const scope = configuration.scope(actor.id);
  const requestId =
    request.headers.get("x-request-id")?.trim() || crypto.randomUUID();

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const command = await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`
          SELECT pg_advisory_xact_lock(
            hashtext(${`${scope}:${idempotencyKey}`})
          )
        `;
        const existing = await tx.controlPlaneCommand.findUnique({
          where: {
            scope_idempotencyKey: { scope, idempotencyKey },
          },
        });
        if (existing) return existing;

        const commandId = crypto.randomUUID();
        const idempotencyKeyHash = canonicalSha256({
          actorId: actor.id,
          idempotencyKey,
        });
        const cancelled = await tx.controlPlaneCommand.create({
          data: {
            id: commandId,
            scope,
            idempotencyKey,
            commandType: body.commandType,
            targetType: configuration.tombstoneTargetType,
            targetId: expectedCharacter ?? "uncommitted",
            actorId: actor.id,
            requestId,
            requestHash: canonicalSha256({
              commandType: body.commandType,
              recovery: "cancelled_unreplayable_snapshot",
              idempotencyKeyHash,
              expectedCharacterId: expectedCharacter,
              expectedPurpose: expectedCreativeRunPurpose(body),
            }),
            requestPayload: toInputJson({
              recovery: "cancelled_unreplayable_snapshot",
              expectedCharacterId: expectedCharacter,
              expectedPurpose: expectedCreativeRunPurpose(body),
            }),
            retryMode: "idempotent",
            status: "cancelled",
            result: toInputJson({ recoveryState: "cancelled" }),
            error: toInputJson({
              code: "unreplayable_client_snapshot",
              message:
                "The browser snapshot no longer matched the active contract.",
            }),
            finishedAt: new Date(),
          },
        });
        await tx.adminAuditLog.create({
          data: {
            actorId: actor.id,
            actorRole: actor.role,
            action: "admin.mutation_recovery.cancelled",
            targetType: "control_plane_command",
            targetId: commandId,
            reason:
              "Seal an unreplayable browser mutation intent after receipt reconciliation",
            after: toInputJson({
              commandType: body.commandType,
              idempotencyKeyHash,
              expectedCharacterId: expectedCharacter,
              expectedPurpose: expectedCreativeRunPurpose(body),
              state: "cancelled",
            }),
            requestId,
          },
        });
        return cancelled;
      }, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      });

      const existingCommandType =
        adminRecoverableMutationCommandTypeSchema.safeParse(
          command.commandType,
        );
      if (command.actorId !== actor.id) {
        throw Errors.conflict(
          "Mutation receipt is not bound to the authenticated actor",
          { expectedCommandType: body.commandType },
        );
      }
      if (existingCommandType.success) {
        const existingConfiguration =
          recoveryConfiguration[existingCommandType.data];
        const actualCharacterIds = trustedCharacterIds(command);
        if (
          existingCommandType.data ===
            "character.identity.bootstrap" ||
          existingCommandType.data ===
            "character.project.draft_image.select" ||
          (
            existingCommandType.data === "creative.run.create" &&
            actualCharacterIds.length > 0
          )
        ) {
          const legacyUnboundTombstone =
            expectedCharacter !== null &&
            isLegacyUnboundCharacterTombstone(command);
          if (
            actualCharacterIds.length === 0 &&
            !legacyUnboundTombstone
          ) {
            throw Errors.conflict(
              "Mutation receipt is missing its trusted Character resource",
              { expectedCommandType: body.commandType },
            );
          }
          for (const characterId of actualCharacterIds) {
            await requireActorPermission(
              request,
              actor,
              existingConfiguration.permission,
              { characterId },
            );
          }
        } else {
          await requireActorPermission(
            request,
            actor,
            existingConfiguration.permission,
          );
        }
      } else {
        throw Errors.conflict(
          "Idempotency key is not bound to a recoverable mutation receipt",
          { expectedCommandType: body.commandType },
        );
      }
      if (command.commandType !== body.commandType) {
        throw Errors.conflict(
          "Idempotency key belongs to another mutation type",
          {
            expectedCommandType: body.commandType,
            existingCommandType: command.commandType,
          },
        );
      }
      if (!isUnreplayableRecoveryTombstone(command)) {
        assertExpectedCharacterBinding(body, command);
      }

      const committedTarget =
        command.status === "succeeded"
          ? committedTargetId(body.commandType, command)
          : null;
      const verification =
        command.status === "succeeded"
          ? committedVerification(body.commandType, command)
          : null;
      if (
        command.status === "succeeded" &&
        (!committedTarget || !verification)
      ) {
        throw Errors.conflict(
          "Committed mutation receipt is missing projection evidence",
          {
            commandId: command.id,
            commandType: body.commandType,
          },
        );
      }
      return adminMutationRecoveryResultSchema.parse({
        state: recoveryState(command.status),
        commandType: body.commandType,
        commandId: command.id,
        status: command.status,
        committedTargetId: committedTarget,
        verification,
      });
    } catch (cause) {
      if (isMutationRecoveryRace(cause) && attempt < 2) {
        continue;
      }
      if (isMutationRecoveryRace(cause)) {
        throw Errors.conflict(
          "Mutation receipt reconciliation raced with another authority",
          { commandType: body.commandType, attempts: attempt + 1 },
        );
      }
      throw cause;
    }
  }
  throw Errors.conflict(
    "Mutation receipt reconciliation could not reach a stable result",
  );
}
