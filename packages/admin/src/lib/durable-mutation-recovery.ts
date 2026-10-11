import { adminMutationRecoveryRequestSchema, type AdminRecoverableMutationCommandType } from "@idream/shared/admin";
import { adminV2Operation } from "./admin-v2-operation";
import type { DurableMutationIntent } from "./durable-mutation-intent";

type CharacterScopedRecoveryCommandType =
  | "character.identity.bootstrap"
  | "character.project.draft_image.select";

type RecoveryRequest = ReturnType<typeof adminMutationRecoveryRequestSchema.parse>;
type CharacterAssetPurpose = Extract<RecoveryRequest, { commandType: "creative.run.create" }>["expectedPurpose"];

type DurableMutationRecoveryInput =
  | {
      readonly intent: DurableMutationIntent;
      readonly commandType: Exclude<
        AdminRecoverableMutationCommandType,
        CharacterScopedRecoveryCommandType | "creative.run.create"
      >;
    }
  | {
      readonly intent: DurableMutationIntent;
      readonly commandType: "creative.run.create";
      readonly expectedCharacterId?: string;
      readonly expectedPurpose?: CharacterAssetPurpose;
    }
  | {
      readonly intent: DurableMutationIntent;
      readonly commandType: CharacterScopedRecoveryCommandType;
      readonly expectedCharacterId: string;
    };

export function reconcileDurableMutationIntent(
  input: DurableMutationRecoveryInput,
) {
  const body =
    input.commandType === "creative.run.create"
      ? {
          commandType: input.commandType,
          ...(input.expectedCharacterId
            ? { expectedCharacterId: input.expectedCharacterId }
            : {}),
          ...(input.expectedPurpose
            ? { expectedPurpose: input.expectedPurpose }
            : {}),
        }
      : input.commandType === "character.identity.bootstrap" ||
    input.commandType === "character.project.draft_image.select"
      ? {
          commandType: input.commandType,
          expectedCharacterId: input.expectedCharacterId,
        }
      : { commandType: input.commandType };
  return adminV2Operation("POST /api/v2/admin/mutation-receipts/reconcile", {
    replayIdempotencyKey: input.intent.idempotencyKey,
    body,
  });
}
