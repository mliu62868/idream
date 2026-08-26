import type { PrismaClient } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { reconcileUnknownGenerationRequest } = vi.hoisted(() => ({
  reconcileUnknownGenerationRequest: vi.fn(),
}));

vi.mock("./unknown-reconciliation", () => ({ reconcileUnknownGenerationRequest }));
vi.mock("@/server/lib/logger", () => ({
  logger: { warn: vi.fn() },
}));

import { dispatchStaleUnknownGenerationRequests } from "./stale-unknown-dispatcher";

describe("dispatchStaleUnknownGenerationRequests", () => {
  beforeEach(() => {
    reconcileUnknownGenerationRequest.mockReset();
  });

  it("settles only still-open unknown requests after the grace period", async () => {
    const generationAttempt = {
      findMany: vi.fn().mockResolvedValue([
        {
          id: "attempt-open",
          requestId: "request-open",
          errorCode: "provider_timeout",
          terminalRecordRef: "terminal:open",
        },
        {
          id: "attempt-terminal",
          requestId: "request-terminal",
          errorCode: null,
          terminalRecordRef: null,
        },
      ]),
    };
    const generationJob = {
      findMany: vi.fn().mockResolvedValue([{ id: "request-open", version: 4 }]),
    };
    reconcileUnknownGenerationRequest.mockResolvedValue({
      resolution: "confirm_failed",
      refundAmount: 12,
    });

    const now = new Date("2026-08-25T12:00:00.000Z");
    const result = await dispatchStaleUnknownGenerationRequests(
      { generationAttempt, generationJob } as unknown as PrismaClient,
      { now, graceMs: 30 * 60_000 },
    );

    expect(generationAttempt.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        status: "unknown",
        finishedAt: { lte: new Date("2026-08-25T11:30:00.000Z") },
      },
    }));
    expect(reconcileUnknownGenerationRequest).toHaveBeenCalledTimes(1);
    expect(reconcileUnknownGenerationRequest).toHaveBeenCalledWith(expect.objectContaining({
      requestId: "request-open",
      command: expect.objectContaining({ entityVersion: 4, resolution: "confirm_failed" }),
      idempotencyKey: "generation-unknown-sweep:request-open:attempt-open",
    }));
    expect(result).toEqual({ examined: 1, settled: 1, refunded: 12, skipped: 0 });
  });
});
