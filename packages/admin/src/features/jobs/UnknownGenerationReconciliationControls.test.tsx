import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { GenerationJobDetailResponse } from "@idream/shared/admin";
import {
  UnknownGenerationReconciliationControls,
  unknownGenerationEvidenceRefs,
} from "./UnknownGenerationReconciliationControls";

const detail = {
  request: {
    id: "request-unknown-1",
    requestOutcome: "needs_reconciliation",
    version: 4,
  },
  attempts: [{
    id: "attempt-unknown-1",
    attemptNo: 2,
    status: "unknown",
  }],
  transportExecutions: [{
    attemptId: "attempt-unknown-1",
    providerRequestId: "provider-request-42",
    terminalRecordRef: "terminal/attempt-unknown-1.json",
  }],
  unknownReconciliations: [],
  unknownTerminalEvidence: null,
} as unknown as GenerationJobDetailResponse;

describe("Unknown Generation reconciliation controls", () => {
  it("surfaces both audited operator resolutions without implying the Attempt changes", () => {
    const html = renderToStaticMarkup(
      <UnknownGenerationReconciliationControls
        detail={detail}
        onReconciled={() => undefined}
      />,
    );

    expect(html).toContain("Unknown provider outcome requires an operator decision");
    expect(html).toContain("Attempt 2 stays unknown");
    expect(html).toContain("Remain unknown and review later");
    expect(html).toContain("Confirm failed and refund");
  });

  it("pins provider and terminal-record evidence into the command", () => {
    expect(unknownGenerationEvidenceRefs(detail)).toEqual([
      "provider-request:provider-request-42",
      "terminal-record:terminal/attempt-unknown-1.json",
    ]);
  });

  it("falls back to immutable Attempt evidence when no provider reference exists", () => {
    expect(unknownGenerationEvidenceRefs({
      ...detail,
      transportExecutions: [],
    })).toEqual(["attempt-event:attempt-unknown-1:unknown"]);
  });

  it("surfaces validated recovered success and due operator work", () => {
    const html = renderToStaticMarkup(
      <UnknownGenerationReconciliationControls
        detail={{
          ...detail,
          unknownTerminalEvidence: {
            attemptId: "attempt-unknown-1",
            outcome: "succeeded",
            transportStatus: "succeeded",
            terminalRecordRef: "terminal/attempt-unknown-1.json",
            terminalRecordChecksum: "a".repeat(64),
            artifactCount: 1,
            adoptable: true,
            adoptionBlockReason: null,
          },
          unknownReconciliations: [{
            id: "decision-1",
            attemptId: "attempt-unknown-1",
            resolution: "remain_unknown",
            actorId: "admin-1",
            reason: "Waiting for the durable provider result.",
            providerEvidenceRefs: ["provider-request:provider-request-42"],
            nextReviewAt: "2026-08-02T12:00:00.000Z",
            reviewStatus: "due",
            refundAmount: 0,
            deliveredCount: 0,
            occurredAt: "2026-08-01T12:00:00.000Z",
          }],
        }}
        onReconciled={() => undefined}
      />,
    );

    expect(html).toContain("Scheduled provider review is due now.");
    expect(html).toContain("Recovered terminal evidence: succeeded, 1 artifact(s).");
    expect(html).toContain("Adopt recovered success");
    expect(html).not.toContain("Confirm failed and refund");
  });

  it("hides reconciliation controls after a terminal operator resolution", () => {
    const html = renderToStaticMarkup(
      <UnknownGenerationReconciliationControls
        detail={{
          ...detail,
          unknownReconciliations: [{
            id: "decision-terminal-1",
            attemptId: "attempt-unknown-1",
            resolution: "confirm_failed",
            actorId: "admin-1",
            reason: "Provider confirmed no output was produced.",
            providerEvidenceRefs: ["provider-request:provider-request-42"],
            nextReviewAt: null,
            reviewStatus: "not_applicable",
            refundAmount: 10,
            deliveredCount: 0,
            occurredAt: "2026-08-02T12:00:00.000Z",
          }],
        }}
        onReconciled={() => undefined}
      />,
    );

    expect(html).toBe("");
  });

  it("offers only continued review when verified late success cannot be adopted after refund", () => {
    const html = renderToStaticMarkup(
      <UnknownGenerationReconciliationControls
        detail={{
          ...detail,
          unknownTerminalEvidence: {
            attemptId: "attempt-unknown-1",
            outcome: "succeeded",
            transportStatus: "unknown",
            terminalRecordRef: "terminal/attempt-unknown-1.json",
            terminalRecordChecksum: "b".repeat(64),
            artifactCount: 1,
            adoptable: false,
            adoptionBlockReason: "request_already_refunded",
          },
        }}
        onReconciled={() => undefined}
      />,
    );

    expect(html).toContain("Recovered success is verified");
    expect(html).toContain("only an audited future review may be recorded");
    expect(html).toContain("Remain unknown and review later");
    expect(html).not.toContain("Adopt recovered success");
    expect(html).not.toContain("Confirm failed and refund");
  });
});
