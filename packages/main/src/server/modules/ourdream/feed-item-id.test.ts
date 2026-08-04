import { describe, expect, it } from "vitest";
import { feedCharacterId, feedCollectionId } from "./feed-item-id";

describe("Feed item IDs", () => {
  it("decodes URL-encoded character and collection IDs", () => {
    expect(feedCharacterId("character%3Acharacter-1")).toBe("character-1");
    expect(feedCollectionId("collection%3Acollection-1")).toBe("collection-1");
  });

  it("rejects the wrong item kind and malformed URL encoding", () => {
    expect(feedCharacterId("collection:collection-1")).toBeNull();
    expect(feedCollectionId("character:character-1")).toBeNull();
    expect(feedCharacterId("%E0%A4%A")).toBeNull();
    expect(feedCollectionId("%E0%A4%A")).toBeNull();
  });
});
