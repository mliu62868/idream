import { describe, expect, it } from "vitest";
import { issueCharacterPreviewToken, verifyCharacterPreviewToken } from "./preview-token";

const secret = "character-preview-test-secret-0123456789";
const now = new Date("2026-07-11T12:00:00.000Z");

describe("Character renderer preview token", () => {
  it("pins the exact immutable ContentVersion and complete three-slot asset pack", () => {
    const token = issueCharacterPreviewToken({
      characterId: "character-1",
      contentVersionId: "content-2",
      releaseId: "release-2",
      servingVersion: null,
      imageAssetId: "asset-2",
      assetPack: {
        character_cover: "asset-2",
        character_hero: "hero-2",
        character_chat: "chat-2",
      },
      label: "Draft Preview",
    }, secret, now);
    expect(verifyCharacterPreviewToken(token, secret, now)).toMatchObject({
      characterId: "character-1",
      contentVersionId: "content-2",
      releaseId: "release-2",
      imageAssetId: "asset-2",
      assetPack: {
        character_cover: "asset-2",
        character_hero: "hero-2",
        character_chat: "chat-2",
      },
      label: "Draft Preview",
    });
  });

  it("rejects tampering and expired links", () => {
    const token = issueCharacterPreviewToken({
      characterId: "character-1",
      contentVersionId: "content-2",
      releaseId: "release-2",
      servingVersion: 7,
      imageAssetId: "asset-2",
      assetPack: {
        character_cover: "asset-2",
        character_hero: "hero-2",
        character_chat: "chat-2",
      },
      label: "Live",
    }, secret, now);
    expect(verifyCharacterPreviewToken(`${token}x`, secret, now)).toBeNull();
    expect(verifyCharacterPreviewToken(token, secret, new Date(now.getTime() + 30 * 60 * 1_000))).toBeNull();
  });

  it("refuses a compatibility avatar that aliases a different cover slot", () => {
    expect(() => issueCharacterPreviewToken({
      characterId: "character-1",
      contentVersionId: "content-2",
      releaseId: null,
      servingVersion: null,
      imageAssetId: "wrong-cover",
      assetPack: {
        character_cover: "asset-2",
        character_hero: "hero-2",
        character_chat: "chat-2",
      },
      label: "Draft Preview",
    }, secret, now)).toThrow(/character_cover/);
  });

  it("refuses one portrait masquerading as all three customer slots", () => {
    expect(() => issueCharacterPreviewToken({
      characterId: "character-1",
      contentVersionId: "content-2",
      releaseId: null,
      servingVersion: null,
      imageAssetId: "asset-2",
      assetPack: {
        character_cover: "asset-2",
        character_hero: "asset-2",
        character_chat: "asset-2",
      },
      label: "Draft Preview",
    }, secret, now)).toThrow(/three distinct assets/);
  });
});
