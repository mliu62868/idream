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

function markdownText(value: string | null | undefined): string {
  return typeof value === "string"
    ? value.replaceAll("\r\n", "\n").replaceAll("\r", "\n").trim()
    : "";
}
