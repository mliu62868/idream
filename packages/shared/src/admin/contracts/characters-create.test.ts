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
  persona: {
    name: "Mara",
    age: 28,
    gender: "female",
    characterPromise: "A precise, warm place to put the day down",
    detailsMarkdown: [
      "## Personality and voice",
      "Observant, measured, gently challenging, warm, and concise.",
      "",
      "## Background",
      "A night-shift radio host who learned how to listen between words.",
    ].join("\n"),
    firstMessage: "You made it. What do you need to put down tonight?",
  },
  visualDirection: {
    identityAnchor: "Composed late-night radio host",
    stableTraits: ["dark wavy hair", "warm brown eyes"],
    style: "realistic",
    referenceDirection:
      "Low-key tungsten portraiture with an intimate editorial crop",
  },
  reason: {
    code: "new_supply",
    summary: "Create an evening decompression companion",
  },
  confirmation: "CREATE CHARACTER",
} as const;

describe("Character Project create contract", () => {
  it("binds historical customer publication preparation to its reviewed submission", () => {
    expect(
      customerCharacterPublicationPrepRequestSchema.parse({
        submissionId: "submission-1",
        reason: "Repair approved publication preparation",
        confirmation: "PREPARE PUBLICATION character-1",
      }),
    ).toMatchObject({ submissionId: "submission-1" });
    expect(
      customerCharacterPublicationPrepRequestSchema.safeParse({
        reason: "Repair approved publication preparation",
        confirmation: "PREPARE PUBLICATION character-1",
      }).success,
    ).toBe(false);
    expect(
      customerCharacterPublicationPrepResponseSchema.parse({
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
      }),
    ).toMatchObject({ servingState: "inactive", replayed: false });
  });

  it("accepts a complete official draft and a strict authority response", () => {
    expect(
      characterProjectCreateRequestSchema.parse(validCreate),
    ).toMatchObject({ persona: { age: 28 } });
    expect(
      characterProjectCreateResponseSchema.parse({
        characterId: "character-1",
        characterContentVersionId: "content-1",
        projectId: "project-1",
        revisionId: "revision-1",
        projectVersion: 1,
        contentVersion: 1,
        deepLink: "/admin/characters/character-1",
        replayed: false,
      }),
    ).toMatchObject({ projectVersion: 1, replayed: false });
    expect(
      characterProjectCreateResponseSchema.safeParse({
        characterId: "character-1",
        projectId: "project-1",
        projectVersion: 1,
        contentVersion: 1,
        deepLink: "/admin/characters/character-1",
        replayed: false,
      }).success,
    ).toBe(false);
  });

  it("rejects underage, wrong confirmation, and unknown fields", () => {
    expect(
      characterProjectCreateRequestSchema.safeParse({
        ...validCreate,
        persona: { ...validCreate.persona, age: 17 },
      }).success,
    ).toBe(false);
    expect(
      characterProjectCreateRequestSchema.safeParse({
        ...validCreate,
        confirmation: "create",
      }).success,
    ).toBe(false);
    expect(
      characterProjectCreateRequestSchema.safeParse({
        ...validCreate,
        clientDraftId: "browser-only",
      }).success,
    ).toBe(false);
  });

  it("rejects the former instructional defaults without hiding an old server draft", () => {
    const instructional = {
      ...validCreate,
      persona: {
        ...validCreate.persona,
        name: "Untitled companion",
      },
      visualDirection: {
        ...validCreate.visualDirection,
        identityAnchor: "A recognizable adult companion identity",
      },
    };
    expect(
      characterProjectCreateRequestSchema.safeParse(instructional).success,
    ).toBe(false);
    expect(
      characterProjectDraftSchema.safeParse({
        persona: instructional.persona,
        visualDirection: instructional.visualDirection,
      }).success,
    ).toBe(true);
    expect(
      characterProjectProductionReadyDraftSchema.safeParse({
        persona: instructional.persona,
        visualDirection: instructional.visualDirection,
      }).success,
    ).toBe(false);
  });

  it("rejects removed project-brief metadata", () => {
    expect(
      characterProjectCreateRequestSchema.safeParse({
        ...validCreate,
        positioning: {
          audience: "Adults winding down after work",
        },
      }).success,
    ).toBe(false);
    expect(
      characterProjectDraftPatchRequestSchema.safeParse({
        entityVersion: 1,
        ownerId: null,
        content: {
          persona: validCreate.persona,
          visualDirection: validCreate.visualDirection,
        },
        reason: "Autosave Character creation wizard",
      }).success,
    ).toBe(false);
  });

  it("keeps Additional details optional and rejects deleted structured persona fields", () => {
    expect(
      characterProjectCreateRequestSchema.safeParse({
        ...validCreate,
        persona: { ...validCreate.persona, detailsMarkdown: "" },
      }).success,
    ).toBe(true);
    expect(
      characterProjectCreateRequestSchema.safeParse({
        ...validCreate,
        persona: { ...validCreate.persona, personality: "legacy field" },
      }).success,
    ).toBe(false);
    expect(
      characterProjectCreateRequestSchema.safeParse({
        ...validCreate,
        persona: { ...validCreate.persona, firstMessage: "" },
      }).success,
    ).toBe(false);
  });

  it("accepts immutable content autosave through the versioned Project PATCH contract", () => {
    const validPatch = {
      entityVersion: 1,
      content: {
        persona: validCreate.persona,
        visualDirection: validCreate.visualDirection,
      },
      reason: "Autosave Character creation wizard",
    };
    const result =
      characterProjectDraftPatchRequestSchema.safeParse(validPatch);
    expect(result.success).toBe(true);
    expect(
      characterProjectDraftPatchRequestSchema.safeParse({
        ...validPatch,
        phase: "launch_ready",
      }).success,
    ).toBe(false);
  });
});
