import { describe, expect, it } from "vitest";
import {
  isBuiltInMediaPlaceholderUrl,
  isPrivateMediaUrl,
  shouldBypassNextImageOptimizer,
} from "./image-delivery";

describe("shouldBypassNextImageOptimizer", () => {
  it.each([
    "/api/v1/media/media-1",
    "/user-content/asset/content.jpg",
    "/images/ourdream/card-melissa-burke.webp",
    "/images/ourdream/campaign.avif?version=2",
  ])("directly serves protected or already-compressed media: %s", (url) => {
    expect(shouldBypassNextImageOptimizer(url)).toBe(true);
  });

  it.each([
    "/images/ourdream/ourdream-logo.svg",
    "/images/uncompressed/portrait.png",
    "https://cdn.example.test/portrait.webp",
  ])("keeps the optimizer available for other image sources: %s", (url) => {
    expect(shouldBypassNextImageOptimizer(url)).toBe(false);
  });
});

// Previously duplicated as isPrivateMediaUrl / isProtectedMediaUrl in three
// workspaces; these cases pin the single behaviour they all shared.
describe("isPrivateMediaUrl", () => {
  it.each(["/api/v1/media/media-1", "/user-content/asset/content.jpg"])(
    "treats viewer-scoped media as private: %s",
    (url) => {
      expect(isPrivateMediaUrl(url)).toBe(true);
    },
  );

  it.each([
    "/images/ourdream/card-sarah-mercer.webp",
    "https://cdn.example.test/api/v1/media/media-1",
    "",
  ])("treats everything else as shareable: %s", (url) => {
    expect(isPrivateMediaUrl(url)).toBe(false);
  });
});

describe("isBuiltInMediaPlaceholderUrl", () => {
  it.each([
    "/images/ourdream/card-sarah-mercer.webp",
    "/_next/image?url=%2Fimages%2Fourdream%2Fcard-sarah-mercer.webp&w=640",
    "/IMAGES/OURDREAM/CARD-SARAH-MERCER.WEBP",
  ])("recognises the bundled demo portrait: %s", (url) => {
    expect(isBuiltInMediaPlaceholderUrl(url)).toBe(true);
  });

  it("does not flag real generated media", () => {
    expect(isBuiltInMediaPlaceholderUrl("/api/v1/media/media-1")).toBe(false);
    expect(isBuiltInMediaPlaceholderUrl("/images/ourdream/card-melissa-burke.webp")).toBe(
      false,
    );
  });
});
