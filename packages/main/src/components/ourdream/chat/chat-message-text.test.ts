import { describe, expect, it } from "vitest";
import { roleplaySegments } from "./chat-message-text";
import { chatImagePixelsAreBlank } from "./ChatImageAttachmentCard";

describe("roleplay message text", () => {
  it("marks *actions* and leaves quoted dialogue plain", () => {
    expect(roleplaySegments('*smiles softly* "Hello again." *leans closer*')).toEqual([
      { kind: "action", text: "smiles softly" },
      { kind: "text", text: ' "Hello again." ' },
      { kind: "action", text: "leans closer" },
    ]);
  });

  it("reads **strong** before actions and keeps unmatched stars literal", () => {
    expect(roleplaySegments("This is **important**, ok")).toEqual([
      { kind: "text", text: "This is " },
      { kind: "strong", text: "important" },
      { kind: "text", text: ", ok" },
    ]);
    // Mid-stream: the closing star has not arrived yet.
    expect(roleplaySegments("She *turns")).toEqual([{ kind: "text", text: "She *turns" }]);
    expect(roleplaySegments("2 * 3 * 4")).toEqual([{ kind: "text", text: "2 * 3 * 4" }]);
  });

  it("never lets an action span a line break", () => {
    expect(roleplaySegments("*waves\nand walks* away")).toEqual([{ kind: "text", text: "*waves\nand walks* away" }]);
  });

  it("returns markup as text, never as HTML", () => {
    expect(roleplaySegments("*<img src=x onerror=alert(1)>*")).toEqual([{ kind: "action", text: "<img src=x onerror=alert(1)>" }]);
  });
});

describe("blank chat image previews", () => {
  const pixels = (...rgba: number[][]) => rgba.flat();

  it("hides a solid preview, black, white or any single colour", () => {
    expect(chatImagePixelsAreBlank(pixels([0, 0, 0, 255], [0, 0, 0, 255], [1, 0, 1, 255]))).toBe(true);
    expect(chatImagePixelsAreBlank(pixels([255, 255, 255, 255], [254, 255, 255, 255]))).toBe(true);
    expect(chatImagePixelsAreBlank(pixels([0, 0, 0, 0], [200, 10, 10, 0]))).toBe(true);
  });

  it("shows a dark night scene with faint highlights", () => {
    expect(chatImagePixelsAreBlank(pixels([3, 3, 6, 255], [2, 2, 4, 255], [8, 7, 18, 255], [3, 3, 5, 255]))).toBe(false);
    expect(chatImagePixelsAreBlank(pixels([4, 4, 4, 255], [4, 4, 7, 255]))).toBe(false);
  });
});
