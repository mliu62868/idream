import { describe, expect, it } from "vitest";
import { shouldBypassNextImageOptimizer } from "./image-delivery";

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
