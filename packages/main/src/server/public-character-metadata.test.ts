import { describe, expect, it, vi } from "vitest";
import { resolvePublicCharacterPageMetadata } from "./public-character-metadata";

describe("public character page metadata resolver", () => {
  it("projects only the public reader result", async () => {
    await expect(
      resolvePublicCharacterPageMetadata("lola", async () => ({
        name: "Lola",
        description: "A thoughtful companion.",
        imageAsset: {
          url: "/media/lola-original.jpg",
          thumbnailUrl: "/media/lola-thumbnail.jpg",
        },
      })),
    ).resolves.toEqual({
      name: "Lola",
      description: "A thoughtful companion.",
      imageUrl: "/media/lola-thumbnail.jpg",
    });
  });

  it("fails closed when the public reader has no result or is unavailable", async () => {
    await expect(
      resolvePublicCharacterPageMetadata("private", async () => null),
    ).resolves.toBeNull();

    const unavailableReader = vi.fn(async () => {
      throw new Error("database unavailable");
    });
    await expect(
      resolvePublicCharacterPageMetadata("unavailable", unavailableReader),
    ).resolves.toBeNull();
    expect(unavailableReader).toHaveBeenCalledOnce();
  });
});
