import { UnrecoverableError } from "bullmq";
import { GENERATION_TRANSPORT_AUTHORITY_REVOKED_REASON } from "@idream/shared/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GenerationAuthorityRevokedError, GenerationTransportUnavailableError, recordTransportExecution } from "./transport-execution";

const event = {
  version: 1 as const,
  generationJobId: "job-1",
  attemptId: "attempt-1",
  attemptNo: 1,
  transportAttemptNo: 1,
  provider: "mock-image",
  model: "mock-image-v1",
  providerRequestId: null,
  idempotencyKey: "generation:attempt-1:provider",
  status: "running" as const,
  error: null,
  occurredAt: "2026-08-06T12:00:00.000Z",
};

describe("recordTransportExecution", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("preserves bounded Main conflict evidence in the worker failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ error: "conflict", message: "exact dispatch mismatch" }),
      { status: 409 },
    )));

    await expect(recordTransportExecution(event)).rejects.toThrow(
      'main generation transport endpoint returned 409: {"error":"conflict","message":"exact dispatch mismatch"}',
    );
    await expect(recordTransportExecution(event)).rejects.not.toBeInstanceOf(GenerationTransportUnavailableError);
  });

  it("stops for good only on Main's explicit revoked reason", async () => {
    const respond = (status: number, body: Record<string, unknown>) => vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status })));

    respond(409, { error: "conflict", message: "revoked", reason: GENERATION_TRANSPORT_AUTHORITY_REVOKED_REASON });
    const revoked = await recordTransportExecution(event).catch((error: unknown) => error);
    expect(revoked).toBeInstanceOf(GenerationAuthorityRevokedError);
    // BullMQ decides not to retry from this class.
    expect(revoked).toBeInstanceOf(UnrecoverableError);

    // A deferred scene becomes executable later; a bad token is a deployment fault.
    for (const [status, body] of [
      [409, { error: "conflict", message: "wait", reason: "video_sequence_deferred" }],
      [409, { error: "conflict", message: "exact dispatch mismatch" }],
      [401, { error: "unauthorized" }],
    ] as const) {
      respond(status, body);
      const retryable = await recordTransportExecution(event).catch((error: unknown) => error);
      expect(retryable).toBeInstanceOf(Error);
      expect(retryable).not.toBeInstanceOf(UnrecoverableError);
    }
  });

  it("bounds non-structured upstream responses", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("x".repeat(1_100), { status: 503 })));

    await expect(recordTransportExecution(event)).rejects.toSatisfy((error: unknown) =>
      error instanceof GenerationTransportUnavailableError &&
      error.message.startsWith("main generation transport endpoint returned 503: ") &&
      error.message.length < 1_100 &&
      error.message.endsWith("..."),
    );
  });

  it("distinguishes a heartbeat timeout from Main authority rejection", async () => {
    const timeout = new DOMException("Main heartbeat timed out", "TimeoutError");
    vi.stubGlobal("fetch", vi.fn(async () => { throw timeout; }));
    await expect(recordTransportExecution(event)).rejects.toMatchObject({
      name: "GenerationTransportUnavailableError", message: timeout.message, cause: timeout,
    });
  });
});
