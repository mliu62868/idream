import type { PrismaClient } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { reconcileUnknownGenerationRequest, validatedUnknownSuccessResolution } = vi.hoisted(() => ({
  reconcileUnknownGenerationRequest: vi.fn(),
  validatedUnknownSuccessResolution: vi.fn(),
}));

vi.mock("./unknown-reconciliation", () => ({ reconcileUnknownGenerationRequest }));
vi.mock("@/server/ai/generation-unknown-resolution-evidence", () => ({ validatedUnknownSuccessResolution }));
vi.mock("@/server/lib/logger", () => ({
  logger: { warn: vi.fn() },
}));

import { dispatchStaleUnknownGenerationRequests } from "./stale-unknown-dispatcher";

const row = (id: string, finishedAt = new Date("2026-08-25T10:00:00.000Z")) => ({
  id: `attempt-${id}`,
  requestId: `request-${id}`,
  errorCode: "provider_timeout",
  terminalRecordRef: `terminal:${id}`,
  version: 4,
  finishedAt,
});
const dbWith = (rows: unknown[]) => ({ $queryRaw: vi.fn().mockResolvedValue(rows) }) as unknown as PrismaClient;

describe("dispatchStaleUnknownGenerationRequests", () => {
  beforeEach(() => {
    reconcileUnknownGenerationRequest.mockReset();
    validatedUnknownSuccessResolution.mockReset();
    validatedUnknownSuccessResolution.mockResolvedValue(null);
  });

  it("settles only still-open unknown requests after the grace period", async () => {
    const db = dbWith([row("open")]);
    reconcileUnknownGenerationRequest.mockResolvedValue({
      resolution: "confirm_failed",
      refundAmount: 12,
    });

    const now = new Date("2026-08-25T12:00:00.000Z");
    const result = await dispatchStaleUnknownGenerationRequests(db, { now, graceMs: 30 * 60_000 });

    const params = vi.mocked(db.$queryRaw).mock.calls[0]!.slice(1);
    expect(params).toContainEqual(new Date("2026-08-25T11:30:00.000Z"));
    expect(params).toContain(50);
    expect(reconcileUnknownGenerationRequest).toHaveBeenCalledTimes(1);
    expect(reconcileUnknownGenerationRequest).toHaveBeenCalledWith(expect.objectContaining({
      requestId: "request-open",
      command: expect.objectContaining({ entityVersion: 4, resolution: "confirm_failed" }),
      idempotencyKey: "generation-unknown-sweep:request-open:attempt-open",
    }));
    expect(result).toEqual({ examined: 1, settled: 1, adopted: 0, refunded: 12, skipped: 0, nextCursor: null });
  });

  it("adopts validated late success instead of asking to fail it", async () => {
    validatedUnknownSuccessResolution.mockResolvedValue({ payload: { terminalRecordRef: "terminal:recovered" }, receiptId: "receipt", eventId: "event" });
    reconcileUnknownGenerationRequest.mockResolvedValue({ resolution: "adopt_succeeded", refundAmount: 3 });

    const result = await dispatchStaleUnknownGenerationRequests(dbWith([row("late")]), { graceMs: 0 });

    expect(reconcileUnknownGenerationRequest).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      requestId: "request-late",
      actor: expect.objectContaining({ id: "system:generation-unknown-sweeper" }),
      command: expect.objectContaining({ resolution: "adopt_succeeded", providerEvidenceRefs: ["terminal:recovered"] }),
      idempotencyKey: "generation-unknown-sweep-adopt:request-late:attempt-late",
    }));
    expect(result).toMatchObject({ settled: 1, adopted: 1, refunded: 3, skipped: 0 });
  });

  it("returns a cursor past a full page even when every row in it refused to settle", async () => {
    const rows = Array.from({ length: 50 }, (_, index) => row(`stuck-${index}`, new Date(1_000 + index)));
    reconcileUnknownGenerationRequest.mockRejectedValue(new Error("still recoverable"));

    const result = await dispatchStaleUnknownGenerationRequests(dbWith(rows), { graceMs: 0 });

    expect(result).toMatchObject({ examined: 50, settled: 0, skipped: 50, nextCursor: { finishedAt: new Date(1_049), id: "attempt-stuck-49" } });
  });
});
