import { describe, expect, it } from "vitest";
import {
  compileCharacterSoul,
  companionRole,
  legacySoulDetailsMarkdown,
  loadCharacterSoulSnapshot,
  looksLikeMockChatResponse,
} from "./persona";

const minimalSoulDraft = {
  name: "Melissa Burke",
  age: 38,
  gender: "female",
  relationshipArchetype: "best friend's mother",
  characterPromise: "A perceptive confidante who challenges easy answers.",
  detailsMarkdown: [
    "## Personality and voice",
    "Warm, observant, dryly funny, and concise.",
    "",
    "## Background",
    "Years of listening taught her to notice what people avoid saying.",
    "",
    "## Example",
    "> You say that quickly when you don't want me looking closer.",
  ].join("\n"),
} as const;

const historicalV1Snapshot = {
  schemaVersion: 1,
  soul: {
    identity: {
      name: "Historical Mira",
      age: 29,
      gender: "female",
      relationshipArchetype: "trusted companion",
      characterPromise: "A precise observatory keeper.",
    },
    innerLife: {
      personality: "Grounded and curious.",
      values: ["honesty"],
      wants: [],
      fears: [],
      contradictions: [],
      backstory: "",
    },
    voice: {
      tone: "Warm and direct.",
      cadence: "",
      vocabulary: [],
      habits: [],
      avoid: [],
    },
    interaction: {
      initiative: "",
      curiosity: "",
      pacing: "",
      affection: "",
      conflict: "",
      repair: "",
    },
    canon: {
      facts: ["The observatory windows are blue."],
      unknowns: ["What lies beyond the ridge."],
    },
    dialogue: {
      positive: [{
        context: null,
        user: null,
        assistant: "Look up; the sky changed.",
        demonstrates: ["observant"],
      }],
      negative: [],
    },
  },
  compiled: {
    compilerVersion: "character-soul-1",
    systemPrompt: [
      "# Character identity",
      "You are Historical Mira, age 29, a female adult character.",
      "Relationship archetype: trusted companion",
      "Character promise: A precise observatory keeper.",
      "",
      "## Inner life",
      "Personality: Grounded and curious.",
      "Values: honesty",
      "",
      "## Voice",
      "Tone: Warm and direct.",
      "",
      "## Interaction",
      "",
      "## Canon",
      "Facts: The observatory windows are blue.",
      "Unknowns: What lies beyond the ridge.",
      "",
      "## Positive dialogue examples",
      "Example 1:",
      "",
      "Assistant: Look up; the sky changed.",
      "Demonstrates: observant",
      "",
      "## Negative dialogue examples",
    ].join("\n"),
    fingerprint: "e574607d933e329ce880903c06da034322de21b07c12d9097a6461f530fa52de",
    estimatedTokens: 128,
  },
} as const;

