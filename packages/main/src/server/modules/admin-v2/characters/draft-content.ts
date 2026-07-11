import type {
  CharacterDraftPersona,
  CharacterDraftVisualDirection,
} from "@idream/shared/admin";
import { canonicalSha256 } from "@/server/modules/admin-v2/shared/canonical-json";

export function characterDraftSnapshots(content: {
  persona: CharacterDraftPersona;
  visualDirection: CharacterDraftVisualDirection;
}) {
  const personaSnapshot = {
    name: content.persona.name,
    age: content.persona.age,
    gender: content.persona.gender,
    relationshipArchetype: content.persona.relationshipArchetype,
    characterPromise: content.persona.characterPromise,
    description: content.persona.characterPromise,
    personality: content.persona.personality,
    tone: content.persona.tone,
    backstory: content.persona.backstory,
    exampleDialogue: content.persona.exampleDialogue,
  };
  const openingSnapshot = { firstMessage: content.persona.firstMessage };
  const appearanceSnapshot = {
    identityAnchor: content.visualDirection.identityAnchor,
    stableTraits: content.visualDirection.stableTraits,
    style: content.visualDirection.style,
    referenceDirection: content.visualDirection.referenceDirection,
  };
  return {
    personaSnapshot,
    openingSnapshot,
    appearanceSnapshot,
    contentHash: canonicalSha256({ personaSnapshot, openingSnapshot, appearanceSnapshot }),
  };
}
