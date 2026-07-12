import { describe, expect, it } from "vitest";
import { issueCharacterPreviewToken, verifyCharacterPreviewToken } from "./preview-token";

const secret = "character-preview-test-secret-0123456789";
const now = new Date("2026-07-11T12:00:00.000Z");

describe("Character renderer preview token", () => {
  it("pins the exact immutable ContentVersion and optional Release", () => {
    const token = issueCharacterPreviewToken({
      characterId: "character-1",
      contentVersionId: "content-2",
      releaseId: "release-2",
      imageAssetId: "asset-2",
      label: "Draft Preview",
    }, secret, now);
    expect(verifyCharacterPreviewToken(token, secret, now)).toMatchObject({
      characterId: "character-1",
      contentVersionId: "content-2",
      releaseId: "release-2",
      imageAssetId: "asset-2",
      label: "Draft Preview",
    });
  });

  it("rejects tampering and expired links", () => {
    const token = issueCharacterPreviewToken({
      characterId: "character-1",
      contentVersionId: "content-2",
      releaseId: null,
      imageAssetId: null,
      label: "Live",
    }, secret, now);
    expect(verifyCharacterPreviewToken(`${token}x`, secret, now)).toBeNull();
    expect(verifyCharacterPreviewToken(token, secret, new Date(now.getTime() + 30 * 60 * 1_000))).toBeNull();
  });
});
