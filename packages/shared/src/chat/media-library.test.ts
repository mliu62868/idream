import { describe, expect, it } from "vitest";
import {
  COMPANION_MEDIA_TOOL_DEFINITIONS,
  requestCharacterMediaArgsSchema,
  requestCharacterMediaResultSchema,
  resendSessionMediaArgsSchema,
  resendSessionMediaResultSchema,
} from "./media-library";

describe("Character media tool contracts", () => {
  it("preserves visual and technical video requirements without silent defaults for the subject", () => {
    const args = { kind: "video", subject: "companion", direction: "Blue dress at the sea, no hat, silent, 6-10 seconds",
      requestedNudity: "none", mustHave: ["blue dress", "sea"], mustExclude: ["hat"],
      mode: "existing_only", minDurationSeconds: 6, maxDurationSeconds: 10, hasAudio: false };
    expect(requestCharacterMediaArgsSchema.parse(args)).toEqual(args);
    for (const invalid of [
      { ...args, subject: undefined }, { ...args, minDurationSeconds: 11 },
      { ...args, hasAudio: "false" }, { ...args, kind: "image" }, { ...args, direction: " " },
      { ...args, generateOnMiss: true }, { ...args, outputCount: 4 },
    ]) expect(requestCharacterMediaArgsSchema.safeParse(invalid).success).toBe(false);
  });

  it("exposes the request, exact session resend and edit tools", () => {
    expect(COMPANION_MEDIA_TOOL_DEFINITIONS.map(tool => tool.name)).toEqual([
      "request_character_media", "resend_session_media", "edit_last_image",
    ]);
    expect(resendSessionMediaArgsSchema.parse({ previousMediaAssetId: "asset-1" })).toEqual({ previousMediaAssetId: "asset-1" });
    for (const invalid of [
      {}, { previousMediaAssetId: "" }, { candidateToken: "old-candidate" },
      { previousMediaAssetId: "asset-1", direction: "Change the outfit" },
    ]) expect(resendSessionMediaArgsSchema.safeParse(invalid).success).toBe(false);
  });

  it.each(["available", "no_match", "unavailable"])("accepts %s results only without an attachment, job or charge", status => {
    const result = { accepted: true, duplicate: false, status, kind: "video", costDreamcoins: 0 };
    expect(requestCharacterMediaResultSchema.parse(result)).toEqual(result);
    for (const extra of [{ attachmentId: "invented" }, { generationJobId: "job" }, { costDreamcoins: 5 }]) {
      expect(requestCharacterMediaResultSchema.safeParse({ ...result, ...extra }).success).toBe(false);
    }
  });

  it("keeps the accepted attachment opaque until the media is actually delivered", () => {
    const result = { accepted: true, duplicate: false, status: "accepted", attachmentId: "attachment-1",
      kind: "image", generationJobId: null, mediaAssetId: null, costDreamcoins: 5 };
    expect(requestCharacterMediaResultSchema.parse(result)).toEqual(result);
    expect(requestCharacterMediaResultSchema.safeParse({ ...result, mediaAssetId: "early" }).success).toBe(false);
    expect(requestCharacterMediaResultSchema.safeParse({ ...result, status: "completed" }).success).toBe(false);
    expect(requestCharacterMediaResultSchema.parse({ ...result, status: "completed", mediaAssetId: "delivered" })).toMatchObject({
      status: "completed", mediaAssetId: "delivered",
    });
  });

  it("accepts only completed free resends with no Generation job", () => {
    const result = { accepted: true, duplicate: true, status: "completed", attachmentId: "attachment-1",
      kind: "image", mediaAssetId: "asset-1", generationJobId: null, costDreamcoins: 0, source: "previous_media" };
    expect(resendSessionMediaResultSchema.parse(result)).toEqual(result);
    for (const extra of [
      { status: "accepted" }, { costDreamcoins: 5 }, { generationJobId: "job" },
      { attachmentId: null }, { mediaAssetId: null }, { source: "library" },
    ]) expect(resendSessionMediaResultSchema.safeParse({ ...result, ...extra }).success).toBe(false);
  });
});
