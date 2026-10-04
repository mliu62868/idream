import type {
  CharacterDraftPersona,
  CharacterDraftVisualDirection,
} from "@idream/shared/admin";
import { compileCharacterSoul } from "@idream/shared";
import { characterContentHash } from "@/server/modules/admin-v2/shared/character-content-identity";

export function characterDraftSnapshots(content: {
  persona: CharacterDraftPersona;
  visualDirection: CharacterDraftVisualDirection;
}, previousAppearance: unknown = {}) {
  return characterSoulVersionSnapshots({
    persona: content.persona,
    appearanceSnapshot: previousAppearance,
    visualDirection: content.visualDirection,
  });
}

/**
 * SPEC: a Soul edit creates a new content version while Appearance remains an
 * independently versioned immutable snapshot.
 */
export function characterSoulVersionSnapshots(content: {
  persona: CharacterDraftPersona;
  appearanceSnapshot: unknown;
  visualDirection?: CharacterDraftVisualDirection;
}) {
  const { firstMessage, ...soul } = content.persona;
  const compiled = compileCharacterSoul(soul);
  if (!compiled.ok) {
    throw new Error(
      `Character Soul compilation failed: ${compiled.diagnostics.map((item) => `${item.path.join(".")}: ${item.message}`).join("; ")}`,
    );
  }
  const personaSnapshot = compiled.snapshot;
  const openingSnapshot = { firstMessage };
  // Both authoring entrances preserve source images and structured legacy
  // traits. Only the four editable visual direction keys may be replaced.
  const appearanceSnapshot = content.visualDirection
    ? { ...appearanceRecord(content.appearanceSnapshot), ...content.visualDirection }
    : content.appearanceSnapshot;
  return {
    personaSnapshot,
    openingSnapshot,
    appearanceSnapshot,
    contentHash: characterContentHash({
      personaSnapshot,
      openingSnapshot,
      appearanceSnapshot,
    }),
    renderedSoulMarkdown: compiled.renderedMarkdown,
    diagnostics: compiled.diagnostics,
  };
}

export function characterContentModerationText(content: {
  personaSnapshot: unknown;
  openingSnapshot: unknown;
  appearanceSnapshot: unknown;
}) {
  return JSON.stringify({
    persona: content.personaSnapshot,
    opening: content.openingSnapshot,
    appearance: content.appearanceSnapshot,
  });
}

function appearanceRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
