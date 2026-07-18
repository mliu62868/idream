import { describe, expect, it } from "vitest";
import {
  characterQaAuthorityMatches,
  characterQaProvenanceMatchesRun,
  latestCharacterQaAuthorityRun,
  type CharacterQaAuthoritySnapshot,
} from "./character-qa-authority";

const authority: CharacterQaAuthoritySnapshot & { evidenceHash: string } = {
  characterId: "character-1",
  projectId: "project-1",
  characterContentVersionId: "content-1",
  projectVersion: 3,
  visualProfileId: "profile-1",
  visualProfileVersion: 2,
  visualProfileHash: "visual-hash",
  referenceSetRevisionId: "references-1",
  referenceSetRevision: 4,
  referenceSetHash: "reference-hash",
  draftAssetPackHash: "pack-hash",
  evidenceHash: "evidence-hash",
};

describe("Character QA authority matching", () => {
  it("matches only the complete exact authority tuple", () => {
    expect(characterQaAuthorityMatches(authority, authority)).toBe(true);
    expect(characterQaAuthorityMatches(
      { ...authority, projectVersion: 4 },
      authority,
    )).toBe(false);
  });

  it("pins provenance evidence to the same QA Run tuple", () => {
    expect(characterQaProvenanceMatchesRun(authority, authority)).toBe(true);
    expect(characterQaProvenanceMatchesRun(
      { ...authority, referenceSetHash: "drifted" },
      authority,
    )).toBe(false);
  });

  it("lets a later failure revoke an earlier pass for the same authority", () => {
    const passed = {
      ...authority,
      id: "qa-pass",
      status: "passed" as const,
      createdAt: "2026-07-16T10:00:00.000Z",
    };
    const failed = {
      ...authority,
      id: "qa-fail",
      status: "failed" as const,
      createdAt: "2026-07-16T10:01:00.000Z",
    };

    expect(latestCharacterQaAuthorityRun([passed, failed], authority)).toBe(failed);
  });

  it("lets a later pass recover authority after a failure", () => {
    const failed = {
      ...authority,
      id: "qa-fail",
      status: "failed" as const,
      createdAt: "2026-07-16T10:00:00.000Z",
    };
    const passed = {
      ...authority,
      id: "qa-pass",
      status: "passed" as const,
      createdAt: "2026-07-16T10:01:00.000Z",
    };

    expect(latestCharacterQaAuthorityRun([failed, passed], authority)).toBe(passed);
  });

  it("uses descending id as the deterministic tie-breaker", () => {
    const createdAt = "2026-07-16T10:00:00.000Z";
    const lowerId = {
      ...authority,
      id: "qa-a",
      status: "passed" as const,
      createdAt,
    };
    const higherId = {
      ...authority,
      id: "qa-b",
      status: "failed" as const,
      createdAt,
    };

    expect(latestCharacterQaAuthorityRun([higherId, lowerId], authority)).toBe(higherId);
  });
});
