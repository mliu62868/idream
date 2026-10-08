import { describe, expect, it } from "vitest";
import {
  chatStreamEventSchema,
  chatImageRequestedPayloadSchema,
  imageGeneratePayloadSchema,
  videoGeneratePayloadSchema,
} from "./payloads";
import { characterReferenceSetPublishRequestSchema } from "../admin/contracts/characters-visual-workspace";

it.each([
  { promptTokens: null, completionTokens: null },
  { promptTokens: 0, completionTokens: 0 },
  { promptTokens: 40, completionTokens: 10 },
])("preserves unknown or measured usage in the committed done event: %j", usage => {
  expect(chatStreamEventSchema.parse({ type: "done", attempt: 1, usage })).toEqual({ type: "done", attempt: 1, usage });
});

const request = {
  version: 1 as const,
  kind: "chat.image.requested" as const,
  requestId: "request-1",
  attachmentId: "attachment-1",
  sessionId: "session-1",
  messageId: "message-1",
  userId: "user-1",
  characterId: "character-1",
  subject: "companion" as const,
  promptHint: "a sunset selfie",
  conversationContext: "user: send a sunset selfie",
  intent: { requestedNudity: "unspecified" as const },
  controls: { orientation: "4:5", outputCount: 1 },
};

describe("chat image request Release pin", () => {
  it("preserves the logical exchange id used by downstream privacy correction", () => {
    expect(
      chatImageRequestedPayloadSchema.parse({
        ...request,
        exchangeId: "exchange-1",
      }).exchangeId,
    ).toBe("exchange-1");
  });

  it("preserves a non-empty pinned Character Release", () => {
    expect(
      chatImageRequestedPayloadSchema.parse({
        ...request,
        characterReleaseId: "release-1",
      }).characterReleaseId,
    ).toBe("release-1");
  });

  it("keeps older requests compatible while rejecting an empty Release pin", () => {
    expect(chatImageRequestedPayloadSchema.parse(request).characterReleaseId).toBeUndefined();
    expect(() =>
      chatImageRequestedPayloadSchema.parse({
        ...request,
        characterReleaseId: "",
      }),
    ).toThrow();
  });
});

describe("video generation reference authority", () => {
  it("preserves the pinned source image consumed by image-to-video workers", () => {
    const parsed = videoGeneratePayloadSchema.parse({
      version: 1,
      kind: "video",
      requestId: "request-video-1",
      generationJobId: "job-video-1",
      attemptId: "attempt-video-1",
      attemptNo: 1,
      provider: "comfyui",
      userId: "user-1",
      characterId: "character-1",
      prompt: "She looks into the camera and waves.",
      negativePrompt: null,
      controls: {},
      seconds: 5,
      seed: "seed-video-1",
      model: "redgraft-ltx25-i2v",
      outputPrefix: "gen/job-video-1/",
      referenceImages: [
        {
          assetId: "character-primary-image-1",
          role: "source_image",
          storageKey: "characters/character-1/primary.webp",
          contentType: "image/webp",
        },
      ],
    });

    expect(parsed.referenceImages).toEqual([
      expect.objectContaining({
        assetId: "character-primary-image-1",
        role: "source_image",
      }),
    ]);
  });
});

describe("published reference weight wire contract", () => {
  const common = {
    version: 1, requestId: "request-reference", generationJobId: "job-reference",
    attemptId: "attempt-reference", attemptNo: 1, provider: "comfyui", userId: "user-reference",
    characterId: "character-reference", prompt: "portrait", negativePrompt: null, controls: {},
    seed: "seed-reference", model: "model-reference", outputPrefix: "gen/job-reference/",
  };
  const variants = [
    { schema: imageGeneratePayloadSchema, payload: { ...common, kind: "image", presetIds: [], orientation: "4:5", count: 1 } },
    { schema: videoGeneratePayloadSchema, payload: { ...common, kind: "video", seconds: 4 } },
  ];
  it.each([0.25, 1, 2, 3, 10])("preserves published weight %s across image and video dispatch", weight => {
    // The actual publication schema, rather than an independently copied range,
    // is the input authority consumed by the Main reference manifest.
    const published = characterReferenceSetPublishRequestSchema.shape.references.element.parse({
      mediaAssetId: "published-anchor", role: "primary_face", weight,
    });
    const reference = { assetId: published.mediaAssetId, role: "identity_anchor", weight: published.weight };
    for (const { schema, payload } of variants) {
      expect(schema.parse({ ...payload, referenceImages: [reference] }).referenceImages).toEqual([reference]);
    }
  });
  it.each([-1, 10.01, NaN, Infinity])("rejects out-of-contract wire weight %s", weight => {
    for (const { schema, payload } of variants) {
      expect(schema.safeParse({ ...payload, referenceImages: [{ assetId: "published-anchor", role: "identity_anchor", weight }] }).success).toBe(false);
    }
  });
  it("preserves omitted and zero wire weights supported by historical callers", () => {
    for (const { schema, payload } of variants) {
      const references = [
        { assetId: "anchor-with-default", role: "identity_anchor" },
        { assetId: "anchor-with-zero", role: "identity_anchor", weight: 0 },
      ];
      expect(schema.parse({ ...payload, referenceImages: references }).referenceImages).toEqual(references);
    }
  });
});

describe("generation Attempt authority", () => {
  it.each([
    {
      schema: imageGeneratePayloadSchema,
      payload: {
        version: 1,
        kind: "image",
        requestId: "request-image-1",
        generationJobId: "job-image-1",
        provider: "mock",
        userId: "user-1",
        characterId: null,
        prompt: "portrait",
        negativePrompt: null,
        controls: {},
        presetIds: [],
        orientation: "portrait",
        count: 1,
        seed: "seed-image-1",
        model: "mock-image",
        outputPrefix: "gen/job-image-1/",
      },
    },
    {
      schema: videoGeneratePayloadSchema,
      payload: {
        version: 1,
        kind: "video",
        requestId: "request-video-2",
        generationJobId: "job-video-2",
        provider: "mock",
        userId: "user-1",
        characterId: null,
        prompt: "wave",
        negativePrompt: null,
        controls: {},
        seconds: 4,
        seed: "seed-video-2",
        model: "mock-video",
        outputPrefix: "gen/job-video-2/",
      },
    },
  ])("rejects generation payloads without reserved Attempt identity", ({ schema, payload }) => {
    expect(schema.safeParse(payload).success).toBe(false);
  });
});
