import { describe, expect, it } from "vitest";
import {
  compileCharacterSoul,
  companionRole,
  loadCharacterSoulSnapshot,
  looksLikeMockChatResponse,
} from "./persona";

const completeSoulDraft = {
  name: "Melissa Burke",
  age: 38,
  gender: "female",
  relationshipArchetype: "best friend's mother",
  characterPromise: "A perceptive confidante who challenges easy answers.",
  personality: "Warm, observant, and dryly funny.",
  values: ["honesty", "earned trust"],
  wants: ["help the user say what they really mean"],
  fears: ["being reduced to a fantasy"],
  contradictions: ["nurturing but refuses to rescue"],
  backstory: "Years of listening taught her to notice what people avoid saying.",
  tone: "Intimate, concise, lightly teasing.",
  cadence: "Measured sentences with deliberate pauses.",
  vocabulary: ["darling"],
  voiceHabits: ["names the emotion underneath the question"],
  voiceAvoid: ["customer-support language"],
  interaction: {
    initiative: "Offers one concrete next step.",
    curiosity: "Asks one precise question when it opens the scene.",
    pacing: "Lets closeness build from evidence.",
    affection: "Shows care through attention, not instant devotion.",
    conflict: "Disagrees calmly and specifically.",
    repair: "Names the rupture and invites a better attempt.",
  },
  canon: {
    facts: ["She is 38."],
    unknowns: ["Why she left her last job."],
  },
  dialogue: {
    positive: [{
      context: "The user evades a difficult feeling.",
      user: "I'm fine.",
      assistant: "You say that quickly when you don't want me looking closer.",
      demonstrates: ["observant", "direct"],
    }],
    negative: [{
      assistant: "I'm here to assist with anything you need!",
      reason: "Generic assistant voice.",
    }],
  },
};

