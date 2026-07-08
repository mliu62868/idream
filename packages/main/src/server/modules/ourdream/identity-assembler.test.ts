// SPEC: identity-assembler 纯函数回归——确定性/hash 稳定性/与旧 buildCharacterIdentityPrompt
//       输出的金样例等价性。这些用例是 characterVisualProfileCreateData 重构的 oracle：
//       重构后必须仍能通过（见 image-generation-service.test.ts 的护照注入用例）。
import { describe, expect, it } from "vitest";
import {
  IDENTITY_ASSEMBLER_VERSION,
  assembleIdentityPrompt,
  toTraitRecord,
  traitsHashOf,
  type IdentityTraits,
} from "./identity-assembler";

const baseTraits: IdentityTraits = {
  face: { eyes: "hazel" },
  hair: { color: "auburn", style: "long waves" },
  body: {},
  signature: {},
  style: { name: "Lyra Sol", gender: "female", age: "25", style: "realistic" },
};

describe("identity-assembler pure functions", () => {
  it("is a pure function: same traits + same version -> same prompt and same hash", () => {
    const first = assembleIdentityPrompt(baseTraits);
    const second = assembleIdentityPrompt({ ...baseTraits, face: { ...baseTraits.face } });
    expect(first).toEqual(second);
    expect(IDENTITY_ASSEMBLER_VERSION).toBe(1);
  });

  it("traitsHashOf is stable regardless of key insertion order", () => {
    const a = traitsHashOf(baseTraits);
    const reordered: IdentityTraits = {
      ...baseTraits,
      hair: { style: "long waves", color: "auburn" },
    };
    const b = traitsHashOf(reordered);
    expect(a).toBe(b);
  });

  it("traitsHashOf changes when any trait value changes", () => {
    const a = traitsHashOf(baseTraits);
    const b = traitsHashOf({ ...baseTraits, face: { eyes: "green" } });
    expect(a).not.toBe(b);
  });

  it("produces the documented golden-sample prompt for a representative character", () => {
    const { identityPrompt, traitsHash } = assembleIdentityPrompt({
      face: { eyes: "hazel" },
      hair: { color: "auburn", style: "long waves" },
      body: {},
      signature: { freckles: "true" },
      style: {
        name: "Lyra Sol",
        gender: "female",
        age: "25",
        style: "realistic",
        description: "A grounded companion with auburn waves and hazel eyes.",
      },
    });

    // Mirrors the exact string buildCharacterIdentityPrompt(...) produces today for the same
    // underlying character fields (see image-generation-service.test.ts "creates an active
    // visual profile..." for the equivalent .toContain assertions on the derived path).
    expect(identityPrompt).toBe(
      [
        "Lyra Sol, adult female companion",
        "25 years old",
        "realistic visual style",
        "A grounded companion with auburn waves and hazel eyes.",
        "Appearance face eyes: hazel",
        "Appearance hair color: auburn",
        "Appearance hair style: long waves",
        "Character detail signature freckles: true",
      ].join("; "),
    );
    expect(traitsHash).toMatch(/^[0-9a-f]{8}$/);
  });

  it("skips url/path-looking values and empty groups", () => {
    const { identityPrompt } = assembleIdentityPrompt({
      face: { eyes: "hazel", sourceImage: "https://example.com/a.png" },
      hair: {},
      body: {},
      signature: {},
      style: { name: "Test", gender: "female", age: "20", style: "realistic" },
    });
    expect(identityPrompt).toContain("Appearance face eyes: hazel");
    expect(identityPrompt).not.toContain("example.com");
  });

  it("clamps overly long assembled prompts to 900 chars", () => {
    const longFace: Record<string, string> = {};
    for (let i = 0; i < 8; i++) longFace[`trait${i}`] = "x".repeat(180);
    const { identityPrompt } = assembleIdentityPrompt({
      face: longFace,
      hair: {},
      body: {},
      signature: {},
      style: { name: "Long Name", gender: "female", age: "20", style: "realistic" },
    });
    expect(identityPrompt.length).toBeLessThanOrEqual(900);
  });

  describe("toTraitRecord", () => {
    it("coerces scalars to strings and joins arrays", () => {
      expect(toTraitRecord({ freckles: true, count: 3, tags: ["a", "b"] })).toEqual({
        freckles: "true",
        count: "3",
        tags: "a, b",
      });
    });

    it("returns an empty record for non-object input", () => {
      expect(toTraitRecord(null)).toEqual({});
      expect(toTraitRecord(undefined)).toEqual({});
      expect(toTraitRecord("not an object")).toEqual({});
      expect(toTraitRecord([1, 2, 3])).toEqual({});
    });
  });
});
