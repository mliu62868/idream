import { describe, expect, it } from "vitest";
import { editKeepsIdentity, initialCharacterDraft } from "./CreateWorkspace";

describe("edit wizard identity rule (CR-06)", () => {
  const baseline = { ...initialCharacterDraft(), name: "Avery", hair: "Long dark waves", age: 25 };

  it("keeps the confirmed identity when only the Soul, name or opening changes", () => {
    expect(editKeepsIdentity({
      ...baseline, name: "Avery Vale", description: "New promise", detailsMarkdown: "## New", firstMessage: "Hi.",
    }, baseline)).toBe(true);
  });

  it("requires a new identity once any look-defining trait changes", () => {
    expect(editKeepsIdentity({ ...baseline, hair: "Short silver bob" }, baseline)).toBe(false);
    expect(editKeepsIdentity({ ...baseline, age: 30 }, baseline)).toBe(false);
    expect(editKeepsIdentity({ ...baseline, style: "anime" }, baseline)).toBe(false);
  });
});
