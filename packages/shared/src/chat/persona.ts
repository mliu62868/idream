import { createHash } from "node:crypto";

export const CHARACTER_SOUL_SCHEMA_VERSION = 1 as const;
export const CHARACTER_SOUL_COMPILER_VERSION = "character-soul-1" as const;

export type CharacterSoulGender = "female" | "male" | "trans";

export interface SoulDiagnostic {
  code: string;
  path: string[];
  severity: "error" | "warning";
  message: string;
}

export interface CharacterSoulSnapshot {
  schemaVersion: 1;
  soul: {
    identity: {
      name: string;
      age: number;
      gender: CharacterSoulGender;
      relationshipArchetype: string;
      characterPromise: string;
    };
    innerLife: {
      personality: string;
      values: string[];
      wants: string[];
      fears: string[];
      contradictions: string[];
      backstory: string;
    };
    voice: {
      tone: string;
      cadence: string;
      vocabulary: string[];
      habits: string[];
      avoid: string[];
    };
    interaction: {
      initiative: string;
      curiosity: string;
      pacing: string;
      affection: string;
      conflict: string;
      repair: string;
    };
    canon: {
      facts: string[];
      unknowns: string[];
    };
    dialogue: {
      positive: Array<{
        context: string | null;
        user: string | null;
        assistant: string;
        demonstrates: string[];
      }>;
      negative: Array<{
        assistant: string;
        reason: string;
      }>;
    };
  };
  compiled: {
    compilerVersion: string;
    systemPrompt: string;
    fingerprint: string;
    estimatedTokens: number;
  };
}

export type CharacterSoulResult =
  | {
      ok: true;
      snapshot: CharacterSoulSnapshot;
      renderedMarkdown: string;
      diagnostics: SoulDiagnostic[];
    }
  | {
      ok: false;
      diagnostics: SoulDiagnostic[];
    };

type Soul = CharacterSoulSnapshot["soul"];

const PROMPT_WARNING_TOKENS = 6_000;

/**
 * SPEC: Compile mutable authoring data into the one immutable Soul contract.
 * INTENT: Authoring adapters may map old flat fields, but missing facts remain
 * empty and visible as diagnostics; the compiler never invents personality.
 */
export function compileCharacterSoul(draft: unknown): CharacterSoulResult {
  const diagnostics: SoulDiagnostic[] = [];
  const root = record(draft);
  if (!root) {
    return failed("soul_draft_invalid", [], "Character Soul draft must be an object.");
  }

  const soul = root.soul
    ? decodeSoul(root.soul, diagnostics)
    : adaptAuthoringDraft(root, diagnostics);
  if (hasErrors(diagnostics)) return { ok: false, diagnostics };

  addCompletenessWarnings(soul, diagnostics);
  if (hasErrors(diagnostics)) return { ok: false, diagnostics };
  const systemPrompt = compileSystemPrompt(soul);
  const estimatedTokens = estimateTokens(systemPrompt);
  if (estimatedTokens > PROMPT_WARNING_TOKENS) {
    diagnostics.push({
      code: "compiled_prompt_budget_exceeded",
      path: ["compiled", "estimatedTokens"],
      severity: "warning",
      message: `Compiled Soul is approximately ${estimatedTokens} tokens; review it instead of silently truncating it.`,
    });
  }
  const compilerVersion = CHARACTER_SOUL_COMPILER_VERSION;
  const fingerprint = soulFingerprint({ soul, compilerVersion, systemPrompt });
  const snapshot: CharacterSoulSnapshot = {
    schemaVersion: CHARACTER_SOUL_SCHEMA_VERSION,
    soul,
    compiled: { compilerVersion, systemPrompt, fingerprint, estimatedTokens },
  };

  return {
    ok: true,
    snapshot,
    renderedMarkdown: renderSoulMarkdown(soul),
    diagnostics,
  };
}

/**
 * SPEC: Decode immutable stored bytes without running the current compiler.
 * INVARIANT: A v1 fingerprint mismatch fails closed; legacy decoding preserves
 * its explicit stored prompt and never borrows mutable Character fields.
 */
