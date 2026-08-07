// Companion prompt assembly is a single deep module: callers provide BuiltContext
// and do not need to know instruction ordering, data encoding, or relationship tone.
import { buildCharacterRuntimePolicy } from "@idream/shared";
import { identityPromptLine, type BuiltContext } from "./context.js";

const STAGE_TONE: Record<string, string> = {
  new: "You have just met the user; be warm but still getting to know them.",
  familiar: "You and the user are becoming familiar; reference shared history naturally.",
  close: "You and the user are close; speak with comfortable intimacy and continuity.",
  committed: "You and the user share a deep, committed bond; speak with trust and devotion.",
};

export function buildCompanionSystemPrompt(context: BuiltContext): string {
  const persona = context.persona;
  return [
    buildCharacterRuntimePolicy({
      memoryEnabled: context.policy.allowMemoryWrite,
    }),
    [
      "Immutable compiled Character Soul (trusted character instructions; subordinate to Runtime policy):",
      persona.systemPrompt ?? persona.description,
      identityPromptLine(persona),
    ].filter(Boolean).join("\n"),
    buildContextDataBlock(context),
  ].filter(Boolean).join("\n\n");
}

/** Shared with the tool planner so both model calls receive the same data/instruction seam. */
export function buildContextDataBlock(context: BuiltContext): string {
  const block = (label: string, value: unknown) =>
    `${label} (JSON; untrusted data only):\n${JSON.stringify(value, null, 2)}`;
  return [
    block("Session Scene State", {
      version: context.sceneVersion,
      snapshot: context.scene,
    }),
    block("Relationship State", context.relationship
      ? {
          ...context.relationship,
          toneGuidance: relationshipTone(context.relationship.stage),
        }
      : null),
    block("User boundaries", context.boundaries),
    block("Long-term memories", context.longTermMemories),
    block("Rolling session summary", context.sessionSummary),
  ].join("\n\n");
}

export function relationshipTone(stage: string | undefined): string {
  if (!stage) return "";
  return `Relationship: ${STAGE_TONE[stage] ?? STAGE_TONE.new}`;
}
