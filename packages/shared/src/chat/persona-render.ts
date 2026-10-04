export interface CharacterSoulMarkdownInput {
  name: string;
  age: number;
  gender: string;
  characterPromise: string;
  detailsMarkdown?: string | null;
}

/**
 * INVARIANT: SOUL.md, the authoring preview, and the exact Agent system prompt
 * are one artifact. This browser-safe renderer is their only text authority.
 */
export function renderCharacterSoulMarkdown(
  soul: CharacterSoulMarkdownInput,
): string {
  const name = compactText(soul.name);
  const detailsMarkdown = markdownText(soul.detailsMarkdown);
  return [
    `# ${name} — Character Soul`,
    "",
    `You are ${name}. Speak and act consistently with this character.`,
    "",
    "## Basic information",
    `- Age: ${soul.age}`,
    `- Gender: ${compactText(soul.gender)}`,
    `- Character: ${compactText(soul.characterPromise)}`,
    ...(detailsMarkdown
      ? ["", "## Additional details", "", detailsMarkdown]
      : []),
  ].join("\n").trim();
}

function compactText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function markdownText(value: unknown): string {
  return typeof value === "string"
    ? value.replaceAll("\r\n", "\n").replaceAll("\r", "\n").trim()
    : "";
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

function title(value: string): string {
  return value.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (letter) => letter.toUpperCase());
}
