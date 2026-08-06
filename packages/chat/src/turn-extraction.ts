import { extractCandidates, type MemoryCandidate } from "./extract.js";
import {
  relationshipEvidenceForTurn,
  type RelationshipEvidence,
} from "./relationship.js";
import { deriveSceneDelta, type SceneDelta } from "./scene.js";

export interface TurnExtractionResult {
  extractorVersion: "turn-extraction-1";
  memoryCandidates: MemoryCandidate[];
  relationshipEvidence: RelationshipEvidence[];
  sceneDelta: SceneDelta;
}

/**
 * SPEC: one turn produces one derivation object. Memory, relationship and Scene
 * consumers may commit at different authority boundaries, but must never run
 * independent extraction passes over subtly different text.
 */
export async function extractTurnDerivations(input: {
  userId: string;
  characterId: string;
  userMessageId: string;
  assistantMessageId: string;
  userText: string;
  assistantText: string;
  memoryEnabled: boolean;
}): Promise<TurnExtractionResult> {
  const memoryCandidates = input.memoryEnabled
    ? await extractCandidates({
        userText: input.userText,
        sourceMessageId: input.userMessageId,
        userId: input.userId,
        characterId: input.characterId,
      })
    : [];
  return {
    extractorVersion: "turn-extraction-1",
    memoryCandidates,
    relationshipEvidence: relationshipEvidenceForTurn({
      userMessageId: input.userMessageId,
      assistantMessageId: input.assistantMessageId,
      userText: input.userText,
      assistantText: input.assistantText,
    }),
    sceneDelta: deriveSceneDelta({
      userText: input.userText,
      assistantText: input.assistantText,
    }),
  };
}
