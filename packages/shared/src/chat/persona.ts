import { createHash } from "node:crypto";

export const CHARACTER_SOUL_SCHEMA_VERSION = 2 as const;
export const CHARACTER_SOUL_COMPILER_VERSION = "character-soul-2" as const;

export type CharacterSoulGender = "female" | "male" | "trans";

export interface SoulDiagnostic {
  code: string;
  path: string[];
  severity: "error" | "warning";
  message: string;
}

export interface CharacterSoul {
  name: string;
  age: number;
  gender: CharacterSoulGender;
  relationshipArchetype: string;
  characterPromise: string;
  detailsMarkdown: string;
}

export interface CompiledCharacterSoul {
  compilerVersion: string;
  systemPrompt: string;
  fingerprint: string;
  estimatedTokens: number;
}

export interface CharacterSoulSnapshot {
  schemaVersion: 2;
  soul: CharacterSoul;
  compiled: CompiledCharacterSoul;
}

/**
 * Historical snapshots keep their stored schema marker and compiled bytes.
 * Their old authoring dimensions are projected into the one current details
 * field only for editing and operator display; Chat still receives the pinned
 * historical system prompt.
 */
export interface LoadedCharacterSoulSnapshot {
  schemaVersion: 0 | 1 | 2;
  soul: CharacterSoul;
  compiled: CompiledCharacterSoul;
}

export type CharacterSoulResult<
  TSnapshot extends LoadedCharacterSoulSnapshot = LoadedCharacterSoulSnapshot,
> =
  | {
      ok: true;
      snapshot: TSnapshot;
      renderedMarkdown: string;
      diagnostics: SoulDiagnostic[];
    }
  | {
      ok: false;
      diagnostics: SoulDiagnostic[];
    };

