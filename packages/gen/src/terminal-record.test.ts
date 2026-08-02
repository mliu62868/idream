import {
  generationTerminalRecordSchema,
  idempotencyKeys,
  MAIN_QUEUES,
  type GenerationTerminalRecord,
} from "@idream/shared/contracts";
import { describe, expect, it, vi } from "vitest";
import type { BlobStore } from "./providers";
import { enqueueDurable } from "./queue";
import {
  enqueueTerminalRecordRelay,
  GENERATION_TERMINAL_RELAY_MAX_ATTEMPTS,
  GenerationInvocationGuardConflictError,
  GenerationTerminalRecordConflictError,
  loadGenerationInvocationGuard,
  loadPersistedTerminalRecord,
  persistTerminalRecord,
  reserveGenerationInvocation,
} from "./terminal-record";

vi.mock("./queue", () => ({
  enqueueDurable: vi.fn(async () => ({ id: "terminal-relay-job" })),
}));

function terminalRecord(
  overrides: Partial<GenerationTerminalRecord> = {},
): GenerationTerminalRecord {
  return generationTerminalRecordSchema.parse({
    version: 1,
    outcome: "succeeded",
    attemptId: "attempt-1",
    attemptNo: 1,
    transportAttemptNo: 1,
    providerIdempotencyKey: "generation:attempt-1:provider",
    requestId: "request-1",
    generationJobId: "job-1",
    mode: "image",
    provider: "backend",
    providerInvoked: true,
    model: "image-model",
    providerRequestId: "provider-request-1",
    completedAt: "2026-08-01T12:00:00.000Z",
    usage: { images: 1 },
    assets: [{
      ordinal: 0,
      key: "gen/job-1/image-1.webp",
      contentType: "image/webp",
      providerKey: "provider/image-1",
    }],
    ...overrides,
  });
}

function memoryBlob(): BlobStore {
  const objects = new Map<string, { body: Uint8Array; contentType: string }>();
  return {
    putPrivate: vi.fn(async (input) => {
      objects.set(input.key, {
        body: input.body,
        contentType: input.contentType,
      });
      return {
        ok: true as const,
        data: { key: input.key, size: input.body.byteLength },
      };
    }),
    putPrivateIfAbsent: vi.fn(async (input) => {
      if (objects.has(input.key)) {
        return {
          ok: true as const,
          data: {
            key: input.key,
            size: input.body.byteLength,
            created: false,
          },
        };
      }
      objects.set(input.key, {
        body: input.body,
        contentType: input.contentType,
      });
      return {
        ok: true as const,
        data: {
          key: input.key,
          size: input.body.byteLength,
          created: true,
        },
      };
    }),
    delete: vi.fn(async (input) => {
      objects.delete(input.key);
      return { ok: true as const, data: { deleted: true as const } };
    }),
    getPrivate: vi.fn(async (input) => {
      const object = objects.get(input.key);
      return object
        ? {
            ok: true as const,
            data: { body: object.body, contentType: object.contentType },
          }
        : {
            ok: false as const,
            error: {
              code: "not_found",
              message: "not found",
              retryable: false,
            },
          };
    }),
    signGetUrl: vi.fn(async (input) => ({
      ok: true as const,
      data: { url: `memory://${input.key}` },
    })),
  };
}

describe("generation terminal record persistence", () => {
  const invocationGuard = {
    version: 1 as const,
    attemptId: "attempt-guard-1",
    attemptNo: 1,
    transportAttemptNo: 1,
    providerIdempotencyKey: "generation:attempt-guard-1:provider",
    requestId: "request-guard-1",
    generationJobId: "job-guard-1",
    mode: "image" as const,
    provider: "comfyui",
    model: "image-model",
    reservedAt: "2026-08-01T12:00:00.000Z",
  };

  it("reserves one immutable non-replayable provider invocation", async () => {
    const blob = memoryBlob();

    await expect(reserveGenerationInvocation(blob, invocationGuard)).resolves
      .toEqual({ created: true, guard: invocationGuard });
    await expect(reserveGenerationInvocation(blob, {
      ...invocationGuard,
      transportAttemptNo: 2,
      reservedAt: "2026-08-01T12:01:00.000Z",
    })).resolves.toEqual({ created: false, guard: invocationGuard });
    await expect(loadGenerationInvocationGuard(blob, invocationGuard.attemptId))
      .resolves.toEqual(invocationGuard);
  });

  it("rejects a conflicting provider invocation identity", async () => {
    const blob = memoryBlob();
    await reserveGenerationInvocation(blob, invocationGuard);

    await expect(reserveGenerationInvocation(blob, {
      ...invocationGuard,
      provider: "other-provider",
      transportAttemptNo: 2,
    })).rejects.toBeInstanceOf(GenerationInvocationGuardConflictError);
  });

  it("rejects provider-free terminal evidence outside an input block", () => {
    expect(generationTerminalRecordSchema.safeParse({
      ...terminalRecord(),
      providerInvoked: false,
    }).success).toBe(false);
    expect(generationTerminalRecordSchema.safeParse({
      ...terminalRecord(),
      providerInvoked: false,
      providerRequestId: null,
      accounting: undefined,
      outcome: "blocked",
      assets: undefined,
      block: {
        policyCode: "UNDERAGE",
        message: "Input moderation blocked the request",
        layer: "input",
      },
    }).success).toBe(true);
  });

  it("replays the existing immutable record when its checksum matches", async () => {
    const blob = memoryBlob();
    const record = terminalRecord();

    const first = await persistTerminalRecord(blob, record);
    const replay = await persistTerminalRecord(blob, record);

    expect(replay).toEqual(first);
    expect(blob.putPrivate).not.toHaveBeenCalled();
    expect(blob.putPrivateIfAbsent).toHaveBeenCalledTimes(2);
    expect(blob.getPrivate).toHaveBeenCalledTimes(1);
  });

  it("rejects a second terminal outcome without replacing the first", async () => {
    const blob = memoryBlob();
    const first = terminalRecord();
    const conflicting = terminalRecord({
      completedAt: "2026-08-01T12:01:00.000Z",
    });

    await persistTerminalRecord(blob, first);
    await expect(persistTerminalRecord(blob, conflicting)).rejects.toBeInstanceOf(
      GenerationTerminalRecordConflictError,
    );

    await expect(loadPersistedTerminalRecord(blob, first.attemptId)).resolves
      .toMatchObject({ terminalRecord: first });
  });

  it("hands persisted evidence to the Main-owned durable relay", async () => {
    const blob = memoryBlob();
    const ingest = await persistTerminalRecord(blob, terminalRecord());
    vi.mocked(enqueueDurable).mockClear();

    await enqueueTerminalRecordRelay(ingest);

    expect(enqueueDurable).toHaveBeenCalledWith({
      queue: MAIN_QUEUES.generationTerminalIngest,
      payload: ingest,
      dedupeKey: idempotencyKeys.generationTerminalRelay(
        ingest.terminalRecord.attemptId,
      ),
      maxAttempts: GENERATION_TERMINAL_RELAY_MAX_ATTEMPTS,
    });
  });
});
