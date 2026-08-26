import { describe, expect, it } from "vitest";
import { renderCreateSoulMarkdown } from "./CreateWorkspace";

describe("CreateWorkspace Soul preview", () => {
  it("shows the exact deterministic Agent prompt before publish", () => {
    expect(renderCreateSoulMarkdown({
      name: "Mara",
      age: 31,
      gender: "female",
      relationshipArchetype: "old friend",
      description: "A precise confidante.",
      detailsMarkdown: "## Voice\nDry warmth.",
    })).toContain("# Mara — Character Soul\n\nYou are Mara.");
    expect(renderCreateSoulMarkdown({
      name: "Mara",
      age: 31,
      gender: "female",
      relationshipArchetype: "old friend",
      description: "A precise confidante.",
      detailsMarkdown: "## Voice\nDry warmth.",
    })).toContain("## Additional details\n\n## Voice\nDry warmth.");
  });
});
