import { describe, expect, it } from "vitest";
import { creatorLevelDefinitionSchema, type CreatorLevelDefinition } from "@/lib/creator-studio";
import { CREATOR_LEVELS_ACTIVE_KEY, creatorLevelDefinitionKey, creatorLevelProgram, publishedCreatorLevelDefinition } from "./creator-levels";

const definition: CreatorLevelDefinition = { schemaVersion: 1, definitionVersion: 1, levels: [
  { level: 0, label: "Creator", publicWorks: 0, followers: 0 },
  { level: 1, label: "Published creator", publicWorks: 1, followers: 0 },
  { level: 2, label: "Community creator", publicWorks: 1, followers: 5 },
] };
const pointer = { key: CREATOR_LEVELS_ACTIVE_KEY, value: { schemaVersion: 1, definitionVersion: 1 }, status: "active", version: 2 };
const stored = { key: creatorLevelDefinitionKey(1), value: definition, status: "active", version: 1 };
describe("published Creator level authority", () => {
  it("does not invent thresholds or level zero when no valid definition is active", () => {
    expect(publishedCreatorLevelDefinition(null, stored)).toBeNull();
    expect(publishedCreatorLevelDefinition(pointer, null)).toBeNull();
    expect(creatorLevelProgram(null, { eligible: true, publicWorks: 100, followers: 100 })).toMatchObject({ state: "unavailable", definitionVersion: null, level: null, nextLevel: null });
  });
  it("requires the active pointer, immutable record key/version, and payload version to agree", () => {
    expect(publishedCreatorLevelDefinition(pointer, stored)).toEqual(definition);
    for (const changed of [{ ...stored, status: "draft" }, { ...stored, version: 2 }, { ...stored, key: creatorLevelDefinitionKey(2) }, { ...stored, value: { ...definition, definitionVersion: 2 } }]) {
      expect(publishedCreatorLevelDefinition(pointer, changed)).toBeNull();
    }
    expect(publishedCreatorLevelDefinition({ ...pointer, status: "archived" }, stored)).toBeNull();
  });
  it("applies published custom rules rather than the v1 task configuration", () => {
    const custom = { ...definition, definitionVersion: 3, levels: definition.levels.map(level => level.level === 2 ? { ...level, publicWorks: 7, followers: 19 } : level) };
    expect(creatorLevelProgram(custom, { eligible: true, publicWorks: 2, followers: 5 })).toMatchObject({ definitionVersion: 3, level: { level: 1 }, nextLevel: { publicWorks: 7, followers: 19, remainingPublicWorks: 5, remainingFollowers: 14 } });
  });
  it("computes exact boundaries and allows current eligibility to decrease", () => {
    expect(creatorLevelProgram(definition, { eligible: true, publicWorks: 0, followers: 100 }).level?.level).toBe(0);
    expect(creatorLevelProgram(definition, { eligible: true, publicWorks: 1, followers: 4 }).level?.level).toBe(1);
    expect(creatorLevelProgram(definition, { eligible: true, publicWorks: 1, followers: 5 }).level?.level).toBe(2);
    expect(creatorLevelProgram(definition, { eligible: true, publicWorks: 0, followers: 5 }).level?.level).toBe(0);
  });
  it("never awards an internal/non-customer actor a current level", () => {
    expect(creatorLevelProgram(definition, { eligible: false, publicWorks: 10, followers: 20 })).toMatchObject({ state: "ineligible", level: null, nextLevel: null, definitionVersion: 1 });
  });
  it("rejects decreasing, duplicate, fractional and mismatched published rule shapes", () => {
    for (const levels of [
      definition.levels.map(level => level.level === 0 ? { ...level, publicWorks: 1 } : level),
      [...definition.levels, { level: 3, label: "Regressed", publicWorks: 0, followers: 6 }],
      [...definition.levels, { level: 3, label: "Same", publicWorks: 1, followers: 5 }],
      definition.levels.map(level => ({ ...level, followers: level.followers + 0.5 })),
    ]) expect(creatorLevelDefinitionSchema.safeParse({ ...definition, levels }).success).toBe(false);
  });
});
