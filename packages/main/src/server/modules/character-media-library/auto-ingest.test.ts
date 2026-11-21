import { describe, expect, it } from "vitest";
import { AUTO_INGEST_PACK_PURPOSES, buildAutoIngestDraftDescriptor } from "./auto-ingest";

describe("character media library pack auto-ingest", () => {
  it("scopes auto-ingest exclusively to official batch pre-generation pack purposes", () => {
    expect(AUTO_INGEST_PACK_PURPOSES).toEqual([
      "character_library_image_pack",
      "character_library_video_pack",
    ]);
  });

  it("keeps nudity fail-closed to unknown even when vision pre-labels description and facts", () => {
    const draft = buildAutoIngestDraftDescriptor({
      kind: "image",
      promptHint: "red dress rooftop",
      visionObservation: {
        description: "Standing on a rooftop in a red dress at dusk.",
        facts: ["Red Dress", "Rooftop", "red dress"],
        absentFacts: ["hat", "red dress"],
      },
    });
    expect(draft).toEqual({
      description: "Standing on a rooftop in a red dress at dusk.",
      facts: ["red dress", "rooftop"],
      absentFacts: ["hat"],
      nudity: "unknown",
      descriptionSource: "vision",
      attireLevel: null,
    });
  });

  it("falls back safely to operator-review draft when vision is unavailable", () => {
    const draft = buildAutoIngestDraftDescriptor({
      kind: "video",
      promptHint: "Smiling softly by the rainy window",
      visionObservation: null,
    });
    expect(draft.nudity).toBe("unknown");
    expect(draft.descriptionSource).toBe("operator");
    expect(draft.description).toContain("Smiling softly by the rainy window");
    expect(draft.facts).toEqual([]);
    expect(draft.absentFacts).toEqual([]);
  });
});