export function loadCharacterSoulSnapshot(stored: unknown): CharacterSoulResult {
  const root = record(stored);
  if (!root) {
    return failed("soul_snapshot_invalid", [], "Character Soul snapshot must be an object.");
  }
  if (root.schemaVersion !== CHARACTER_SOUL_SCHEMA_VERSION) {
    return loadLegacySnapshot(root);
  }

  const diagnostics: SoulDiagnostic[] = [];
  const soul = decodeSoul(root.soul, diagnostics);
  const compiled = record(root.compiled);
  if (!compiled) {
    diagnostics.push(errorDiagnostic(
      "compiled_artifact_missing",
      ["compiled"],
      "Stored Soul is missing its immutable compiled artifact.",
    ));
    return { ok: false, diagnostics };
  }
  const compilerVersion = requiredText(
    compiled.compilerVersion,
    diagnostics,
    "compiled_compiler_version_required",
    ["compiled", "compilerVersion"],
  );
  const systemPrompt = requiredText(
    compiled.systemPrompt,
    diagnostics,
    "compiled_system_prompt_required",
    ["compiled", "systemPrompt"],
    false,
  );
  const fingerprint = requiredText(
    compiled.fingerprint,
    diagnostics,
    "compiled_fingerprint_required",
    ["compiled", "fingerprint"],
  );
  const estimatedTokens = positiveInteger(
    compiled.estimatedTokens,
    diagnostics,
    "compiled_token_estimate_invalid",
    ["compiled", "estimatedTokens"],
  );
  if (hasErrors(diagnostics)) return { ok: false, diagnostics };

  const expected = soulFingerprint({ soul, compilerVersion, systemPrompt });
  if (fingerprint !== expected) {
    diagnostics.push(errorDiagnostic(
      "compiled_fingerprint_mismatch",
      ["compiled", "fingerprint"],
      "Stored Soul fingerprint does not match its canonical Soul and compiled prompt bytes.",
    ));
    return { ok: false, diagnostics };
  }

  addCompletenessWarnings(soul, diagnostics);
  if (hasErrors(diagnostics)) return { ok: false, diagnostics };
  return {
    ok: true,
    snapshot: {
      schemaVersion: CHARACTER_SOUL_SCHEMA_VERSION,
      soul,
      compiled: { compilerVersion, systemPrompt, fingerprint, estimatedTokens },
    },
    renderedMarkdown: renderSoulMarkdown(soul),
    diagnostics,
  };
}

export function companionRole(relationship?: string | null): string {
  const value = cleanText(relationship);
  if (!value || value.startsWith("@")) return "AI companion";
  return value;
}

export function looksLikeMockChatResponse(text: string): boolean {
  const normalized = text.trim();
  return /^Mock\s+/i.test(normalized) || /^Mock probe response:/i.test(normalized);
}

function adaptAuthoringDraft(
  root: Record<string, unknown>,
  diagnostics: SoulDiagnostic[],
): Soul {
  const advanced = record(root.advancedDetails) ?? {};
  const interaction = record(root.interaction) ?? record(advanced.interaction) ?? {};
  const canon = record(root.canon) ?? record(advanced.canon) ?? {};
  const dialogue = record(root.dialogue) ?? record(advanced.dialogue) ?? {};
  const examples = root.exampleDialogue ?? advanced.exampleDialogue;

  return decodeSoul({
    identity: {
      name: root.name,
      age: root.age,
      gender: root.gender,
      relationshipArchetype:
        root.relationshipArchetype ?? root.relationship ?? advanced.relationshipArchetype ?? advanced.relationship,
      characterPromise: root.characterPromise ?? root.description ?? advanced.description,
    },
    innerLife: {
      personality: root.personality ?? advanced.personality,
      values: root.values ?? advanced.values,
      wants: root.wants ?? advanced.wants,
      fears: root.fears ?? advanced.fears,
      contradictions: root.contradictions ?? advanced.contradictions,
      backstory: root.backstory ?? advanced.backstory,
    },
    voice: {
      tone: root.tone ?? advanced.tone ?? advanced.speakingStyle,
      cadence: root.cadence ?? advanced.cadence,
      vocabulary: root.vocabulary ?? advanced.vocabulary,
      habits: root.voiceHabits ?? root.habits ?? advanced.voiceHabits ?? advanced.habits,
      avoid: root.voiceAvoid ?? root.avoid ?? advanced.voiceAvoid ?? advanced.avoid,
    },
    interaction,
    canon,
    dialogue: {
      positive: dialogue.positive ?? legacyDialogueExamples(examples),
      negative: dialogue.negative ?? root.negativeDialogue ?? advanced.negativeDialogue,
    },
  }, diagnostics);
}

