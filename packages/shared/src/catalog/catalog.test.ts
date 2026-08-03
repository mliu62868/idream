import { describe, expect, it } from "vitest";
import { generationJobStatusSchema } from "../admin/contracts/jobs";
import {
  APPEAL_TARGET_TYPES,
  CHARACTER_STYLES,
  CHARACTER_VISIBILITY,
  GENDERS,
  GENERATION_JOB_STATUSES,
  MEDIA_ASSET_VISIBILITY,
  PRODUCT_FEEDBACK_STATUSES,
  SUPPORT_REQUEST_CATEGORIES,
  TERMINAL_GENERATION_JOB_STATUSES,
  isCatalogMember,
  isTerminalGenerationJobStatus,
} from "./index";

describe("catalog", () => {
  // Regression: the web filters and the create form each carried a hand-copied
  // style list that omitted `other`, so those characters were unreachable.
  it("keeps every character style the server accepts", () => {
    expect([...CHARACTER_STYLES]).toEqual(["realistic", "anime", "hybrid", "other"]);
    expect([...GENDERS]).toEqual(["female", "male", "trans"]);
  });

  it("does not conflate character visibility with media visibility", () => {
    expect(CHARACTER_VISIBILITY).toContain("public");
    expect(CHARACTER_VISIBILITY).not.toContain("public_pack");
    expect(MEDIA_ASSET_VISIBILITY).toContain("public_pack");
    expect(MEDIA_ASSET_VISIBILITY).not.toContain("public");
  });

  // Regression + drift guard. `cancelled` was writable by the admin cancel
  // command but absent from this catalog, so the generator polled a cancelled
  // job forever. Set EQUALITY (not "contains each terminal one") is the point:
  // the previous assertion iterated the catalog's own members, so it could only
  // ever confirm the catalog agreed with itself — a status the server gained
  // and the catalog never learned about was invisible to it.
  it("carries exactly the generation statuses the server can write", () => {
    expect(new Set(GENERATION_JOB_STATUSES)).toEqual(
      new Set(generationJobStatusSchema.options),
    );
  });

  it("treats only finished generation states as terminal", () => {
    for (const status of TERMINAL_GENERATION_JOB_STATUSES) {
      expect(GENERATION_JOB_STATUSES).toContain(status);
      expect(isTerminalGenerationJobStatus(status)).toBe(true);
    }
    // The complement, asserted as a set: any status added to the catalog is
    // forced into exactly one of these two lists rather than falling through as
    // "not terminal" by default.
    expect(
      new Set(
        GENERATION_JOB_STATUSES.filter((status) => !isTerminalGenerationJobStatus(status)),
      ),
    ).toEqual(new Set(["queued", "moderating_input", "running", "moderating_output"]));
    expect(isTerminalGenerationJobStatus("nonsense")).toBe(false);
  });

  it("keeps under_review in the feedback status set", () => {
    expect(PRODUCT_FEEDBACK_STATUSES).toContain("under_review");
  });

  it("carries every help-desk value the service schemas accept", () => {
    expect([...SUPPORT_REQUEST_CATEGORIES]).toEqual([
      "account",
      "billing",
      "generation",
      "chat",
      "bug",
      "feature",
      "other",
    ]);
    expect(APPEAL_TARGET_TYPES).toHaveLength(8);
    expect(APPEAL_TARGET_TYPES).toContain("copyright_likeness");
  });

  it("narrows unknown input with isCatalogMember", () => {
    expect(isCatalogMember(CHARACTER_STYLES, "other")).toBe(true);
    expect(isCatalogMember(CHARACTER_STYLES, "otherish")).toBe(false);
    expect(isCatalogMember(CHARACTER_STYLES, 3)).toBe(false);
    expect(isCatalogMember(CHARACTER_STYLES, null)).toBe(false);
  });
});
