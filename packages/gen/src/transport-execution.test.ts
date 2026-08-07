import { afterEach, describe, expect, it, vi } from "vitest";
import { recordTransportExecution } from "./transport-execution";

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
  });

  it("bounds non-structured upstream responses", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("x".repeat(1_100), { status: 503 })));

    await expect(recordTransportExecution(event)).rejects.toSatisfy((error: unknown) =>
      error instanceof Error &&
      error.message.startsWith("main generation transport endpoint returned 503: ") &&
      error.message.length < 1_100 &&
      error.message.endsWith("..."),
    );
  });
});