function decodeSoul(value: unknown, diagnostics: SoulDiagnostic[]): Soul {
  const root = record(value) ?? {};
  const identity = record(root.identity) ?? {};
  const innerLife = record(root.innerLife) ?? {};
  const voice = record(root.voice) ?? {};
  const interaction = record(root.interaction) ?? {};
  const canon = record(root.canon) ?? {};
  const dialogue = record(root.dialogue) ?? {};

  return {
    identity: {
      name: requiredText(identity.name, diagnostics, "identity_name_required", ["soul", "identity", "name"]),
      age: adultAge(identity.age, diagnostics),
      gender: gender(identity.gender, diagnostics),
      relationshipArchetype: requiredText(
        identity.relationshipArchetype,
        diagnostics,
        "identity_relationship_archetype_required",
        ["soul", "identity", "relationshipArchetype"],
      ),
      characterPromise: requiredText(
        identity.characterPromise,
        diagnostics,
        "identity_character_promise_required",
        ["soul", "identity", "characterPromise"],
      ),
    },
    innerLife: {
      personality: optionalText(innerLife.personality),
      values: stringArray(innerLife.values, diagnostics, ["soul", "innerLife", "values"]),
      wants: stringArray(innerLife.wants, diagnostics, ["soul", "innerLife", "wants"]),
      fears: stringArray(innerLife.fears, diagnostics, ["soul", "innerLife", "fears"]),
      contradictions: stringArray(innerLife.contradictions, diagnostics, ["soul", "innerLife", "contradictions"]),
      backstory: optionalText(innerLife.backstory),
    },
    voice: {
      tone: optionalText(voice.tone),
      cadence: optionalText(voice.cadence),
      vocabulary: stringArray(voice.vocabulary, diagnostics, ["soul", "voice", "vocabulary"]),
      habits: stringArray(voice.habits, diagnostics, ["soul", "voice", "habits"]),
      avoid: stringArray(voice.avoid, diagnostics, ["soul", "voice", "avoid"]),
    },
    interaction: {
      initiative: optionalText(interaction.initiative),
      curiosity: optionalText(interaction.curiosity),
      pacing: optionalText(interaction.pacing),
      affection: optionalText(interaction.affection),
      conflict: optionalText(interaction.conflict),
      repair: optionalText(interaction.repair),
    },
    canon: {
      facts: stringArray(canon.facts, diagnostics, ["soul", "canon", "facts"]),
      unknowns: stringArray(canon.unknowns, diagnostics, ["soul", "canon", "unknowns"]),
    },
    dialogue: {
      positive: positiveDialogue(dialogue.positive, diagnostics),
      negative: negativeDialogue(dialogue.negative, diagnostics),
    },
  };
}

