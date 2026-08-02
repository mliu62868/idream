import { describe, expect, it } from "vitest";
import { aiFinalizePayloadSchema } from "./payloads";

const terminalEvidence = {
  terminalRecordRef: "gen/terminal-records/attempt-1/terminal.json",
  terminalRecordChecksum: "a".repeat(64),
};

const payloads = [
  {
    version: 1 as const,
    kind: "generation.completed" as const,
    requestId: "request-1",
    generationJobId: "job-1",
    attemptId: "attempt-1",
    attemptNo: 1,
    mode: "image" as const,
    assets: [{ key: "image.webp", contentType: "image/webp" }],
    usage: {},
  },
  {
    version: 1 as const,
    kind: "generation.failed" as const,
    requestId: "request-1",
    generationJobId: "job-1",
    attemptId: "attempt-1",
    attemptNo: 1,
    mode: "image" as const,
    error: { code: "backend_error", message: "failed", retryable: false },
  },
  {
    version: 1 as const,
    kind: "generation.blocked" as const,
    requestId: "request-1",
    generationJobId: "job-1",
    attemptId: "attempt-1",
    attemptNo: 1,
    mode: "image" as const,
    policyCode: "content_blocked",
    message: "blocked",
    layer: "provider" as const,
  },
];

describe("generation terminal finalize payload", () => {
  it.each(payloads)("validates terminal evidence on $kind", (payload) => {
    expect(aiFinalizePayloadSchema.parse({
      ...payload,
      ...terminalEvidence,
    })).toMatchObject(terminalEvidence);
    expect(aiFinalizePayloadSchema.safeParse({
      ...payload,
      ...terminalEvidence,
      terminalRecordRef: 123,
    }).success).toBe(false);
    expect(aiFinalizePayloadSchema.safeParse({
      ...payload,
      ...terminalEvidence,
      terminalRecordChecksum: 123,
    }).success).toBe(false);
    const { attemptId: _attemptId, ...withoutAttemptId } = payload;
    expect(aiFinalizePayloadSchema.safeParse({
      ...withoutAttemptId,
      ...terminalEvidence,
    }).success).toBe(false);
    const { attemptNo: _attemptNo, ...withoutAttemptNo } = payload;
    expect(aiFinalizePayloadSchema.safeParse({
      ...withoutAttemptNo,
      ...terminalEvidence,
    }).success).toBe(false);
    expect(aiFinalizePayloadSchema.safeParse(payload).success).toBe(false);
  });

  it("rejects completed asset MIME that conflicts with generation mode", () => {
    expect(aiFinalizePayloadSchema.safeParse({
      ...payloads[0],
      ...terminalEvidence,
      assets: [{ key: "wrong.mp4", contentType: "video/mp4" }],
    }).success).toBe(false);
  });
});

describe("ambiguous provider outcome stays out of the failure branch", () => {
  const base = {
    version: 1 as const,
    requestId: "request-1",
    generationJobId: "job-1",
    attemptId: "attempt-1",
    attemptNo: 1,
    mode: "image" as const,
    ...terminalEvidence,
  };

  it("keeps generation.unknown distinct from generation.failed", () => {
    expect(
      aiFinalizePayloadSchema.parse({
        ...base,
        kind: "generation.unknown",
        error: { code: "provider_timeout", message: "ambiguous", retryable: false },
      }).kind,
    ).toBe("generation.unknown");
  });

  it("never reads a plain failure as ambiguous", () => {
    expect(
      aiFinalizePayloadSchema.parse({
        ...base,
        kind: "generation.failed",
        error: { code: "backend_error", message: "failed", retryable: false },
      }).kind,
    ).toBe("generation.failed");
  });

  // INTENT: pre-cutover payloads can still be sitting in Redis/Outbox. Reading one
  // as a plain failure would refund and retry an Attempt the provider may have
  // already charged and produced.
  it("normalizes the legacy flattened shape into generation.unknown", () => {
    const parsed = aiFinalizePayloadSchema.parse({
      ...base,
      kind: "generation.failed",
      error: {
        code: "provider_timeout",
        message: "ambiguous",
        retryable: false,
        attemptOutcome: "unknown",
        retryability: "operator_retry",
      },
    });
    expect(parsed.kind).toBe("generation.unknown");
    expect(parsed).toMatchObject({
      error: { code: "provider_timeout", retryability: "operator_retry" },
    });
    expect(parsed.error).not.toHaveProperty("attemptOutcome");
  });

  it("leaves a legacy explicit failure on the failure branch", () => {
    expect(
      aiFinalizePayloadSchema.parse({
        ...base,
        kind: "generation.failed",
        error: {
          code: "backend_error",
          message: "failed",
          retryable: true,
          attemptOutcome: "failed",
        },
      }).kind,
    ).toBe("generation.failed");
  });
});
