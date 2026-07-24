import type {
  CharacterDraftPersona,
  CharacterDraftVisualDirection,
} from "@idream/shared/admin";
import { buildCharacterSystemPrompt } from "@idream/shared";
import { canonicalSha256 } from "@/server/modules/admin-v2/shared/canonical-json";

export function characterDraftSnapshots(content: {
  persona: CharacterDraftPersona;
  visualDirection: CharacterDraftVisualDirection;
}) {
  const systemPrompt = buildCharacterSystemPrompt({
    name: content.persona.name,
    age: content.persona.age,
    description: content.persona.characterPromise,
    relationship: content.persona.relationshipArchetype,
    gender: content.persona.gender,
    advancedDetails: {
      personality: content.persona.personality,
      tone: content.persona.tone,
      backstory: content.persona.backstory,
      exampleDialogue: content.persona.exampleDialogue,
    },
  });
  const personaSnapshot = {
    name: content.persona.name,
    age: content.persona.age,
    gender: content.persona.gender,
    relationship: content.persona.relationshipArchetype,
    relationshipArchetype: content.persona.relationshipArchetype,
    characterPromise: content.persona.characterPromise,
    description: content.persona.characterPromise,
    personality: content.persona.personality,
    tone: content.persona.tone,
    backstory: content.persona.backstory,
    exampleDialogue: content.persona.exampleDialogue,
    systemPrompt,
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
