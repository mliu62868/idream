import { describe, expect, it } from "vitest";
import { renderCharacterSoulMarkdown } from "./persona-render";

describe("Character Soul Markdown renderer", () => {
  it("renders the one browser-safe SOUL.md and Agent prompt artifact", () => {
    expect(renderCharacterSoulMarkdown({
      name: "  Mara  ",
      age: 28,
      gender: "female",
      characterPromise: "A precise place to put the day down.",
      detailsMarkdown: "## Voice\r\nWarm and concise.\r\n",
    })).toBe([
      "# Mara — Character Soul",
      "",
      "You are Mara. Speak and act consistently with this character.",
      "",
      "## Basic information",
      "- Age: 28",
      "- Gender: female",
      "- Character: A precise place to put the day down.",
      "",
      "## Additional details",
      "",
      "## Voice\nWarm and concise.",
    ].join("\n"));
  });
});