type LegacyV1Soul = {
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

const PROMPT_WARNING_TOKENS = 6_000;

/**
 * SPEC: Character Soul authoring has five required facts and one optional
 * Markdown field. The compiler owns validation, rendering, token estimation,
 * and fingerprinting behind this one interface.
 */
export function compileCharacterSoul(
  draft: unknown,
): CharacterSoulResult<CharacterSoulSnapshot> {
  const root = record(draft);
  if (!root) {
    return failed(
      "soul_draft_invalid",
      [],
      "Character Soul draft must be an object.",
    );
  }
  const diagnostics: SoulDiagnostic[] = [];
  const soul = decodeSoul(record(root.soul) ?? root, diagnostics);
  if (hasErrors(diagnostics)) return { ok: false, diagnostics };

  const systemPrompt = renderSoulMarkdown(soul);
  const estimatedTokens = estimateTokens(systemPrompt);
  if (estimatedTokens > PROMPT_WARNING_TOKENS) {
    diagnostics.push({
      code: "compiled_prompt_budget_exceeded",
      path: ["compiled", "estimatedTokens"],
      severity: "warning",
      message: `Compiled Soul is approximately ${estimatedTokens} tokens; shorten Additional details before release.`,
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
    renderedMarkdown: systemPrompt,
    diagnostics,
  };
}

/**
 * SPEC: immutable v2 bytes are verified, never recompiled. Historical v0/v1
 * bytes remain readable so existing sessions keep their exact pinned prompt.
 */
export function loadCharacterSoulSnapshot(
  stored: unknown,
): CharacterSoulResult {
  const root = record(stored);
  if (!root) {
    return failed(
      "soul_snapshot_invalid",
      [],
      "Character Soul snapshot must be an object.",
    );
  }
  if (
    root.schemaVersion === undefined ||
    root.schemaVersion === null ||
    root.schemaVersion === 0
  ) {
    return loadLegacySnapshot(root);
  }
  if (root.schemaVersion === 1) return loadV1Snapshot(root);
  if (root.schemaVersion !== CHARACTER_SOUL_SCHEMA_VERSION) {
    return failed(
      "soul_schema_version_unsupported",
      ["schemaVersion"],
      `Character Soul schema ${String(root.schemaVersion)} is not supported by this runtime.`,
    );
  }

  const diagnostics: SoulDiagnostic[] = [];
  const soul = decodeSoul(record(root.soul) ?? {}, diagnostics);
  const compiled = decodeCompiled(root.compiled, diagnostics);
  if (hasErrors(diagnostics) || !compiled) return { ok: false, diagnostics };
  const renderedMarkdown = renderSoulMarkdown(soul);
  if (
    compiled.compilerVersion !== CHARACTER_SOUL_COMPILER_VERSION ||
    compiled.systemPrompt !== renderedMarkdown
  ) {
    diagnostics.push(errorDiagnostic(
      "compiled_prompt_mismatch",
      ["compiled", "systemPrompt"],
      "Stored Soul prompt does not match the schema v2 compiler output.",
    ));
    return { ok: false, diagnostics };
  }
  if (compiled.fingerprint !== soulFingerprint({
    soul,
    compilerVersion: compiled.compilerVersion,
    systemPrompt: compiled.systemPrompt,
  })) {
    diagnostics.push(fingerprintMismatch());
    return { ok: false, diagnostics };
  }
  const estimatedTokens = estimateTokens(compiled.systemPrompt);
  if (compiled.estimatedTokens !== estimatedTokens) {
    diagnostics.push(errorDiagnostic(
      "compiled_token_estimate_mismatch",
      ["compiled", "estimatedTokens"],
      "Stored Soul token estimate does not match its compiled prompt bytes.",
    ));
    return { ok: false, diagnostics };
  }
  if (estimatedTokens > PROMPT_WARNING_TOKENS) {
    diagnostics.push({
      code: "compiled_prompt_budget_exceeded",
      path: ["compiled", "estimatedTokens"],
      severity: "warning",
      message: `Compiled Soul is approximately ${estimatedTokens} tokens; shorten Additional details before release.`,
    });
  }
  return {
    ok: true,
    snapshot: { schemaVersion: 2, soul, compiled },
    renderedMarkdown,
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

function decodeSoul(
  root: Record<string, unknown>,
  diagnostics: SoulDiagnostic[],
): CharacterSoul {
  return {
    name: requiredText(
      root.name,
      diagnostics,
      "soul_name_required",
      ["soul", "name"],
    ),
    age: adultAge(root.age, diagnostics, ["soul", "age"]),
    gender: gender(root.gender, diagnostics, ["soul", "gender"]),
    relationshipArchetype: requiredText(
      root.relationshipArchetype,
      diagnostics,
      "soul_relationship_required",
      ["soul", "relationshipArchetype"],
    ),
    characterPromise: requiredText(
      root.characterPromise,
      diagnostics,
      "soul_character_promise_required",
      ["soul", "characterPromise"],
    ),
    detailsMarkdown: markdownText(root.detailsMarkdown),
  };
}

function loadV1Snapshot(root: Record<string, unknown>): CharacterSoulResult {
  const diagnostics: SoulDiagnostic[] = [];
  const legacySoul = decodeV1Soul(root.soul, diagnostics);
  const compiled = decodeCompiled(root.compiled, diagnostics);
  if (hasErrors(diagnostics) || !compiled) return { ok: false, diagnostics };
  if (compiled.fingerprint !== soulFingerprint({
    soul: legacySoul,
    compilerVersion: compiled.compilerVersion,
    systemPrompt: compiled.systemPrompt,
  })) {
    diagnostics.push(fingerprintMismatch());
    return { ok: false, diagnostics };
  }
  const soul = projectV1Soul(legacySoul);
  return {
    ok: true,
    snapshot: { schemaVersion: 1, soul, compiled },
    renderedMarkdown: renderSoulMarkdown(soul),
    diagnostics,
  };
}

function decodeV1Soul(value: unknown, diagnostics: SoulDiagnostic[]): LegacyV1Soul {
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
      age: adultAge(identity.age, diagnostics, ["soul", "identity", "age"]),
      gender: gender(identity.gender, diagnostics, ["soul", "identity", "gender"]),
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

function projectV1Soul(legacy: LegacyV1Soul): CharacterSoul {
  return {
    name: legacy.identity.name,
    age: legacy.identity.age,
    gender: legacy.identity.gender,
    relationshipArchetype: legacy.identity.relationshipArchetype,
    characterPromise: legacy.identity.characterPromise,
    detailsMarkdown: renderV1DetailsMarkdown(legacy),
  };
}

function renderV1DetailsMarkdown(soul: LegacyV1Soul): string {
  const sections: string[] = [];
  appendDetailSection(sections, "Personality", [
    field("Personality", soul.innerLife.personality),
    list("Values", soul.innerLife.values),
    list("Wants", soul.innerLife.wants),
    list("Fears", soul.innerLife.fears),
    list("Contradictions", soul.innerLife.contradictions),
    field("Backstory", soul.innerLife.backstory),
  ]);
  appendDetailSection(sections, "Voice", [
    field("Tone", soul.voice.tone),
    field("Cadence", soul.voice.cadence),
    list("Vocabulary", soul.voice.vocabulary),
    list("Habits", soul.voice.habits),
    list("Avoid", soul.voice.avoid),
  ]);
  appendDetailSection(
    sections,
    "Interaction",
    Object.entries(soul.interaction).map(([key, value]) => field(title(key), value)),
  );
  appendBulletSection(sections, "Canon facts", soul.canon.facts);
  appendBulletSection(sections, "Canon unknowns", soul.canon.unknowns);
  appendDetailSection(
    sections,
    "Dialogue examples",
    soul.dialogue.positive.flatMap((example) => [
      example.context ? `Context: ${example.context}` : "",
      example.user ? `User: ${example.user}` : "",
      `Assistant: ${example.assistant}`,
      list("Demonstrates", example.demonstrates),
    ]),
  );
  appendDetailSection(
    sections,
    "Dialogue counterexamples",
    soul.dialogue.negative.map((example) => `${example.assistant}\nReason: ${example.reason}`),
  );
  return sections.join("\n\n");
}

function loadLegacySnapshot(root: Record<string, unknown>): CharacterSoulResult {
  const legacyPrompt = typeof root.systemPrompt === "string"
    ? root.systemPrompt.trim()
    : "";
  const promptFields = legacyPrompt ? legacyPromptAuthoringFields(legacyPrompt) : {};
  const name = optionalText(root.name);
  const age = root.age;
  const genderValue = optionalText(root.gender) || promptFields.gender;
  const relationshipArchetype =
    optionalText(root.relationshipArchetype) ||
    optionalText(root.relationship) ||
    promptFields.relationshipArchetype ||
    "";
  const characterPromise =
    optionalText(root.characterPromise) ||
    optionalText(root.description) ||
    promptFields.characterPromise ||
    "";
  const personality = optionalText(root.personality) || promptFields.personality || "";
  const tone = optionalText(root.tone) || promptFields.tone || "";
  const backstory = optionalText(root.backstory) || promptFields.backstory || "";
  const examples = Array.isArray(root.exampleDialogue)
    ? root.exampleDialogue.flatMap((item) => optionalText(item) ? [optionalText(item)] : [])
    : promptFields.exampleDialogue ? [promptFields.exampleDialogue] : [];
  if (
    !name ||
    typeof age !== "number" ||
    !Number.isInteger(age) ||
    age < 18 ||
    age > 120 ||
    !relationshipArchetype ||
    !characterPromise ||
    (!personality && !tone) ||
    !legacyPrompt ||
    !isGender(genderValue)
  ) {
    return failed(
      "legacy_snapshot_incomplete",
      [],
      "Legacy pinned Soul must contain identity, behavior, relationship, and explicit compiled prompt bytes.",
    );
  }
  const details: string[] = [];
  appendDetailSection(details, "Personality and voice", [personality, tone]);
  appendDetailSection(details, "Background", [backstory]);
  appendBulletSection(details, "Dialogue examples", examples);
  const soul: CharacterSoul = {
    name,
    age,
    gender: genderValue,
    relationshipArchetype,
    characterPromise,
    detailsMarkdown: details.join("\n\n"),
  };
  const compilerVersion = "legacy-0";
  const compiled = {
    compilerVersion,
    systemPrompt: legacyPrompt,
    fingerprint: soulFingerprint({ soul, compilerVersion, systemPrompt: legacyPrompt }),
    estimatedTokens: estimateTokens(legacyPrompt),
  };
  return {
    ok: true,
    snapshot: { schemaVersion: 0, soul, compiled },
    renderedMarkdown: renderSoulMarkdown(soul),
    diagnostics: [{
      code: "legacy_snapshot_loaded",
      path: ["schemaVersion"],
      severity: "warning",
      message: "Loaded an immutable schemaVersion 0 Soul through the historical read adapter.",
    }],
  };
}

function legacyPromptAuthoringFields(systemPrompt: string): Partial<{
  gender: CharacterSoulGender;
  relationshipArchetype: string;
  characterPromise: string;
  personality: string;
  tone: string;
  backstory: string;
  exampleDialogue: string;
}> {
  const fields: ReturnType<typeof legacyPromptAuthoringFields> = {};
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

function renderSoulMarkdown(soul: CharacterSoul): string {
  return [
    `# ${soul.name} — Character Soul`,
    "",
    `You are ${soul.name}. Speak and act consistently with this character.`,
    "",
    "## Basic information",
    `- Age: ${soul.age}`,
    `- Gender: ${soul.gender}`,
    `- Relationship: ${soul.relationshipArchetype}`,
    `- Character: ${soul.characterPromise}`,
    ...(soul.detailsMarkdown
      ? ["", "## Additional details", "", soul.detailsMarkdown]
      : []),
  ].join("\n").trim();
}

function decodeCompiled(
  value: unknown,
  diagnostics: SoulDiagnostic[],
): CompiledCharacterSoul | null {
  const compiled = record(value);
  if (!compiled) {
    diagnostics.push(errorDiagnostic(
      "compiled_artifact_missing",
      ["compiled"],
      "Stored Soul is missing its immutable compiled artifact.",
    ));
    return null;
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
  if (hasErrors(diagnostics)) return null;
  return { compilerVersion, systemPrompt, fingerprint, estimatedTokens };
}

function fingerprintMismatch(): SoulDiagnostic {
  return errorDiagnostic(
    "compiled_fingerprint_mismatch",
    ["compiled", "fingerprint"],
    "Stored Soul fingerprint does not match its canonical Soul and compiled prompt bytes.",
  );
}

function positiveDialogue(
  value: unknown,
  diagnostics: SoulDiagnostic[],
): LegacyV1Soul["dialogue"]["positive"] {
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
): LegacyV1Soul["dialogue"]["negative"] {
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

function stringArray(
  value: unknown,
  diagnostics: SoulDiagnostic[],
  path: string[],
): string[] {
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

function appendDetailSection(target: string[], heading: string, values: string[]): void {
  const present = values.filter(Boolean);
  if (present.length === 0) return;
  target.push(`## ${heading}`, "", present.join("\n"));
}

function appendBulletSection(target: string[], heading: string, values: string[]): void {
  if (values.length === 0) return;
  target.push(`## ${heading}`, "", values.map((value) => `- ${value}`).join("\n"));
}

function field(label: string, value: string): string {
  return value ? `- ${label}: ${value}` : "";
}

function list(label: string, values: string[]): string {
  return values.length > 0 ? `- ${label}: ${values.join("; ")}` : "";
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

function adultAge(
  value: unknown,
  diagnostics: SoulDiagnostic[],
  path: string[],
): number {
  if (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 18 &&
    value <= 120
  ) return value;
  diagnostics.push(errorDiagnostic("soul_age_invalid", path, "Soul age must be an integer from 18 to 120."));
  return 0;
}

function gender(
  value: unknown,
  diagnostics: SoulDiagnostic[],
  path: string[],
): CharacterSoulGender {
  if (isGender(value)) return value;
  diagnostics.push(errorDiagnostic("soul_gender_invalid", path, "Soul gender must be female, male, or trans."));
  return "female";
}

function isGender(value: unknown): value is CharacterSoulGender {
  return value === "female" || value === "male" || value === "trans";
}

function positiveInteger(
  value: unknown,
  diagnostics: SoulDiagnostic[],
  code: string,
  path: string[],
): number {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
  diagnostics.push(errorDiagnostic(code, path, `${path.join(".")} must be a positive integer.`));
  return 0;
}

function failed(
  code: string,
  path: string[],
  message: string,
): CharacterSoulResult<never> {
  return { ok: false, diagnostics: [errorDiagnostic(code, path, message)] };
}

function errorDiagnostic(code: string, path: string[], message: string): SoulDiagnostic {
  return { code, path, severity: "error", message };
}

function hasErrors(diagnostics: SoulDiagnostic[]): boolean {
  return diagnostics.some((item) => item.severity === "error");
}

function soulFingerprint(input: {
  soul: CharacterSoul | LegacyV1Soul;
  compilerVersion: string;
  systemPrompt: string;
}): string {
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

function markdownText(value: unknown): string {
  return typeof value === "string"
    ? value.replaceAll("\r\n", "\n").replaceAll("\r", "\n").trim()
    : "";
}

function title(value: string): string {
  return value.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (letter) => letter.toUpperCase());
}
