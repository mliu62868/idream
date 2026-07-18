import { describe, expect, it } from "vitest";
import { requireMatchingProjectVersion } from "./project-version";

describe("Character Project If-Match authority", () => {
  it("accepts a strong or weak entity tag for the exact body version", () => {
    expect(requireMatchingProjectVersion(new Request("http://localhost", {
      headers: { "if-match": "\"7\"" },
    }), 7)).toBe(7);
    expect(requireMatchingProjectVersion(new Request("http://localhost", {
      headers: { "if-match": "W/\"7\"" },
    }), 7)).toBe(7);
  });

  it("fails closed when the header is missing or identifies another revision", () => {
    expect(() => requireMatchingProjectVersion(
      new Request("http://localhost"),
      7,
    )).toThrow(/If-Match must contain/);
    expect(() => requireMatchingProjectVersion(new Request("http://localhost", {
      headers: { "if-match": "8" },
    }), 7)).toThrow(/same Project revision/);
  });
});
