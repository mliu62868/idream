import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { reviewDecisionSuccess } from "./ReviewQueueView";

const source = readFileSync(new URL("./ReviewQueueView.tsx", import.meta.url), "utf8");

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

  it("keeps review decisions visible and the narrow table keyboard-scrollable", () => {
    expect(source).toContain('aria-label={t("{caption} scrollable table"');
    expect(source).toContain('role="region"');
    expect(source).toContain('tabIndex={0}');
    expect(source).toContain('sticky right-0 z-10 border-b border-l');
    expect(source).toContain('sticky right-0 z-10 border-l');
    expect(source).toContain('["Name", "Gender", "Style", "Description", "Reports", "submittedAt"]');
  });
});
