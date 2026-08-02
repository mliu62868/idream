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
