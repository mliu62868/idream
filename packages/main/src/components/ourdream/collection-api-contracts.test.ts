import { describe, expect, it } from "vitest";
import { parseCommunityCollectionsResponse, parseMediaCollectionDetailResponse, parseMediaCollectionMutationResponse } from "@/lib/public-api-contracts";
const summary = { id: "collection", name: "Mixed media", visibility: "public", itemCount: 2 };
describe("collection public API contracts", () => {
  it("keeps typed image/video previews and a server cursor", () => {
    const result = parseCommunityCollectionsResponse({ ok: true, data: { collections: [{ ...summary, previews: [{ id: "video", type: "video", url: "/user-content/video/content.mp4" }] }], nextCursor: "next" } });
    expect(result.nextCursor).toBe("next");
    expect(result.collections[0]?.previews?.[0]?.type).toBe("video");
  });
  it("accepts owner-manageable unavailable members without a content URL", () => {
    const result = parseMediaCollectionDetailResponse({ ok: true, data: { collection: summary, canManage: true, items: [{ id: "deleted", type: "image", url: null }], nextCursor: null } });
    expect(result.items[0]?.url).toBeNull();
    expect(result.canManage).toBe(true);
  });
  it("rejects malformed detail authority and external content URLs", () => {
    const data = { collection: summary, canManage: false, items: [{ id: "image", type: "image", url: "https://unexpected.example/image.png" }], nextCursor: null };
    expect(() => parseMediaCollectionDetailResponse({ ok: true, data })).toThrow();
    expect(() => parseMediaCollectionDetailResponse({ ok: true, data: { ...data, items: [], canManage: "yes" } })).toThrow();
  });
  it("retains the authoritative summary from a membership write", () => {
    expect(parseMediaCollectionMutationResponse({ ok: true, data: { collection: { ...summary, visibility: "private", itemCount: 0 }, removed: true } })).toMatchObject({ removed: true, collection: { itemCount: 0, visibility: "private" } });
  });
});
