import { describe, expect, it } from "vitest";
import {
  emptyRelationshipState,
  reduceRelationship,
  type RelationshipEvidence,
} from "./relationship.js";

function evidence(
  assistant: string,
  kind: RelationshipEvidence["kind"],
  confidence = 1,
): RelationshipEvidence {
  return {
    sourceAssistantMessageId: assistant,
    sourceUserMessageId: `user-${assistant}`,
    kind,
    confidence,
    extractorVersion: "relationship-evidence-1",
  };
}

describe("relationship evidence reducer", () => {
  it("deduplicates retries by assistant message, kind, and extractor version", () => {
    const affection = evidence("a1", "affection");
    const state = reduceRelationship(emptyRelationshipState(), [
      affection,
      affection,
      { ...affection },
    ]);

    expect(state.signals).toEqual({ warmth: 3, familiarity: 0, turns: 1 });
    expect(state.version).toBe(1);
    expect(state.stage).toBe("new");
  });

  it("projects stages with hysteresis and never crosses multiple stages in one turn", () => {
    const firstTurn = reduceRelationship(emptyRelationshipState(), [
      evidence("a1", "affection"),
      evidence("a1", "trust"),
      evidence("a1", "self_disclosure"),
      evidence("a1", "shared_plan"),
    ]);
    expect(firstTurn.stage).toBe("familiar");
    expect(firstTurn.signals.warmth + firstTurn.signals.familiarity).toBe(9);

    const conflict = reduceRelationship(firstTurn, [evidence("a2", "conflict")]);
    expect(conflict.stage).toBe("familiar");

    const sustainedConflict = reduceRelationship(conflict, [
      evidence("a3", "conflict"),
      evidence("a4", "conflict"),
    ]);
    expect(sustainedConflict.stage).toBe("new");
  });

  it("is deterministically rebuildable after evidence linked to a deleted turn is removed", () => {
    const ledger = [
      evidence("a1", "trust"),
      evidence("a1", "self_disclosure"),
      evidence("a2", "affection"),
      evidence("a3", "shared_plan"),
    ];
    const original = reduceRelationship(emptyRelationshipState(), ledger);
    const rebuilt = reduceRelationship(
      emptyRelationshipState(),
      ledger.filter((item) => item.sourceAssistantMessageId !== "a2"),
    );

    expect(original.signals).toEqual({ warmth: 5, familiarity: 4, turns: 3 });
    expect(rebuilt.signals).toEqual({ warmth: 2, familiarity: 4, turns: 2 });
    expect(rebuilt.version).toBe(2);
  });

  it("uses qualitative evidence summaries rather than source prose", () => {
    const state = reduceRelationship(emptyRelationshipState(), [
      evidence("a1", "boundary_respected"),
      evidence("a2", "repair"),
    ]);

    expect(state.summary).toBe(
      "The bond reflects respected boundaries and successful repair.",
    );
    expect(state.summary).not.toContain("user-a1");
  });
});
