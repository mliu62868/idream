import { describe, expect, it } from "vitest";
import { reviewDecisionSuccess } from "./ReviewQueueView";

describe("review decision success", () => {
  it("links approved customer submissions to publication preparation without claiming they are live", () => {
    expect(reviewDecisionSuccess({
      submission: { status: "approved" },
      publication: {
        state: "publication_prep",
        projectId: "project-1",
        revisionId: "revision-1",
        servingState: "inactive",
        deepLink: "/admin/characters/character-1?tab=assets",
        created: true,
      },
    })).toEqual({
      message: "Approved. Awaiting publication: complete assets, QA, and Release before the character goes live.",
      href: "/admin/characters/character-1?tab=assets",
    });
  });
});