function loadLegacySnapshot(root: Record<string, unknown>): CharacterSoulResult {
  const legacyPrompt = typeof root.systemPrompt === "string"
    ? root.systemPrompt.trim()
    : "";
  const promptFields = legacyPrompt ? legacyPromptAuthoringFields(legacyPrompt) : {};
  const legacyDraft = {
    ...root,
    gender: optionalText(root.gender) || promptFields.gender,
    relationshipArchetype:
      optionalText(root.relationshipArchetype) ||
      optionalText(root.relationship) ||
      promptFields.relationshipArchetype,
    characterPromise:
      optionalText(root.characterPromise) ||
      optionalText(root.description) ||
      promptFields.characterPromise,
    personality: optionalText(root.personality) || promptFields.personality,
    tone: optionalText(root.tone) || promptFields.tone,
    backstory: optionalText(root.backstory) || promptFields.backstory,
    exampleDialogue:
      root.exampleDialogue ??
      (promptFields.exampleDialogue ? [promptFields.exampleDialogue] : undefined),
  };
  const relationship = optionalText(legacyDraft.relationshipArchetype);
  const description = optionalText(legacyDraft.characterPromise);
  const behavior = optionalText(legacyDraft.personality) || optionalText(legacyDraft.tone);
  if (
    !optionalText(root.name) ||
    typeof root.age !== "number" ||
    !Number.isInteger(root.age) ||
    root.age < 18 ||
    !description ||
    !relationship ||
    !behavior ||
    !legacyPrompt
  ) {
    return failed(
      "legacy_snapshot_incomplete",
      [],
      "Legacy pinned Soul must contain identity, behavior, relationship, and explicit compiled prompt bytes.",
    );
  }

  const diagnostics: SoulDiagnostic[] = [];
  const soul = adaptAuthoringDraft(legacyDraft, diagnostics);
  if (hasErrors(diagnostics)) return { ok: false, diagnostics };
  addCompletenessWarnings(soul, diagnostics);
  diagnostics.push({
    code: "legacy_snapshot_loaded",
    path: ["schemaVersion"],
    severity: "warning",
    message: "Loaded an immutable schemaVersion 0 Soul through the explicit legacy adapter.",
  });
  const compilerVersion = "legacy-0";
  const fingerprint = soulFingerprint({ soul, compilerVersion, systemPrompt: legacyPrompt });
  const snapshot: CharacterSoulSnapshot = {
    schemaVersion: CHARACTER_SOUL_SCHEMA_VERSION,
    soul,
    compiled: {
      compilerVersion,
      systemPrompt: legacyPrompt,
      fingerprint,
      estimatedTokens: estimateTokens(legacyPrompt),
    },
  };
  return {
    ok: true,
    snapshot,
    renderedMarkdown: renderSoulMarkdown(soul),
    diagnostics,
  };
}

/**
 * INTENT: schemaVersion 0 stored a flattened prompt beside a sparse snapshot.
 * Recover only labels emitted by that exact historical compiler; never consult
 * the mutable Character projection and never manufacture a missing value.
 */
function legacyPromptAuthoringFields(systemPrompt: string): Partial<{
  gender: CharacterSoulGender;
  relationshipArchetype: string;
  characterPromise: string;
  personality: string;
  tone: string;
  backstory: string;
  exampleDialogue: string;
}> {
  const fields: Partial<{
    gender: CharacterSoulGender;
    relationshipArchetype: string;
    characterPromise: string;
    personality: string;
    tone: string;
    backstory: string;
    exampleDialogue: string;
  }> = {};
  const genderMatch = systemPrompt.match(/^- Gender presentation:\s*(female|male|trans)\s*$/im);
  if (genderMatch?.[1]) fields.gender = genderMatch[1].toLowerCase() as CharacterSoulGender;
  const relationshipMatch = systemPrompt.match(/^- Companion role:\s*(.+)$/im);
  if (relationshipMatch?.[1]) fields.relationshipArchetype = cleanText(relationshipMatch[1]);
  const promiseMatch = systemPrompt.match(/^- Core setup:\s*(.+)$/im);
  if (promiseMatch?.[1]) fields.characterPromise = cleanText(promiseMatch[1]);

  const additional = systemPrompt.match(/^- Additional details:\s*(.+)$/im)?.[1] ?? "";
  const marker = /Character details (relationshipArchetype|personality|tone|backstory|firstMessage|exampleDialogue):\s*/g;
  const matches = [...additional.matchAll(marker)];
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    const key = match[1];
    const start = (match.index ?? 0) + match[0].length;
    const end = matches[index + 1]?.index ?? additional.length;
    const value = cleanText(additional.slice(start, end).replace(/;\s*$/, ""));
    if (!value) continue;
    if (key === "relationshipArchetype") fields.relationshipArchetype = value;
    if (key === "personality") fields.personality = value;
    if (key === "tone") fields.tone = value;
    if (key === "backstory") fields.backstory = value;
    if (key === "exampleDialogue") fields.exampleDialogue = value;
  }
  return fields;
}

