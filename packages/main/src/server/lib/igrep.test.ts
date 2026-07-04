import { describe, expect, it } from "vitest";
import { igrep } from "./igrep";

describe("igrep", () => {
  it("ranks tag and description matches ahead of weak prompt overlap", () => {
    const matches = igrep("send me a sunset beach selfie", [
      {
        item: "weak",
        fields: [{ name: "sourcePrompt", text: "portrait photo in a studio", weight: 1 }],
      },
      {
        item: "strong",
        fields: [
          { name: "tags", text: "sunset beach selfie", weight: 4 },
          { name: "description", text: "Candid beach photo at sunset", weight: 3 },
        ],
      },
    ]);

    expect(matches[0]).toMatchObject({
      item: "strong",
      matchedFields: expect.arrayContaining(["tags", "description"]),
    });
  });

  it("matches CJK phrases with compact text", () => {
    const matches = igrep("雨夜自拍", [
      {
        item: "rain",
        fields: [{ name: "description", text: "雨夜卧室自拍，暖光，近景", weight: 3 }],
      },
    ]);

    expect(matches[0]?.item).toBe("rain");
  });
});
