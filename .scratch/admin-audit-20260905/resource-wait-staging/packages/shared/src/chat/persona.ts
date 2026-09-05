import { createHash } from "node:crypto";
import { renderCharacterSoulMarkdown } from "./persona-render";

export const CHARACTER_SOUL_SCHEMA_VERSION = 3 as const;
export const CHARACTER_SOUL_COMPILER_VERSION = "character-soul-3" as const;

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
  schemaVersion: 3;
  soul: CharacterSoul;
  compiled: CompiledCharacterSoul;
}

/** Historical snapshots are verified first, then projected through the current
 * compiler. This preserves corruption detection without re-introducing removed
 * product fields into Chat prompts.
 */
export interface LoadedCharacterSoulSnapshot {
  schemaVersion: 0 | 1 | 2 | 3;
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

type LegacyV2Soul = CharacterSoul & {
  relationshipArchetype: string;
};

const PROMPT_WARNING_TOKENS = 6_000;
const CHARACTER_SOUL_FIELDS = new Set([
  "name",
  "age",
  "gender",
  "characterPromise",
  "detailsMarkdown",
]);

/**
 * SPEC: Character Soul authoring has four required facts and one optional
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
  let soulRoot = root;
  if (hasOwn(root, "soul")) {
    for (const key of Object.keys(root).filter((key) => key !== "soul")) {
      diagnostics.push(unknownSoulField([key]));
    }
    const wrapped = record(root.soul);
    if (!wrapped) {
      diagnostics.push(errorDiagnostic(
        "soul_draft_invalid",
        ["soul"],
        "Character Soul must be an object.",
      ));
      return { ok: false, diagnostics };
    }
    soulRoot = wrapped;
  }
  for (const key of Object.keys(soulRoot).filter((key) => !CHARACTER_SOUL_FIELDS.has(key))) {
    diagnostics.push(unknownSoulField(["soul", key]));
  }
  const soul = decodeSoul(soulRoot, diagnostics);
  if (hasErrors(diagnostics)) return { ok: false, diagnostics };

  const systemPrompt = renderCharacterSoulMarkdown(soul);
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
 * Historical write boundaries call this before v3 compilation. It folds every
 * flat Soul field shipped by the old clients into one Markdown value; the v3
 * compiler itself stays strict and never guesses whether an unknown key matters.
 */
export function legacySoulDetailsMarkdown(
  value: unknown,
): string {
  const row = record(value) ?? {};
  const sections: string[] = [];
  const explicitDetails = hasOwn(row, "detailsMarkdown")
    ? markdownText(row.detailsMarkdown)
    : "";
  if (explicitDetails) sections.push(explicitDetails);

  appendDetailSection(sections, "Personality", [optionalText(row.personality)]);
  appendBulletSection(sections, "Values", legacyStringList(row.values));
  appendBulletSection(sections, "Wants", legacyStringList(row.wants));
  appendBulletSection(sections, "Fears", legacyStringList(row.fears));
  appendBulletSection(sections, "Contradictions", legacyStringList(row.contradictions));
  appendDetailSection(sections, "Background", [optionalText(row.backstory)]);
  appendDetailSection(sections, "Voice", [
    field("Tone", optionalText(row.tone) || optionalText(row.speakingStyle)),
    field("Cadence", optionalText(row.cadence)),
    list("Vocabulary", legacyStringList(row.vocabulary)),
    list("Habits", legacyStringList(row.voiceHabits ?? row.habits)),
    list("Avoid", legacyStringList(row.voiceAvoid ?? row.avoid)),
  ]);

  const interaction = record(row.interaction) ?? {};
  appendDetailSection(
    sections,
    "Interaction",
    Object.entries(interaction).flatMap(([key, entry]) => {
      const content = legacyValueText(entry);
      return content ? [field(title(key), content)] : [];
    }),
  );
  const canon = record(row.canon) ?? {};
  appendBulletSection(sections, "Canon facts", legacyStringList(canon.facts));
  appendBulletSection(sections, "Canon unknowns", legacyStringList(canon.unknowns));
  appendBulletSection(sections, "Dialogue examples", legacyStringList(row.exampleDialogue));

  const negativeDialogue = Array.isArray(row.negativeDialogue)
    ? row.negativeDialogue.flatMap((entry) => {
        const example = record(entry);
        if (!example) return [];
        const assistant = optionalText(example.assistant);
        const reason = optionalText(example.reason);
        return assistant || reason
          ? [[assistant ? `Assistant: ${assistant}` : "", reason ? `Reason: ${reason}` : ""].filter(Boolean).join("\n")]
          : [];
      })
    : [];
  appendDetailSection(sections, "Dialogue counterexamples", negativeDialogue);
  return sections.join("\n\n");
}

/**
 * SPEC: current bytes are verified and used unchanged. Historical v0/v1/v2
 * bytes are verified, then compiled into the current relation-free runtime
 * projection so old sessions cannot bypass a removed product invariant.
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
  if (root.schemaVersion === 2) return loadV2Snapshot(root);
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
  const renderedMarkdown = renderCharacterSoulMarkdown(soul);
  if (
    compiled.compilerVersion !== CHARACTER_SOUL_COMPILER_VERSION ||
    compiled.systemPrompt !== renderedMarkdown
  ) {
    diagnostics.push(errorDiagnostic(
      "compiled_prompt_mismatch",
      ["compiled", "systemPrompt"],
      "Stored Soul prompt does not match the schema v3 compiler output.",
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
    snapshot: { schemaVersion: 3, soul, compiled },
    renderedMarkdown,
    diagnostics,
  };
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
    characterPromise: requiredText(
      root.characterPromise,
      diagnostics,
      "soul_character_promise_required",
      ["soul", "characterPromise"],
    ),
    detailsMarkdown: markdownText(root.detailsMarkdown),
  };
}

function loadV2Snapshot(root: Record<string, unknown>): CharacterSoulResult {
  const diagnostics: SoulDiagnostic[] = [];
  const legacySoul = decodeV2Soul(record(root.soul) ?? {}, diagnostics);
  const compiled = decodeCompiled(root.compiled, diagnostics);
  if (hasErrors(diagnostics) || !compiled) return { ok: false, diagnostics };
  const renderedMarkdown = renderHistoricalV2SoulMarkdown(legacySoul);
  if (
    compiled.compilerVersion !== "character-soul-2" ||
    compiled.systemPrompt !== renderedMarkdown
  ) {
    diagnostics.push(errorDiagnostic(
      "compiled_prompt_mismatch",
      ["compiled", "systemPrompt"],
      "Stored Soul prompt does not match the historical schema v2 compiler output.",
    ));
    return { ok: false, diagnostics };
  }
  if (compiled.fingerprint !== soulFingerprint({
    soul: legacySoul,
    compilerVersion: compiled.compilerVersion,
    systemPrompt: compiled.systemPrompt,
  })) {
    diagnostics.push(fingerprintMismatch());
    return { ok: false, diagnostics };
  }
  if (compiled.estimatedTokens !== estimateTokens(compiled.systemPrompt)) {
    diagnostics.push(errorDiagnostic(
      "compiled_token_estimate_mismatch",
      ["compiled", "estimatedTokens"],
      "Stored Soul token estimate does not match its compiled prompt bytes.",
    ));
    return { ok: false, diagnostics };
  }
  return compileHistoricalProjection(
    withoutHistoricalRelationship(legacySoul),
    [{
      code: "historical_relationship_removed",
      path: ["soul", "relationshipArchetype"],
      severity: "warning",
      message: "Verified schemaVersion 2 bytes and removed its historical relationship field from the current runtime projection.",
    }],
  );
}

function decodeV2Soul(
  root: Record<string, unknown>,
  diagnostics: SoulDiagnostic[],
): LegacyV2Soul {
  return {
    ...decodeSoul(root, diagnostics),
    relationshipArchetype: requiredText(
      root.relationshipArchetype,
      diagnostics,
      "soul_relationship_required",
      ["soul", "relationshipArchetype"],
    ),
  };
}

function withoutHistoricalRelationship(soul: LegacyV2Soul): CharacterSoul {
  const { relationshipArchetype: _historicalRelationship, ...current } = soul;
  return current;
}

function renderHistoricalV2SoulMarkdown(soul: LegacyV2Soul): string {
  const detailsMarkdown = soul.detailsMarkdown.trim();
  return [
    `# ${soul.name.replace(/\s+/g, " ").trim()} — Character Soul`,
    "",
    `You are ${soul.name.replace(/\s+/g, " ").trim()}. Speak and act consistently with this character.`,
    "",
    "## Basic information",
    `- Age: ${soul.age}`,
    `- Gender: ${soul.gender}`,
    `- Relationship: ${soul.relationshipArchetype.replace(/\s+/g, " ").trim()}`,
    `- Character: ${soul.characterPromise.replace(/\s+/g, " ").trim()}`,
    ...(detailsMarkdown ? ["", "## Additional details", "", detailsMarkdown] : []),
  ].join("\n").trim();
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
  return compileHistoricalProjection(soul, [...diagnostics, {
      code: "historical_relationship_removed",
      path: ["soul", "identity", "relationshipArchetype"],
      severity: "warning",
      message: "Verified schemaVersion 1 bytes and removed its historical relationship field from the current runtime projection.",
    }]);
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
      "Legacy pinned Soul must contain its historical identity, behavior, and explicit compiled prompt bytes.",
    );
  }
  const details: string[] = [];
  appendDetailSection(details, "Personality and voice", [personality, tone]);
  appendDetailSection(details, "Background", [backstory]);
  appendBulletSection(details, "Dialogue examples", examples);
  const legacySoul: LegacyV2Soul = {
    name,
    age,
    gender: genderValue,
    relationshipArchetype,
    characterPromise,
    detailsMarkdown: details.join("\n\n"),
  };
  const soul = withoutHistoricalRelationship(legacySoul);
  return compileHistoricalProjection(soul, [{
      code: "legacy_snapshot_loaded",
      path: ["schemaVersion"],
      severity: "warning",
      message: "Verified a schemaVersion 0 Soul and projected it through the current compiler.",
    }, {
      code: "historical_relationship_removed",
      path: ["relationshipArchetype"],
      severity: "warning",
      message: "Removed the historical relationship field from the current runtime projection.",
    }]);
}

function compileHistoricalProjection(
  soul: CharacterSoul,
  historicalDiagnostics: SoulDiagnostic[],
): CharacterSoulResult {
  const projected = compileCharacterSoul(soul);
  if (!projected.ok) return projected;
  return {
    ...projected,
    diagnostics: [...historicalDiagnostics, ...projected.diagnostics],
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

function unknownSoulField(path: string[]): SoulDiagnostic {
  return errorDiagnostic(
    "soul_field_unknown",
    path,
    `${path.join(".")} is not part of the Character Soul v3 contract; migrate it into soul.detailsMarkdown.`,
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

function legacyStringList(value: unknown): string[] {
  if (typeof value === "string") {
    const normalized = value.trim();
    return normalized ? [normalized] : [];
  }
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const normalized = optionalText(item);
    return normalized ? [normalized] : [];
  });
}

function legacyValueText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) return legacyStringList(value).join("; ");
  return "";
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

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
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