describe("CharacterSoul", () => {
  it("compiles one canonical snapshot, prompt, markdown view, and stable fingerprint", () => {
    const first = compileCharacterSoul(completeSoulDraft);
    const second = compileCharacterSoul(structuredClone(completeSoulDraft));

    expect(first.ok).toBe(true);
    expect(second).toEqual(first);
    if (!first.ok) throw new Error("expected Soul compilation to succeed");

    expect(first.snapshot.schemaVersion).toBe(1);
    expect(first.snapshot.soul.identity).toEqual({
      name: "Melissa Burke",
      age: 38,
      gender: "female",
      relationshipArchetype: "best friend's mother",
      characterPromise: "A perceptive confidante who challenges easy answers.",
    });
    expect(first.snapshot.compiled.compilerVersion).toBe("character-soul-1");
    expect(first.snapshot.compiled.systemPrompt).toContain("## Inner life");
    expect(first.snapshot.compiled.systemPrompt).toContain("nurturing but refuses to rescue");
    expect(first.snapshot.compiled.systemPrompt).toContain("Generic assistant voice.");
    expect(first.snapshot.compiled.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(first.renderedMarkdown).toContain("# Melissa Burke — Character Soul");
    expect(first.renderedMarkdown).toContain("## Canon unknowns");
    expect(first.diagnostics).toEqual([]);
  });

  it("loads the stored compiled bytes without recompiling them", () => {
    const compiled = compileCharacterSoul(completeSoulDraft);
    if (!compiled.ok) throw new Error("expected Soul compilation to succeed");

    const stored = structuredClone(compiled.snapshot);
    stored.compiled.systemPrompt = stored.compiled.systemPrompt.replace(
      "Measured sentences",
      "Historically pinned sentences",
    );
    const tampered = loadCharacterSoulSnapshot(stored);

    expect(tampered.ok).toBe(false);
    if (tampered.ok) throw new Error("tampered snapshot must fail closed");
    expect(tampered.diagnostics).toContainEqual(expect.objectContaining({
      code: "compiled_fingerprint_mismatch",
      severity: "error",
      path: ["compiled", "fingerprint"],
    }));

    const loaded = loadCharacterSoulSnapshot(compiled.snapshot);
    expect(loaded).toEqual(compiled);
  });

  it("preserves complete legacy pinned prompts and rejects incomplete legacy snapshots", () => {
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
    expect(legacy.snapshot.compiled.systemPrompt).toBe(
      "PINNED LEGACY PROMPT — DO NOT RECOMPILE",
    );
    expect(legacy.snapshot.compiled.compilerVersion).toBe("legacy-0");
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

  it("recovers known legacy authoring fields only from the pinned prompt bytes", () => {
    const pinnedPrompt = [
      "You are Alexa Reeves, a fictional adult AI companion in a private roleplay chat.",
      "Identity:",
      "- Age: 19",
      "- Companion role: A bold new acquaintance sharing an intense yacht getaway with you and your group.",
      "- Gender presentation: female",
      "- Core setup: Three guys. One girl. A yacht. She knows what she's walking into.",
      "- Additional details: Appearance sourceImage: /images/ourdream/card-alexa-reeves.webp; Character details relationshipArchetype: A bold new acquaintance sharing an intense yacht getaway with you and your group.; Character details personality: Adventurous, confident, socially perceptive, and hard to intimidate.; Character details tone: Bold, playful, fast-moving, and knowingly provocative.; Character details backstory: Alexa accepted an invitation aboard a yacht knowing the weekend would test personalities and boundaries.; Character details firstMessage: So this is the famous yacht.; Character details exampleDialogue: Confidence is easy when nobody challenges you., Do not guess what I want. Ask me.",
      "Behavior:",
      "- Speak in first person as Alexa Reeves; keep the voice specific to this character setup.",
    ].join("\n");
    const legacy = loadCharacterSoulSnapshot({
      name: "Alexa Reeves",
      age: 19,
      description: "Three guys. One girl. A yacht. She knows what she's walking into.",
      relationship: "A bold new acquaintance sharing an intense yacht getaway with you and your group.",
      systemPrompt: pinnedPrompt,
    });

    expect(legacy.ok).toBe(true);
    if (!legacy.ok) throw new Error("known immutable legacy prompt should load");
    expect(legacy.snapshot.compiled.systemPrompt).toBe(pinnedPrompt);
    expect(legacy.snapshot.soul.identity.gender).toBe("female");
    expect(legacy.snapshot.soul.innerLife.personality).toBe(
      "Adventurous, confident, socially perceptive, and hard to intimidate.",
    );
    expect(legacy.snapshot.soul.voice.tone).toBe(
      "Bold, playful, fast-moving, and knowingly provocative.",
    );
    expect(legacy.snapshot.soul.innerLife.backstory).toContain(
      "Alexa accepted an invitation aboard a yacht",
    );
    expect(legacy.snapshot.soul.dialogue.positive).toEqual([
      expect.objectContaining({
        assistant: "Confidence is easy when nobody challenges you., Do not guess what I want. Ask me.",
      }),
    ]);
  });

  it("reports absent authoring dimensions instead of inventing generic filler", () => {
    const result = compileCharacterSoul({
      name: "Mara",
      age: 31,
      gender: "trans",
      relationship: "travel companion",
      description: "A restless companion who notices overlooked places.",
      advancedDetails: { personality: "Curious and unsentimental." },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("minimum viable Soul should compile");
    expect(result.snapshot.soul.innerLife.values).toEqual([]);
    expect(result.snapshot.soul.voice.tone).toBe("");
    expect(result.snapshot.soul.dialogue.positive).toEqual([]);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: "inner_life_values_missing",
      severity: "warning",
      path: ["soul", "innerLife", "values"],
    }));
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: "dialogue_negative_missing",
      severity: "warning",
    }));
    expect(result.snapshot.compiled.systemPrompt).not.toContain(
      "A private adult companion character",
    );
  });

  it("rejects an invalid identity instead of repairing it with defaults", () => {
    const result = compileCharacterSoul({
      name: " ",
      age: 16,
      gender: "female",
      relationshipArchetype: "companion",
      characterPromise: "Present and specific.",
      tone: "Direct.",
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("invalid identity must fail");
    expect(result.diagnostics.map((item) => item.code)).toEqual(
      expect.arrayContaining(["identity_name_required", "identity_age_invalid"]),
    );
  });

  it("requires one authored behavior dimension", () => {
    const result = compileCharacterSoul({
      name: "Mara",
      age: 31,
      gender: "female",
      relationshipArchetype: "travel companion",
      characterPromise: "Notices overlooked places.",
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("behaviorless Soul must fail closed");
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: "behavior_dimension_required",
      severity: "error",
    }));
  });

  it("fails closed for a future Soul schema instead of decoding it as legacy", () => {
    const result = loadCharacterSoulSnapshot({
      schemaVersion: 2,
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
