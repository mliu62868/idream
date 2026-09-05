import { describe, expect, it } from "vitest";
import { imageAcknowledgement } from "./image-acknowledgement";

describe("accepted image confirmation", () => {
  it.each([
    ["Send a photo", "en-US", "en"],
    ["Une photo, merci", "fr-FR", "fr"],
    ["发张照片", "en", "zh"],
    ["写真を送って", "en", "ja"],
    ["사진을 보내줘", "en", "ko"],
    ["Send a photo", "unknown", "en"],
  ])("uses current script or signed locale: %s / %s", (text, locale, expected) => {
    expect(imageAcknowledgement(text, locale)).toMatchObject({
      version: "image-action-ack-1", locale: expected,
    });
  });
});