function addCompletenessWarnings(soul: Soul, diagnostics: SoulDiagnostic[]): void {
  if (!soul.innerLife.personality && !soul.voice.tone) {
    diagnostics.push(errorDiagnostic(
      "behavior_dimension_required",
      ["soul"],
      "At least innerLife.personality or voice.tone is required.",
    ));
  }
  const missing: Array<[boolean, string, string[]]> = [
    [soul.innerLife.values.length === 0, "inner_life_values_missing", ["soul", "innerLife", "values"]],
    [soul.innerLife.wants.length === 0, "inner_life_wants_missing", ["soul", "innerLife", "wants"]],
    [soul.innerLife.fears.length === 0, "inner_life_fears_missing", ["soul", "innerLife", "fears"]],
    [soul.innerLife.contradictions.length === 0, "inner_life_contradictions_missing", ["soul", "innerLife", "contradictions"]],
    [!soul.innerLife.backstory, "inner_life_backstory_missing", ["soul", "innerLife", "backstory"]],
    [!soul.voice.tone, "voice_tone_missing", ["soul", "voice", "tone"]],
    [!soul.voice.cadence, "voice_cadence_missing", ["soul", "voice", "cadence"]],
    [soul.voice.vocabulary.length === 0, "voice_vocabulary_missing", ["soul", "voice", "vocabulary"]],
    [soul.voice.habits.length === 0, "voice_habits_missing", ["soul", "voice", "habits"]],
    [soul.voice.avoid.length === 0, "voice_avoid_missing", ["soul", "voice", "avoid"]],
    [Object.values(soul.interaction).some((item) => !item), "interaction_dimension_missing", ["soul", "interaction"]],
    [soul.canon.facts.length === 0, "canon_facts_missing", ["soul", "canon", "facts"]],
    [soul.canon.unknowns.length === 0, "canon_unknowns_missing", ["soul", "canon", "unknowns"]],
    [soul.dialogue.positive.length === 0, "dialogue_positive_missing", ["soul", "dialogue", "positive"]],
    [soul.dialogue.negative.length === 0, "dialogue_negative_missing", ["soul", "dialogue", "negative"]],
  ];
  for (const [isMissing, code, path] of missing) {
    if (!isMissing) continue;
    diagnostics.push({
      code,
      path,
      severity: "warning",
      message: `${path.join(".")} is empty; author it explicitly or keep the gap visible.`,
    });
  }
}

function compileSystemPrompt(soul: Soul): string {
  const lines = [
    `# Character identity`,
    `You are ${soul.identity.name}, age ${soul.identity.age}, a ${soul.identity.gender} adult character.`,
    `Relationship archetype: ${soul.identity.relationshipArchetype}`,
    `Character promise: ${soul.identity.characterPromise}`,
    "",
    "## Inner life",
    line("Personality", soul.innerLife.personality),
    listLine("Values", soul.innerLife.values),
    listLine("Wants", soul.innerLife.wants),
    listLine("Fears", soul.innerLife.fears),
    listLine("Contradictions", soul.innerLife.contradictions),
    line("Backstory", soul.innerLife.backstory),
    "",
    "## Voice",
    line("Tone", soul.voice.tone),
    line("Cadence", soul.voice.cadence),
    listLine("Vocabulary", soul.voice.vocabulary),
    listLine("Habits", soul.voice.habits),
    listLine("Avoid", soul.voice.avoid),
    "",
    "## Interaction",
    ...Object.entries(soul.interaction).map(([key, value]) => line(title(key), value)),
    "",
    "## Canon",
    listLine("Facts", soul.canon.facts),
    listLine("Unknowns", soul.canon.unknowns),
    "",
    "## Positive dialogue examples",
    ...soul.dialogue.positive.flatMap((example, index) => [
      `Example ${index + 1}:`,
      line("Context", example.context ?? ""),
      line("User", example.user ?? ""),
      `Assistant: ${example.assistant}`,
      listLine("Demonstrates", example.demonstrates),
    ]),
    "",
    "## Negative dialogue examples",
    ...soul.dialogue.negative.flatMap((example, index) => [
      `Counterexample ${index + 1}: ${example.assistant}`,
      `Reason: ${example.reason}`,
    ]),
  ];
  return lines.filter((value, index, all) => value || all[index - 1] !== "").join("\n").trim();
}

