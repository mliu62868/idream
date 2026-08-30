import { describe, expect, it } from "vitest";
import { stableJson } from "./stable-json";

describe("stableJson", () => {
  it("sorts nested keys and omits undefined object fields", () => {
    expect(stableJson({ z: 1, a: { y: undefined, x: 2 } }))
      .toBe('{"a":{"x":2},"z":1}');
  });

  it("rejects values that JSON cannot represent exactly", () => {
    expect(() => stableJson({ value: Number.NaN })).toThrow(/unsupported number/);
  });
});
