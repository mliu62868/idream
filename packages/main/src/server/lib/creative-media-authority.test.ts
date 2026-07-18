import { describe, expect, it } from "vitest";
import {
  evaluateCreativeMediaAuthority,
  parseCreativeMediaAuthorityEvidence,
} from "./creative-media-authority";

describe("creative media provider authority", () => {
  it("keeps structurally valid all-null evidence distinct from complete authority", () => {
    const parsed = parseCreativeMediaAuthorityEvidence({
      customerMediaAuthority: {
        sourceJobId: null,
        jobProvider: null,
        latestAttemptProvider: null,
      },
    });

    expect(parsed).toMatchObject({ kind: "present" });
    expect(evaluateCreativeMediaAuthority({
      metadata: { synthetic: false },
      current: {
        sourceJobId: null,
        jobProvider: null,
        latestAttemptProvider: null,
      },
      pinned: parsed.kind === "present" ? parsed.snapshot : undefined,
      requireCompleteProviderAuthority: true,
    })).toMatchObject({
      publishable: false,
      reasons: expect.arrayContaining([
        "pinned_provider_missing",
        "job_provider_missing",
        "latest_successful_attempt_provider_missing",
        "source_job_missing",
      ]),
    });
  });

  it("preserves legacy compatibility when complete provider authority is not required", () => {
    expect(evaluateCreativeMediaAuthority({
      metadata: { synthetic: false },
      current: {
        sourceJobId: null,
        jobProvider: null,
        latestAttemptProvider: null,
      },
    })).toMatchObject({
      publishable: true,
      reasons: [],
    });
  });
});
