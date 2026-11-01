import { describe, expect, it } from "vitest";
import { imagePoint, maskFromRgba, maskRgba, paintMask, selectConnectedColor } from "./image-edit-mask";

describe("user-confirmed image region", () => {
  it("maps zoomed, scrolled canvas coordinates to the same original pixels", () => {
    expect(imagePoint({ x: 150, y: 210 }, { left: -50, top: 10, width: 400, height: 400 }, 100, 100)).toEqual({ x: 50, y: 50 });
    expect(imagePoint({ x: 500, y: -1 }, { left: 0, top: 0, width: 200, height: 200 }, 100, 100)).toEqual({ x: 99, y: 0 });
  });
  it("fills rapid pointer strokes without gaps, while erase leaves nearby pixels intact", () => {
    const mask = new Uint8Array(100);
    paintMask(mask, 10, 10, { x: 0, y: 5 }, { x: 9, y: 5 }, 1, 255);
    expect([...mask.slice(50, 60)]).toEqual(Array(10).fill(255));
    paintMask(mask, 10, 10, { x: 5, y: 5 }, { x: 5, y: 5 }, 1, 0);
    expect(mask[55]).toBe(0); expect(mask[52]).toBe(255); expect(mask[25]).toBe(0);
    expect([...new Set(mask)]).toEqual([0, 255]);
  });
  it("selects only connected similar pixels, without wrapping rows or selecting detached objects", () => {
    const pixels = new Uint8Array([0, 100, 0, 255, 0, 100, 0, 255, 240, 180, 150, 255,
      240, 180, 150, 255, 240, 180, 150, 255, 0, 100, 0, 255]);
    const mask = new Uint8Array(6);
    selectConnectedColor(mask, pixels, 3, 2, { x: 0, y: 0 }, 10);
    expect([...mask]).toEqual([255, 255, 0, 0, 0, 0]);
    expect(pixels[0]).toBe(0);
  });
  it("roundtrips opaque binary masks and refuses transparency or gray feathering", () => {
    const mask = new Uint8Array([0, 255, 255, 0]);
    expect(maskFromRgba(maskRgba(mask), 2, 2)).toEqual(mask);
    const transparent = maskRgba(mask); transparent[3] = 0;
    expect(() => maskFromRgba(transparent, 2, 2)).toThrow("invalid");
    const gray = maskRgba(mask); gray[4] = 128;
    expect(() => maskFromRgba(gray, 2, 2)).toThrow("invalid");
  });
});
