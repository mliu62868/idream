import type {
  CharacterDraftPersona,
  CharacterDraftVisualDirection,
} from "@idream/shared/admin";
import { compileCharacterSoul } from "@idream/shared";
import { characterContentHash } from "@/server/modules/admin-v2/shared/character-content-identity";

export function characterDraftSnapshots(content: {
  persona: CharacterDraftPersona;
  visualDirection: CharacterDraftVisualDirection;
}) {
  return characterSoulVersionSnapshots({
    persona: content.persona,
    appearanceSnapshot: {
      identityAnchor: content.visualDirection.identityAnchor,
      stableTraits: content.visualDirection.stableTraits,
      style: content.visualDirection.style,
      referenceDirection: content.visualDirection.referenceDirection,
    },
  });
}

/**
 * SPEC: a Soul edit creates a new content version while Appearance remains an
 * independently versioned immutable snapshot.
 */
export function characterSoulVersionSnapshots(content: {
  persona: CharacterDraftPersona;
  appearanceSnapshot: unknown;
}) {
  const compiled = compileCharacterSoul(content.persona);
  if (!compiled.ok) {
    throw new Error(
      `Character Soul compilation failed: ${compiled.diagnostics.map((item) => `${item.path.join(".")}: ${item.message}`).join("; ")}`,
    );
  }
  const personaSnapshot = compiled.snapshot;
  const openingSnapshot = { firstMessage: content.persona.firstMessage };
  const appearanceSnapshot = content.appearanceSnapshot;
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
