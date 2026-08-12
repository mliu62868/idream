import { describe, expect, it } from "vitest";
import {
  characterProjectCreateRequestSchema,
  characterProjectCreateResponseSchema,
  characterProjectDraftSchema,
  characterProjectDraftPatchRequestSchema,
  characterProjectProductionReadyDraftSchema,
  customerCharacterPublicationPrepRequestSchema,
  customerCharacterPublicationPrepResponseSchema,
} from "./characters-create";

const validCreate = {
  positioning: {
    audience: "Adults winding down after high-pressure work",
    companionNeed: "A grounded transition from work into rest",
    hypothesis: "Specific evening rituals improve qualified conversations",
    differentiation: "Calm direction without generic affirmation",
  },
  persona: {
    name: "Mara",
    age: 28,
    gender: "female",
    relationshipArchetype: "steady confidante",
    characterPromise: "A precise, warm place to put the day down",
    personality: "Observant, measured, gently challenging",
    tone: "Warm, concise, grounded",
    backstory: "A night-shift radio host who learned how to listen between words.",
    firstMessage: "You made it. What do you need to put down tonight?",
    exampleDialogue: ["Tell me the part you keep replaying."],
  },
  visualDirection: {
    identityAnchor: "Composed late-night radio host",
    stableTraits: ["dark wavy hair", "warm brown eyes"],
    style: "realistic",
    referenceDirection: "Low-key tungsten portraiture with an intimate editorial crop",
  },
  commercialIntent: {
    ownerId: "operator-1",
    plannedLaunchAt: "2026-08-01T17:00:00.000Z",
    targetPlacementKeys: ["feed_card", "evening_collection"],
    successCriteria: ["QCE improves without D7 regression"],
    productionPackage: "Identity set, feed card, detail hero, chat image baseline",
    qaPlan: "Mobile and desktop preview plus five-turn conversation review",
  },
  reason: { code: "new_supply", summary: "Create an evening decompression companion" },
  confirmation: "CREATE CHARACTER",
} as const;

describe("Character Project create contract", () => {
  it("binds historical customer publication preparation to its reviewed submission", () => {
    expect(customerCharacterPublicationPrepRequestSchema.parse({
      submissionId: "submission-1",
      reason: "Repair approved publication preparation",
      confirmation: "PREPARE PUBLICATION character-1",
    })).toMatchObject({ submissionId: "submission-1" });
    expect(customerCharacterPublicationPrepRequestSchema.safeParse({
      reason: "Repair approved publication preparation",
      confirmation: "PREPARE PUBLICATION character-1",
    }).success).toBe(false);
    expect(customerCharacterPublicationPrepResponseSchema.parse({
      state: "publication_prep",
      characterId: "character-1",
      submissionId: "submission-1",
      projectId: "project-1",
      revisionId: "revision-1",
      projectVersion: 1,
      servingState: "inactive",
      deepLink: "/admin/characters/character-1?tab=assets",
      created: true,
      replayed: false,
    })).toMatchObject({ servingState: "inactive", replayed: false });
  });

  it("accepts a complete official draft and a strict authority response", () => {
    expect(characterProjectCreateRequestSchema.parse(validCreate)).toMatchObject({ persona: { age: 28 } });
    expect(characterProjectCreateResponseSchema.parse({
      characterId: "character-1",
      characterContentVersionId: "content-1",
      projectId: "project-1",
      revisionId: "revision-1",
      projectVersion: 1,
      contentVersion: 1,
      deepLink: "/admin/characters/character-1",
      replayed: false,
    })).toMatchObject({ projectVersion: 1, replayed: false });
    expect(characterProjectCreateResponseSchema.safeParse({
      characterId: "character-1",
      projectId: "project-1",
      projectVersion: 1,
      contentVersion: 1,
      deepLink: "/admin/characters/character-1",
      replayed: false,
    }).success).toBe(false);
  });

  it("rejects underage, wrong confirmation, and unknown fields", () => {
    expect(characterProjectCreateRequestSchema.safeParse({
      ...validCreate,
      persona: { ...validCreate.persona, age: 17 },
    }).success).toBe(false);
    expect(characterProjectCreateRequestSchema.safeParse({
      ...validCreate,
      confirmation: "create",
    }).success).toBe(false);
    expect(characterProjectCreateRequestSchema.safeParse({
      ...validCreate,
      clientDraftId: "browser-only",
    }).success).toBe(false);
  });

  it("rejects the former instructional defaults without hiding an old server draft", () => {
    const instructional = {
      ...validCreate,
      positioning: {
        ...validCreate.positioning,
        audience: "Define the adult audience for this companion",
      },
      persona: {
        ...validCreate.persona,
        name: "Untitled companion",
      },
      visualDirection: {
        ...validCreate.visualDirection,
        identityAnchor: "A recognizable adult companion identity",
      },
      commercialIntent: {
        ...validCreate.commercialIntent,
        successCriteria: ["Define one measurable success criterion"],
      },
    };
    expect(
      characterProjectCreateRequestSchema.safeParse(instructional).success,
    ).toBe(false);
    expect(characterProjectDraftSchema.safeParse({
      positioning: instructional.positioning,
      persona: instructional.persona,
      visualDirection: instructional.visualDirection,
      commercialIntent: instructional.commercialIntent,
    }).success).toBe(true);
    expect(characterProjectProductionReadyDraftSchema.safeParse({
      positioning: instructional.positioning,
      persona: instructional.persona,
      visualDirection: instructional.visualDirection,
      commercialIntent: instructional.commercialIntent,
    }).success).toBe(false);
  });

  it("accepts immutable content autosave through the versioned Project PATCH contract", () => {
    const validPatch = {
      entityVersion: 1,
      ownerId: "operator-1",
      audience: validCreate.positioning.audience,
      companionNeed: validCreate.positioning.companionNeed,
      hypothesis: validCreate.positioning.hypothesis,
      differentiation: validCreate.positioning.differentiation,
      targetPlacementKeys: validCreate.commercialIntent.targetPlacementKeys,
      successCriteria: validCreate.commercialIntent.successCriteria,
      productionPackage: validCreate.commercialIntent.productionPackage,
      qaPlan: validCreate.commercialIntent.qaPlan,
      plannedLaunchAt: validCreate.commercialIntent.plannedLaunchAt,
      content: {
        persona: validCreate.persona,
        visualDirection: validCreate.visualDirection,
      },
      reason: "Autosave Character creation wizard",
    };
    const result = characterProjectDraftPatchRequestSchema.safeParse(validPatch);
    expect(result.success).toBe(true);
    expect(characterProjectDraftPatchRequestSchema.safeParse({
      ...validPatch,
      phase: "launch_ready",
    }).success).toBe(false);
  });
});
