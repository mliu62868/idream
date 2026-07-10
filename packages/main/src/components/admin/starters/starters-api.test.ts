import { describe, expect, it } from "vitest";
import { starterPayload } from "./starters-api";

describe("starterPayload", () => {
  it("trims fields, keeps scope/reason as-is", () => {
    expect(
      starterPayload({
        name: " Luna ", summary: " short bio ", gender: " female ", style: " anime ",
        scope: "built_in", tags: "cute, elf ,, ", sortOrder: "3", reason: " ok3 ",
      }),
    ).toEqual({
      name: "Luna", summary: "short bio", gender: "female", style: "anime",
      scope: "built_in", tags: ["cute", "elf"], sortOrder: 3, reason: "ok3",
    });
  });

  it("splits tags on commas, drops blanks, caps at 12", () => {
    const many = Array.from({ length: 15 }, (_, i) => `tag${i}`).join(",");
    expect(
      starterPayload({
        name: "A", summary: "", gender: "", style: "",
        scope: "community", tags: many, sortOrder: "0", reason: "abc",
      }).tags,
    ).toEqual(Array.from({ length: 12 }, (_, i) => `tag${i}`));
  });

  it("falls back to sortOrder 0 on garbage, drops empty optional fields", () => {
    const payload = starterPayload({
      name: "A", summary: "", gender: "", style: "",
      scope: "built_in", tags: "", sortOrder: "x", reason: "abc",
    });
    expect(payload.sortOrder).toBe(0);
    expect(payload.summary).toBeUndefined();
    expect(payload.gender).toBeUndefined();
    expect(payload.style).toBeUndefined();
  });
});
