import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  authoredCampaignPlacementCopy,
  canTerminallyRejectUnusedApproval,
  committedProjectionWarning,
  nonCampaignReviewSummary,
} from "./CreativeRunWorkspace";

function expectSourceOrder(source: string, before: string, after: string) {
  const beforeIndex = source.indexOf(before);
  const afterIndex = source.indexOf(after);
  expect(beforeIndex, `missing source marker: ${before}`).toBeGreaterThan(-1);
  expect(afterIndex, `missing source marker: ${after}`).toBeGreaterThan(-1);
  expect(beforeIndex).toBeLessThan(afterIndex);
}

describe("Creative Run review handoff", () => {
  it("only describes a non-runtime Run as complete after its lifecycle is closed", () => {
    expect(nonCampaignReviewSummary({
      lifecycleState: "active",
      itemReviewed: false,
    })).toMatchObject({ title: "Review required", complete: false });
    expect(nonCampaignReviewSummary({
      lifecycleState: "active",
      itemReviewed: true,
    })).toMatchObject({ title: "Candidate reviewed", complete: false });
    expect(nonCampaignReviewSummary({
      lifecycleState: "closed",
      itemReviewed: true,
    })).toMatchObject({ title: "Review complete", complete: true });
  });

  it("shows the frozen recipe alongside the other review evidence", () => {
    const source = readFileSync(new URL("./CreativeRunWorkspace.tsx", import.meta.url), "utf8");

    expect(source).toContain('t("Recipe")');
    expect(source).toContain("run.reviewContext.recipe.label");
    expect(source).toContain("run.reviewContext.recipe.version");
  });

  it("describes committed mutations separately from projection refresh failures", () => {
    expect(committedProjectionWarning(
      "Placement activation",
      new Error("gateway unavailable"),
    )).toBe(
      "Placement activation was committed, but the latest projection could not be refreshed: gateway unavailable. Retry the same command safely or refresh the workspace.",
    );
  });

  it("rotates review, staging, verification, and withdrawal keys only after projection refresh", () => {
    const source = readFileSync(new URL("./CreativeRunWorkspace.tsx", import.meta.url), "utf8");
    const review = source.slice(
      source.indexOf("function ReviewForm"),
      source.indexOf("function PlacementForm"),
    );
    const placement = source.slice(
      source.indexOf("function PlacementForm"),
      source.indexOf("function IncidentAttachment"),
    );
    const stage = placement.slice(
      placement.indexOf("const place = async"),
      placement.indexOf("const verify = async"),
    );
    const verify = placement.slice(
      placement.indexOf("const verify = async"),
      placement.indexOf("const withdraw = async"),
    );
    const withdraw = placement.slice(
      placement.indexOf("const withdraw = async"),
      placement.indexOf("const canWithdrawStagedPlacement"),
    );

    expectSourceOrder(
      review,
      "await reload()",
      "delete idempotencyKeys.current[requestSignature]",
    );
    expectSourceOrder(
      stage,
      "await reload()",
      "delete idempotencyKeys.current[requestSignature]",
    );
    expectSourceOrder(
      verify,
      "await reload()",
      "delete idempotencyKeys.current[requestSignature]",
    );
    expectSourceOrder(
      withdraw,
      "await reload()",
      "delete idempotencyKeys.current[requestSignature]",
    );
    expect(review).toContain('committedProjectionWarning("Review decision"');
    expect(stage).toContain('committedProjectionWarning("Placement staging"');
    expect(verify).toContain('committedProjectionWarning("Placement activation"');
    expect(withdraw).toContain('committedProjectionWarning("Placement withdrawal"');
  });

  it("offers terminal rejection for unused Character candidates and active campaign approvals", () => {
    expect(canTerminallyRejectUnusedApproval({
      purpose: "campaign",
      lifecycleState: "active",
      decision: "approved",
      hasPlacement: false,
    })).toBe(true);
    expect(canTerminallyRejectUnusedApproval({
      purpose: "character_hero",
      lifecycleState: "closed",
      decision: "approved",
      hasPlacement: false,
    })).toBe(true);
    for (const input of [
      { purpose: "feed", lifecycleState: "active", decision: "approved", hasPlacement: false },
      { purpose: "campaign", lifecycleState: "closed", decision: "approved", hasPlacement: false },
      { purpose: "character_chat", lifecycleState: "retired", decision: "approved", hasPlacement: false },
      { purpose: "campaign", lifecycleState: "active", decision: "rejected", hasPlacement: false },
      { purpose: "campaign", lifecycleState: "active", decision: "approved", hasPlacement: true },
      { purpose: "character_cover", lifecycleState: "closed", decision: "approved", hasPlacement: true },
    ]) {
      expect(canTerminallyRejectUnusedApproval(input)).toBe(false);
    }
  });

  it("links terminal approval and staged-placement withdrawals to current authority", () => {
    const source = readFileSync(new URL("./CreativeRunWorkspace.tsx", import.meta.url), "utf8");
    const review = source.slice(
      source.indexOf("function ReviewForm"),
      source.indexOf("function PlacementForm"),
    );
    const placement = source.slice(
      source.indexOf("function PlacementForm"),
      source.indexOf("function IncidentAttachment"),
    );

    expect(review).toContain("supersedesDecisionId: item.review.id");
    expect(review).toContain("immutableReview.quality");
    expect(review).toContain("Withdraw approval");
    expect(review).toContain("Record superseding rejection");
    expect(placement).toContain("/withdrawal");
    expect(placement).toContain("Withdraw staged placement");
  });

  it("collects staging and staged-withdrawal reasons independently", () => {
    const source = readFileSync(new URL("./CreativeRunWorkspace.tsx", import.meta.url), "utf8");
    const placement = source.slice(
      source.indexOf("function PlacementForm"),
      source.indexOf("function IncidentAttachment"),
    );
    const stage = placement.slice(
      placement.indexOf("const place = async"),
      placement.indexOf("const verify = async"),
    );
    const withdraw = placement.slice(
      placement.indexOf("const withdraw = async"),
      placement.indexOf("const canWithdrawStagedPlacement"),
    );

    expect(placement).toContain('const [stageReason, setStageReason] = useState("")');
    expect(placement).toContain('const [withdrawalReason, setWithdrawalReason] = useState("")');
    expect(placement).toContain('t("Staging reason")');
    expect(placement).toContain('t("Withdrawal reason")');
    expect(placement).toContain('t("Explain why the staged candidate must be withdrawn")');
    expect(stage).toContain("reason: stageReason.trim()");
    expect(stage).toContain('setStageReason("")');
    expect(withdraw).toContain("reason: withdrawalReason.trim()");
    expect(withdraw).toContain('setWithdrawalReason("")');
  });

  it("requires authored campaign copy and submits its normalized authority fields", () => {
    expect(authoredCampaignPlacementCopy({
      eyebrow: "  Featured  ",
      title: "  Summer dreamers  ",
      ctaLabel: "  Open collection  ",
      href: "  /community?collection=summer  ",
    })).toEqual({
      eyebrow: "Featured",
      title: "Summer dreamers",
      ctaLabel: "Open collection",
      href: "/community?collection=summer",
    });
    const source = readFileSync(new URL("./CreativeRunWorkspace.tsx", import.meta.url), "utf8");
    const placement = source.slice(
      source.indexOf("function PlacementForm"),
      source.indexOf("function IncidentAttachment"),
    );
    const stage = placement.slice(
      placement.indexOf("const place = async"),
      placement.indexOf("const verify = async"),
    );

    expect(placement).toContain('t("Campaign eyebrow")');
    expect(placement).toContain('t("Campaign title")');
    expect(placement).toContain('t("Campaign CTA label")');
    expect(placement).toContain('t("Campaign CTA href")');
    expect(stage).toContain("authoredCampaignPlacementCopy");
    expect(placement).toContain("!eyebrow.trim()");
    expect(placement).toContain("!campaignTitle.trim()");
    expect(placement).toContain("const hasPartialCampaignCta");
    expect(placement).toContain("hasPartialCampaignCta");
    expect(placement).toContain("Add both a CTA label and destination, or leave both blank.");
  });
});
