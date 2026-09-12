import { describe, expect, it } from "vitest";
import { comicManifestSchema } from "./comics";

describe("Comic manifests", () => {
  const page = { mediaAssetId: "owned-image", caption: "A remembered evening." };
  it("accepts an empty private draft without granting source provenance writes", () => {
    expect(comicManifestSchema.parse({ title: "A story", episodes: [{ title: "Chapter one", pages: [] }] })).toMatchObject({ visibility: "private" });
    expect(comicManifestSchema.safeParse({ title: "A story", episodes: [{ title: "Chapter one", pages: [{ ...page, sourceProvenance: { sourceComicId: "stolen" } }] }] }).success).toBe(false);
  });
  it("bounds the complete manifest, not just each chapter", () => {
    const chapter = { title: "Chapter", pages: Array.from({ length: 50 }, () => page) };
    expect(comicManifestSchema.safeParse({ title: "A story", episodes: Array.from({ length: 4 }, () => chapter) }).success).toBe(true);
    expect(comicManifestSchema.safeParse({ title: "A story", episodes: Array.from({ length: 5 }, () => chapter) }).success).toBe(false);
  });
});
