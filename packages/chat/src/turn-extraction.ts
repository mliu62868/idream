import {
  relationshipEvidenceForTurn,
  type RelationshipEvidence,
} from "./relationship.js";
import { deriveSceneDelta, type SceneDelta } from "./scene.js";

export interface TurnExtractionResult {
  extractorVersion: "turn-extraction-1";
  relationshipEvidence: RelationshipEvidence[];
  sceneDelta: SceneDelta;
}

/**
 * SPEC: one turn produces Chat-owned relationship and Scene derivations.
 */
export async function extractTurnDerivations(input: {
  userMessageId: string;
  assistantMessageId: string;
  userText: string;
  assistantText: string;
}): Promise<TurnExtractionResult> {
  return {
    extractorVersion: "turn-extraction-1",
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
