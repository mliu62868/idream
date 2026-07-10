import { describe, expect, it } from "vitest";
import { characterThumbnails, officialPayload } from "./official-api";

describe("officialPayload", () => {
  it("trims, parses age, splits tags, keeps reason", () => {
    expect(
      officialPayload({
        name: " Luna ", age: "24", gender: "female", style: "realistic",
        description: " desc ", tags: "cute, elf ,, ", reason: " ok3 ",
      }),
    ).toEqual({
      name: "Luna", age: 24, gender: "female", style: "realistic",
      description: "desc", tags: ["cute", "elf"], reason: "ok3",
    });
  });
  it("falls back to age 18 on garbage", () => {
    expect(
      officialPayload({
        name: "A", age: "x", gender: "male", style: "anime",
        description: "d", tags: "", reason: "abc",
      }).age,
    ).toBe(18);
  });
});

describe("characterThumbnails", () => {
  it("maps first character asset per targetId, prefers thumbnailUrl", () => {
    const map = characterThumbnails([
      { targetType: "character", targetId: "c1", thumbnailUrl: "t1.jpg", url: "u1.jpg" },
      { targetType: "character", targetId: "c1", thumbnailUrl: "t2.jpg", url: "u2.jpg" },
      { targetType: "character", targetId: "c2", thumbnailUrl: null, url: "u3.jpg" },
      { targetType: "placement", targetId: "c3", thumbnailUrl: "nope.jpg", url: null },
      { targetType: "character", targetId: null, thumbnailUrl: "nope.jpg", url: null },
    ]);
    expect(map.get("c1")).toBe("t1.jpg");
    expect(map.get("c2")).toBe("u3.jpg");
    expect(map.has("c3")).toBe(false);
  });
});
