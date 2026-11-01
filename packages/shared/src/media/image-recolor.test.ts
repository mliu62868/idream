import { describe, expect, it } from "vitest";
import { recolorRgba } from "./image-recolor";

describe("confirmed-region recoloring", () => {
  it("does not mutate Node Buffer input when Gen retains the source for comparison", () => {
    const source = Buffer.from([40, 120, 40, 255]);
    const before = Buffer.from(source);
    const result = recolorRgba({ pixels: source, mask: new Uint8Array([255]), color: "#ff0000" });
    expect(source).toEqual(before);
    expect(result).not.toEqual(new Uint8Array(before));
  });
  it("changes a green region to red without moving pixels or changing the hand beside it", () => {
    const source = new Uint8Array([40, 120, 40, 255, 190, 144, 108, 255, 80, 160, 80, 200]);
    const original = source.slice();
    const result = recolorRgba({ pixels: source, mask: new Uint8Array([255, 0, 255]), color: "#ff0000" });
    expect(result.slice(4, 8)).toEqual(original.slice(4, 8));
    expect(result[0]).toBeGreaterThan(result[1]);
    expect(result[1]).toBe(result[2]);
    expect(result[8]).toBeGreaterThan(result[0]);
    expect(result[11]).toBe(200);
    expect(source).toEqual(original);
  });

  it("retains lightness, highlights, alpha and every unselected byte", () => {
    const source = new Uint8Array([0, 0, 0, 255, 255, 255, 255, 128, 18, 97, 54, 255, 91, 150, 118, 255, 32, 10, 6, 0]);
    const result = recolorRgba({ pixels: source, mask: new Uint8Array([255, 255, 255, 255, 0]), color: "#5252e0" });
    expect(result.slice(0, 8)).toEqual(source.slice(0, 8));
    expect(result.slice(16)).toEqual(source.slice(16));
    for (let offset = 0; offset < source.length; offset += 4) {
      const lightness = (pixels: Uint8Array) => Math.max(...pixels.slice(offset, offset + 3)) + Math.min(...pixels.slice(offset, offset + 3));
      expect(Math.abs(lightness(result) - lightness(source))).toBeLessThanOrEqual(1);
      expect(result[offset + 3]).toBe(source[offset + 3]);
    }
  });

  it.each([
    { pixels: new Uint8Array(4), mask: new Uint8Array(2), color: "#ff0000" },
    { pixels: new Uint8Array(4), mask: new Uint8Array([128]), color: "#ff0000" },
    { pixels: new Uint8Array(4), mask: new Uint8Array([255]), color: "red" },
  ])("rejects malformed geometry, masks and colors", input => {
    expect(() => recolorRgba(input)).toThrow();
  });
});