function renderSoulMarkdown(soul: Soul): string {
  return [
    `# ${soul.identity.name} — Character Soul`,
    "",
    "## Identity",
    `- Age: ${soul.identity.age}`,
    `- Gender: ${soul.identity.gender}`,
    `- Relationship archetype: ${soul.identity.relationshipArchetype}`,
    `- Character promise: ${soul.identity.characterPromise}`,
    "",
    "## Inner life",
    markdownField("Personality", soul.innerLife.personality),
    markdownList("Values", soul.innerLife.values),
    markdownList("Wants", soul.innerLife.wants),
    markdownList("Fears", soul.innerLife.fears),
    markdownList("Contradictions", soul.innerLife.contradictions),
    markdownField("Backstory", soul.innerLife.backstory),
    "",
    "## Voice",
    markdownField("Tone", soul.voice.tone),
    markdownField("Cadence", soul.voice.cadence),
    markdownList("Vocabulary", soul.voice.vocabulary),
    markdownList("Habits", soul.voice.habits),
    markdownList("Avoid", soul.voice.avoid),
    "",
    "## Interaction",
    ...Object.entries(soul.interaction).map(([key, value]) => markdownField(title(key), value)),
    "",
    "## Canon facts",
    ...markdownBullets(soul.canon.facts),
    "",
    "## Canon unknowns",
    ...markdownBullets(soul.canon.unknowns),
    "",
    "## Positive dialogue",
    ...soul.dialogue.positive.flatMap((example) => [
      example.context ? `- Context: ${example.context}` : "",
      example.user ? `  - User: ${example.user}` : "",
      `  - Assistant: ${example.assistant}`,
      ...example.demonstrates.map((item) => `  - Demonstrates: ${item}`),
    ]).filter(Boolean),
    "",
    "## Negative dialogue",
    ...soul.dialogue.negative.flatMap((example) => [
      `- Assistant: ${example.assistant}`,
      `  - Reason: ${example.reason}`,
    ]),
  ].join("\n").trim();
}

function positiveDialogue(
  value: unknown,
  diagnostics: SoulDiagnostic[],
): Soul["dialogue"]["positive"] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    diagnostics.push(errorDiagnostic("dialogue_positive_invalid", ["soul", "dialogue", "positive"], "Positive dialogue must be an array."));
    return [];
  }
  return value.flatMap((item, index) => {
    const row = record(item);
    const assistant = row ? optionalText(row.assistant) : "";
    if (!row || !assistant) {
      diagnostics.push(errorDiagnostic("dialogue_positive_example_invalid", ["soul", "dialogue", "positive", String(index)], "Positive dialogue examples require assistant text."));
      return [];
    }
    return [{
      context: optionalText(row.context) || null,
      user: optionalText(row.user) || null,
      assistant,
      demonstrates: stringArray(row.demonstrates, diagnostics, ["soul", "dialogue", "positive", String(index), "demonstrates"]),
    }];
  });
}

