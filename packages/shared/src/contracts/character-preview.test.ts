import { describe, expect, it } from "vitest";
import {
  aiFinalizePayloadSchema,
  characterPreviewGeneratePayloadSchema,
  GEN_QUEUES,
  idempotencyKeys,
} from "./index";

describe("character preview transport contract", () => {
  it("routes a self-contained preview request through the generation service", () => {
    expect(GEN_QUEUES.characterPreview).toBe("character.preview");
    expect(characterPreviewGeneratePayloadSchema.parse({
      version: 1,
      kind: "character.preview",
      requestId: "preview-request",
      previewJobId: "preview-job",
      draftId: "draft",
      userId: "user",
      prompt: "portrait",
      negativePrompt: null,
      controls: {},
      orientation: "4:5",
      seed: "draft",
      model: "real-image-model",
      outputPrefix: "preview/preview-job/",
    }).previewJobId).toBe("preview-job");
  });

  it("carries terminal preview results back to the main authority idempotently", () => {
    expect(aiFinalizePayloadSchema.parse({
      version: 1,
      kind: "character.preview.completed",
      requestId: "preview-request",
      previewJobId: "preview-job",
      draftId: "draft",
      userId: "user",
      provider: "backend",
      model: "real-image-model",
      asset: {
        key: "preview/preview-job/image-1.webp",
        width: 832,
        height: 1024,
        contentType: "image/webp",
      },
    }).kind).toBe("character.preview.completed");
    expect(idempotencyKeys.characterPreviewFinalize("preview-job", "completed"))
      .toBe("character-preview-finalize:preview-job:completed");
  });
});
