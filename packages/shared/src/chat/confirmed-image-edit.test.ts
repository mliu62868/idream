import { describe, expect, it } from "vitest";
import { confirmedImageEditSchema, localizedImageEditSchema, LOCAL_IMAGE_EDIT_MODEL_SHA256 } from "./image-action";
import { recoveredMediaActionSchema } from "../contracts/chat-turns";

const confirmed = {
  version: "confirmed-mask-rgba-1", mode: "local", target: "the mug", selection: "one",
  sourceSnapshotId: "source", sourceSha256: "a".repeat(64), width: 832, height: 832,
  maskPngBase64: "AA==", maskSha256: "b".repeat(64), confirmationId: "confirmation",
  confirmedAt: "2026-10-31T00:00:00.000Z", operation: { kind: "recolor", color: "#FF0000" },
};

describe("confirmed image edit contracts", () => {
  it("pins source, region and operation while retaining historical SAM dispatches", () => {
    expect(confirmedImageEditSchema.parse(confirmed).operation).toEqual({ kind: "recolor", color: "#ff0000" });
    expect(localizedImageEditSchema.safeParse({ version: "sam3-rgba-composite-1", mode: "local", target: "the mug", selection: "one", modelSha256: LOCAL_IMAGE_EDIT_MODEL_SHA256 }).success).toBe(true);
    expect(confirmedImageEditSchema.safeParse({ ...confirmed, width: 4096, height: 4096 }).success).toBe(false);
    expect(confirmedImageEditSchema.safeParse({ ...confirmed, confirmationId: undefined }).success).toBe(false);
  });

  it("cannot turn an unpaid ordinary failure into a recovered action", () => {
    expect(recoveredMediaActionSchema.safeParse({ name: "generate_image_async", attachmentId: "a", status: "failed", costDreamcoins: 0 }).success).toBe(false);
    expect(recoveredMediaActionSchema.safeParse({ name: "generate_image_async", attachmentId: "a", status: "failed", costDreamcoins: 8, generationJobId: "job" }).success).toBe(true);
  });

  it("requires an unpaid edit source for a pending or cancelled confirmation card", () => {
    const draft = { name: "edit_last_image", attachmentId: "a", status: "awaiting_confirmation", costDreamcoins: 0, sourceMediaAssetId: "image" };
    expect(recoveredMediaActionSchema.safeParse(draft).success).toBe(true);
    expect(recoveredMediaActionSchema.safeParse({ ...draft, generationJobId: "job" }).success).toBe(false);
    expect(recoveredMediaActionSchema.safeParse({ ...draft, costDreamcoins: 8 }).success).toBe(false);
    expect(recoveredMediaActionSchema.safeParse({ ...draft, sourceMediaAssetId: undefined }).success).toBe(false);
    expect(recoveredMediaActionSchema.safeParse({ ...draft, status: "cancelled" }).success).toBe(true);
  });

  it("requires actual admission for processing and an asset for completed cards", () => {
    const action = { name: "send_character_media", attachmentId: "a", costDreamcoins: 0 };
    expect(recoveredMediaActionSchema.safeParse({ ...action, status: "accepted" }).success).toBe(false);
    expect(recoveredMediaActionSchema.safeParse({ ...action, status: "completed" }).success).toBe(false);
    expect(recoveredMediaActionSchema.safeParse({ ...action, status: "completed", mediaAssetId: "image" }).success).toBe(true);
  });
});