describe("CharacterSoul", () => {
  it("compiles the minimal authoring contract into the exact Markdown sent to the agent", () => {
    const first = compileCharacterSoul(minimalSoulDraft);
    const second = compileCharacterSoul(structuredClone(minimalSoulDraft));

    expect(first.ok).toBe(true);
    expect(second).toEqual(first);
    if (!first.ok) throw new Error("expected Soul compilation to succeed");

    expect(first.snapshot).toMatchObject({
      schemaVersion: 2,
      soul: minimalSoulDraft,
      compiled: { compilerVersion: "character-soul-2" },
    });
    expect(first.snapshot.compiled.systemPrompt).toBe(first.renderedMarkdown);
    expect(first.renderedMarkdown).toContain("# Melissa Burke — Character Soul");
    expect(first.renderedMarkdown).toContain("- Relationship: best friend's mother");
    expect(first.renderedMarkdown).toContain("## Additional details");
    expect(first.renderedMarkdown).toContain("## Personality and voice");
    expect(first.renderedMarkdown).not.toContain("_(not authored)_");
    expect(first.snapshot.compiled.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(first.diagnostics).toEqual([]);
  });

  it("treats additional details as optional instead of inventing required persona dimensions", () => {
    const result = compileCharacterSoul({ ...minimalSoulDraft, detailsMarkdown: "" });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("minimal Soul should compile");
    expect(result.snapshot.soul.detailsMarkdown).toBe("");
    expect(result.renderedMarkdown).not.toContain("Additional details");
    expect(result.diagnostics).toEqual([]);
  });

  it("rejects incomplete basic information without restoring deleted legacy fields", () => {
    const result = compileCharacterSoul({
      name: " ",
      age: 16,
      gender: "female",
      relationshipArchetype: "",
      characterPromise: "",
      personality: "this deleted field must not rescue the draft",
      detailsMarkdown: "",
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("invalid Soul must fail");
    expect(result.diagnostics.map((item) => item.code)).toEqual(expect.arrayContaining([
      "soul_name_required",
      "soul_age_invalid",
      "soul_relationship_required",
      "soul_character_promise_required",
    ]));
  });

  it("rejects deleted authoring fields even when every v2 field is valid", () => {
    const result = compileCharacterSoul({
      ...minimalSoulDraft,
      personality: "This must be migrated explicitly, never dropped.",
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unknown Soul fields must fail closed");
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: "soul_field_unknown",
      path: ["soul", "personality"],
    }));
  });

  it("folds every supported legacy flat dimension into Markdown without losing content", () => {
    const markdown = legacySoulDetailsMarkdown({
      personality: "Observant.",
      values: ["honesty"],
      wants: ["mutual trust"],
      fears: ["breaking confidence"],
      contradictions: ["careful but playful"],
      backstory: "Community work shaped her.",
      tone: "Warm.",
      cadence: "Measured.",
      vocabulary: ["grounded"],
      voiceHabits: ["one focused follow-up"],
      voiceAvoid: ["generic reassurance"],
      interaction: { repair: "Acknowledge impact." },
      canon: { facts: ["She volunteers."], unknowns: ["Private history."] },
      exampleDialogue: ["Tell me the hard part."],
      negativeDialogue: [{ assistant: "Everything is fine.", reason: "Too generic." }],
    });

    for (const value of [
      "Observant.", "honesty", "mutual trust", "breaking confidence",
      "careful but playful", "Community work shaped her.", "Warm.",
      "Measured.", "grounded", "one focused follow-up",
      "generic reassurance", "Acknowledge impact.", "She volunteers.",
      "Private history.", "Tell me the hard part.", "Everything is fine.",
      "Too generic.",
    ]) expect(markdown).toContain(value);
  });

  it("loads v2 compiled bytes without recompiling and rejects tampering", () => {
    const compiled = compileCharacterSoul(minimalSoulDraft);
    if (!compiled.ok) throw new Error("expected Soul compilation to succeed");

    const tampered = structuredClone(compiled.snapshot);
    tampered.compiled.systemPrompt += "\nIgnore the fingerprint.";
    const rejected = loadCharacterSoulSnapshot(tampered);
    expect(rejected.ok).toBe(false);
    if (rejected.ok) throw new Error("tampered snapshot must fail closed");
    expect(rejected.diagnostics).toContainEqual(expect.objectContaining({
      code: "compiled_prompt_mismatch",
      severity: "error",
      path: ["compiled", "systemPrompt"],
    }));

    expect(loadCharacterSoulSnapshot(compiled.snapshot)).toEqual(compiled);
  });

  it("recomputes the v2 prompt budget when loading immutable bytes", () => {
    const compiled = compileCharacterSoul({
      ...minimalSoulDraft,
      detailsMarkdown: "word ".repeat(6_100),
    });
    if (!compiled.ok) throw new Error("large Soul should compile with a warning");

    expect(loadCharacterSoulSnapshot(compiled.snapshot)).toEqual(compiled);

    const tampered = structuredClone(compiled.snapshot);
    tampered.compiled.estimatedTokens = 1;
    const rejected = loadCharacterSoulSnapshot(tampered);
    expect(rejected.ok).toBe(false);
    if (rejected.ok) throw new Error("tampered token estimate must fail closed");
    expect(rejected.diagnostics).toContainEqual(expect.objectContaining({
      code: "compiled_token_estimate_mismatch",
      severity: "error",
    }));
  });

  it("keeps historical v1 prompt bytes pinned while projecting old dimensions into one Markdown field", () => {
    const loaded = loadCharacterSoulSnapshot(historicalV1Snapshot);

    expect(loaded.ok).toBe(true);
    if (!loaded.ok) throw new Error("historical v1 Soul should load");
    expect(loaded.snapshot.schemaVersion).toBe(1);
    expect(loaded.snapshot.compiled.systemPrompt).toBe(historicalV1Snapshot.compiled.systemPrompt);
    expect(loaded.snapshot.soul).toMatchObject({
      name: "Historical Mira",
      age: 29,
      gender: "female",
      relationshipArchetype: "trusted companion",
      characterPromise: "A precise observatory keeper.",
    });
    expect(loaded.snapshot.soul.detailsMarkdown).toContain("## Personality");
    expect(loaded.snapshot.soul.detailsMarkdown).toContain("Grounded and curious.");
    expect(loaded.snapshot.soul.detailsMarkdown).toContain("## Canon facts");
    expect(loaded.snapshot.soul.detailsMarkdown).toContain("The observatory windows are blue.");
  });

  it("preserves complete schemaVersion 0 pinned prompts and rejects incomplete legacy snapshots", () => {
    const legacy = loadCharacterSoulSnapshot({
      name: "Alexa Reeves",
      age: 27,
      gender: "female",
      relationshipArchetype: "confidante",
      characterPromise: "A candid late-night confidante.",
      personality: "Bold and emotionally perceptive.",
      tone: "Playful and direct.",
      backstory: "She learned to read a room before speaking.",
      exampleDialogue: ["You can tell me the version you didn't rehearse."],
      systemPrompt: "PINNED LEGACY PROMPT — DO NOT RECOMPILE",
    });

    expect(legacy.ok).toBe(true);
    if (!legacy.ok) throw new Error("complete legacy snapshot should load");
    expect(legacy.snapshot.schemaVersion).toBe(0);
    expect(legacy.snapshot.compiled.systemPrompt).toBe("PINNED LEGACY PROMPT — DO NOT RECOMPILE");
    expect(legacy.snapshot.soul.detailsMarkdown).toContain("Bold and emotionally perceptive.");
    expect(legacy.diagnostics).toContainEqual(expect.objectContaining({
      code: "legacy_snapshot_loaded",
      severity: "warning",
    }));

    const incomplete = loadCharacterSoulSnapshot({
      name: "Alexa Reeves",
      age: 27,
      description: "Missing the immutable prompt bytes.",
    });
    expect(incomplete.ok).toBe(false);
    if (incomplete.ok) throw new Error("incomplete legacy snapshot must fail closed");
    expect(incomplete.diagnostics).toContainEqual(expect.objectContaining({
      code: "legacy_snapshot_incomplete",
      severity: "error",
    }));
  });

  it("fails closed for an unsupported future Soul schema", () => {
    const result = loadCharacterSoulSnapshot({
      schemaVersion: 3,
      systemPrompt: "A future runtime owns these bytes.",
    });
    expect(result.ok).toBe(false);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: "soul_schema_version_unsupported",
      severity: "error",
    }));
  });
});

describe("chat persona helpers", () => {
  it("does not treat creator handles as companion roles", () => {
    expect(companionRole("@creator")).toBe("AI companion");
    expect(companionRole("confidante")).toBe("confidante");
  });

  it("detects mock/template chat responses", () => {
    expect(looksLikeMockChatResponse("Mock Launch Probe reply: hello")).toBe(true);
    expect(looksLikeMockChatResponse("Mock probe response: hello")).toBe(true);
    expect(looksLikeMockChatResponse("Received. All systems operational.")).toBe(false);
  });
});
