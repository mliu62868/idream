import { describe, expect, it } from "vitest";
import {
  chatImageRequestedPayloadSchema,
  videoGeneratePayloadSchema,
} from "./payloads";

const request = {
  version: 1 as const,
  kind: "chat.image.requested" as const,
  requestId: "request-1",
  attachmentId: "attachment-1",
  sessionId: "session-1",
  messageId: "message-1",
  userId: "user-1",
  characterId: "character-1",
  promptHint: "a sunset selfie",
  conversationContext: "user: send a sunset selfie",
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
      userId: "user-1",
      characterId: "character-1",
      prompt: "She looks into the camera and waves.",
      negativePrompt: null,
      controls: {},
      seconds: 4,
      seed: "seed-video-1",
      model: "ltx23-gtanimation-i2v",
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