function negativeDialogue(
  value: unknown,
  diagnostics: SoulDiagnostic[],
): Soul["dialogue"]["negative"] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    diagnostics.push(errorDiagnostic("dialogue_negative_invalid", ["soul", "dialogue", "negative"], "Negative dialogue must be an array."));
    return [];
  }
  return value.flatMap((item, index) => {
    const row = record(item);
    const assistant = row ? optionalText(row.assistant) : "";
    const reason = row ? optionalText(row.reason) : "";
    if (!row || !assistant || !reason) {
      diagnostics.push(errorDiagnostic("dialogue_negative_example_invalid", ["soul", "dialogue", "negative", String(index)], "Negative dialogue examples require assistant text and a reason."));
      return [];
    }
    return [{ assistant, reason }];
  });
}

function legacyDialogueExamples(value: unknown): unknown[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => ({
    context: null,
    user: null,
    assistant: item,
    demonstrates: [],
  }));
}

function stringArray(value: unknown, diagnostics: SoulDiagnostic[], path: string[]): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    diagnostics.push(errorDiagnostic("soul_string_list_invalid", path, `${path.join(".")} must be an array of strings.`));
    return [];
  }
  const result: string[] = [];
  value.forEach((item, index) => {
    const text = optionalText(item);
    if (!text) {
      diagnostics.push(errorDiagnostic("soul_string_list_item_invalid", [...path, String(index)], "List items must be non-empty strings."));
    } else {
      result.push(text);
    }
  });
  return result;
}

function requiredText(
  value: unknown,
  diagnostics: SoulDiagnostic[],
  code: string,
  path: string[],
  normalize = true,
): string {
  const text = typeof value === "string"
    ? (normalize ? cleanText(value) : value.trim())
    : "";
  if (!text) diagnostics.push(errorDiagnostic(code, path, `${path.join(".")} is required.`));
  return text;
}

function adultAge(value: unknown, diagnostics: SoulDiagnostic[]): number {
  if (typeof value === "number" && Number.isInteger(value) && value >= 18 && value <= 120) return value;
  diagnostics.push(errorDiagnostic("identity_age_invalid", ["soul", "identity", "age"], "Soul identity age must be an integer from 18 to 120."));
  return 0;
}

function gender(value: unknown, diagnostics: SoulDiagnostic[]): CharacterSoulGender {
  if (value === "female" || value === "male" || value === "trans") return value;
  diagnostics.push(errorDiagnostic("identity_gender_invalid", ["soul", "identity", "gender"], "Soul identity gender must be female, male, or trans."));
  return "female";
}

function positiveInteger(value: unknown, diagnostics: SoulDiagnostic[], code: string, path: string[]): number {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
  diagnostics.push(errorDiagnostic(code, path, `${path.join(".")} must be a positive integer.`));
  return 0;
}

function failed(code: string, path: string[], message: string): CharacterSoulResult {
  return { ok: false, diagnostics: [errorDiagnostic(code, path, message)] };
}

function errorDiagnostic(code: string, path: string[], message: string): SoulDiagnostic {
  return { code, path, severity: "error", message };
}

function hasErrors(diagnostics: SoulDiagnostic[]): boolean {
  return diagnostics.some((item) => item.severity === "error");
}

function soulFingerprint(input: { soul: Soul; compilerVersion: string; systemPrompt: string }): string {
  return createHash("sha256").update(canonicalJson(input)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function cleanText(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function optionalText(value: unknown): string {
  return cleanText(value);
}

function line(label: string, value: string): string {
  return value ? `${label}: ${value}` : "";
}

function listLine(label: string, values: string[]): string {
  return values.length ? `${label}: ${values.join(" | ")}` : "";
}

function title(value: string): string {
  return value.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (letter) => letter.toUpperCase());
}

function markdownField(label: string, value: string): string {
  return `- ${label}: ${value || "_(not authored)_"}`;
}

function markdownList(label: string, values: string[]): string {
  return `- ${label}: ${values.length ? values.join("; ") : "_(not authored)_"}`;
}

function markdownBullets(values: string[]): string[] {
  return values.length ? values.map((value) => `- ${value}`) : ["- _(not authored)_"];
}
