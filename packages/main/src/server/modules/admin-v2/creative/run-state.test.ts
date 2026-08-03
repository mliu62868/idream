import { describe, expect, it } from "vitest";
import {
  approvedIdentityConsistencyForMode,
  creativeIdentityReviewMode,
  deriveCreativeItemExecutionState,
  deriveCreativeRunContinuation,
} from "./run-state";
import { identityExperimentCandidateSeed } from "@/server/modules/admin-v2/creative/run-create";

describe("Creative Run item execution projection", () => {
  it("shows provider work as generating while the durable item is still queued", () => {
    expect(deriveCreativeItemExecutionState({
      itemStatus: "queued",
      jobStatus: "queued",
      attemptStatus: "running",
      transportStatus: "running",
      hasAsset: false,
    })).toBe("generating");
  });

  it("distinguishes provider completion from asset projection", () => {
    expect(deriveCreativeItemExecutionState({
      itemStatus: "queued",
      jobStatus: "queued",
      attemptStatus: "succeeded",
      transportStatus: "succeeded",
      hasAsset: false,
    })).toBe("finalizing");
  });

  it("uses the projected asset as the ready-to-review truth", () => {
    expect(deriveCreativeItemExecutionState({
      itemStatus: "generated",
      jobStatus: "completed",
      attemptStatus: "succeeded",
      transportStatus: "succeeded",
      hasAsset: true,
    })).toBe("ready");
  });
});

describe("Creative Run continuation after placement verification", () => {
  it("moves a single approved campaign candidate directly into placement", () => {
    expect(deriveCreativeRunContinuation(["approved"])).toEqual({
      lifecycleState: "active",
      workflowStage: "placement",
      verificationState: "pending",
      status: "reviewing",
    });
  });

  it("closes a non-runtime Run at review after every candidate has a terminal decision", () => {
    expect(deriveCreativeRunContinuation(
      ["approved", "rejected", "failed"],
      { requiresVerifiedPlacement: false },
    )).toEqual({
      lifecycleState: "closed",
      workflowStage: "review",
      verificationState: "pending",
      status: "completed",
    });
  });

  it("keeps the Run active while another candidate still needs review", () => {
    expect(deriveCreativeRunContinuation(["published", "generated"])).toEqual({
      lifecycleState: "active",
      workflowStage: "review",
      verificationState: "pending",
      status: "reviewing",
    });
  });

  it("closes only after every candidate has an explicit terminal disposition", () => {
    expect(deriveCreativeRunContinuation(["published", "rejected", "failed"])).toEqual({
      lifecycleState: "closed",
      workflowStage: "verification",
      verificationState: "passed",
      status: "completed",
    });
  });

  it("does not claim runtime verification when a campaign ends without a published candidate", () => {
    expect(deriveCreativeRunContinuation(["rejected", "failed"])).toEqual({
      lifecycleState: "closed",
      workflowStage: "review",
      verificationState: "pending",
      status: "completed",
    });
  });
});

describe("Creative Run identity review semantics", () => {
  it("derives first-portrait identity definition from immutable job lineage", () => {
    const mode = creativeIdentityReviewMode({
      purpose: "character_cover",
      sourceMeta: { bootstrapIdentity: true },
    });
    expect(mode).toBe("defines_identity");
    expect(approvedIdentityConsistencyForMode(mode)).toBe("unscored");
  });

  it("requires normal Character assets to preserve the established identity", () => {
    const mode = creativeIdentityReviewMode({
      purpose: "character_chat",
      sourceMeta: { bootstrapIdentity: false },
    });
    expect(mode).toBe("preserves_identity");
    expect(approvedIdentityConsistencyForMode(mode)).toBe("passed");
  });

  it("reviews Character video as an identity-preserving asset", () => {
    const mode = creativeIdentityReviewMode({
      purpose: "character_video",
      sourceMeta: { bootstrapIdentity: false },
    });
    expect(mode).toBe("preserves_identity");
    expect(approvedIdentityConsistencyForMode(mode)).toBe("passed");
  });

  it("treats every route-evaluation sample as an identity-preservation judgment", () => {
    const mode = creativeIdentityReviewMode({
      purpose: "model_eval",
      sourceMeta: {
        routeQualificationEvaluationCandidate: true,
      },
    });
    expect(mode).toBe("preserves_identity");
    expect(approvedIdentityConsistencyForMode(mode)).toBe("passed");
  });

  it("keeps a visual calibration result as an identity-defining proposal", () => {
    const mode = creativeIdentityReviewMode({
      purpose: "identity_calibration",
      sourceMeta: {
        identityExperiment: {
          mode: "text_to_image",
          seedStrategy: "locked",
        },
      },
    });
    expect(mode).toBe("defines_identity");
    expect(approvedIdentityConsistencyForMode(mode)).toBe("unscored");
  });
});

describe("Visual identity experiment seeds", () => {
  it("keeps locked A/B variants stable across Runs while random Runs remain unique", () => {
    const lockedA = identityExperimentCandidateSeed({
      strategy: "locked",
      baseSeed: "184732",
      sourceSeed: null,
      batchId: "run-a",
      variantIndex: 2,
    });
    const lockedB = identityExperimentCandidateSeed({
      strategy: "locked",
      baseSeed: "184732",
      sourceSeed: null,
      batchId: "run-b",
      variantIndex: 2,
    });
    const randomA = identityExperimentCandidateSeed({
      strategy: "random",
      baseSeed: "184732",
      sourceSeed: null,
      batchId: "run-a",
      variantIndex: 2,
    });
    const randomB = identityExperimentCandidateSeed({
      strategy: "random",
      baseSeed: "184732",
      sourceSeed: null,
      batchId: "run-b",
      variantIndex: 2,
    });
    expect(lockedA).toBe(lockedB);
    expect(randomA).not.toBe(randomB);
  });

  it("derives unique variants when a source seed is reused", () => {
    const seeds = Array.from({ length: 4 }, (_, variantIndex) =>
      identityExperimentCandidateSeed({
        strategy: "reuse_source",
        baseSeed: null,
        sourceSeed: "source-seed",
        batchId: "run-a",
        variantIndex,
      })
    );
    expect(new Set(seeds).size).toBe(4);
    expect(seeds[0]).toContain("source-seed:continued");
  });
});
