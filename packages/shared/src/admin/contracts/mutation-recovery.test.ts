import { describe, expect, it } from "vitest";
import {
  adminMutationRecoveryRequestSchema,
  adminMutationRecoveryResultSchema,
} from "./common";

describe("Admin mutation recovery contracts", () => {
  it("requires an expected Character only for Character-bound mutations", () => {
    expect(adminMutationRecoveryRequestSchema.parse({
      commandType: "creative.run.create",
      expectedCharacterId: "character-1",
      expectedPurpose: "character_hero",
    })).toEqual({
      commandType: "creative.run.create",
      expectedCharacterId: "character-1",
      expectedPurpose: "character_hero",
    });
    expect(adminMutationRecoveryRequestSchema.safeParse({
      commandType: "creative.run.create",
      expectedPurpose: "character_hero",
    }).success).toBe(false);
    expect(adminMutationRecoveryRequestSchema.parse({
      commandType: "creative.run.create",
    })).toEqual({
      commandType: "creative.run.create",
    });
    expect(adminMutationRecoveryRequestSchema.parse({
      commandType: "character.identity.bootstrap",
      expectedCharacterId: "character-1",
    })).toEqual({
      commandType: "character.identity.bootstrap",
      expectedCharacterId: "character-1",
    });
    expect(adminMutationRecoveryRequestSchema.parse({
      commandType: "character.project.draft_image.select",
      expectedCharacterId: "character-1",
    })).toEqual({
      commandType: "character.project.draft_image.select",
      expectedCharacterId: "character-1",
    });
    expect(adminMutationRecoveryRequestSchema.safeParse({
      commandType: "character.identity.bootstrap",
    }).success).toBe(false);
    expect(adminMutationRecoveryRequestSchema.safeParse({
      commandType: "character.project.draft_image.select",
    }).success).toBe(false);
    expect(adminMutationRecoveryRequestSchema.safeParse({
      commandType: "creative.review.decision",
      expectedCharacterId: "character-1",
    }).success).toBe(false);
  });

  it("exposes typed Character projection evidence from committed receipts", () => {
    expect(adminMutationRecoveryResultSchema.parse({
      state: "committed",
      commandType: "creative.run.create",
      commandId: "command-0",
      status: "succeeded",
      committedTargetId: "run-1",
      verification: {
        kind: "creative_run",
        runId: "run-1",
        requestSnapshot: {
          targetType: "character",
          targetId: "character-1",
          purpose: "character_hero",
        },
      },
    })).toMatchObject({
      verification: {
        kind: "creative_run",
        requestSnapshot: {
          targetId: "character-1",
          purpose: "character_hero",
        },
      },
    });
    expect(adminMutationRecoveryResultSchema.parse({
      state: "committed",
      commandType: "character.identity.bootstrap",
      commandId: "command-1",
      status: "succeeded",
      committedTargetId: "reference-set-1",
      verification: {
        kind: "character_identity_bootstrap",
        characterId: "character-1",
        referenceSetRevisionId: "reference-set-1",
        anchorAssetId: "asset-1",
        draftImageAssetId: "asset-1",
      },
    })).toMatchObject({
      verification: {
        kind: "character_identity_bootstrap",
        anchorAssetId: "asset-1",
      },
    });
    expect(adminMutationRecoveryResultSchema.parse({
      state: "committed",
      commandType: "character.project.draft_image.select",
      commandId: "command-2",
      status: "succeeded",
      committedTargetId: "asset-2",
      verification: {
        kind: "character_draft_image_selection",
        characterId: "character-1",
        selectedPurpose: "character_hero",
        selectedAssetId: "asset-2",
      },
    })).toMatchObject({
      verification: {
        kind: "character_draft_image_selection",
        selectedPurpose: "character_hero",
      },
    });
  });
});
