import {
  generationTerminalRecordChecksum,
  generationTerminalRecordIngestSchema,
  generationTerminalRecordSchema,
  idempotencyKeys,
  MAIN_QUEUES,
  type GenerationTerminalRecord,
  type GenerationTerminalRecordIngest,
} from "@idream/shared/contracts";
import type { BlobStore } from "./providers";
import { enqueueDurable } from "./queue";

export const GENERATION_TERMINAL_RELAY_MAX_ATTEMPTS = 20;

export class GenerationTerminalRecordConflictError extends Error {
  constructor(readonly attemptId: string) {
    super(`terminal record conflict for generation attempt ${attemptId}`);
    this.name = "GenerationTerminalRecordConflictError";
  }
}

type GenerationInvocationGuard = {
  readonly version: 1;
  readonly attemptId: string;
  readonly attemptNo: number;
  readonly transportAttemptNo: number;
  readonly providerIdempotencyKey: string;
  readonly requestId: string;
  readonly generationJobId: string;
  readonly mode: "image" | "video";
  readonly provider: string;
  readonly model: string | null;
  readonly reservedAt: string;
};

export class GenerationInvocationGuardConflictError extends Error {
  constructor(readonly attemptId: string) {
    super(`provider invocation guard conflict for generation attempt ${attemptId}`);
    this.name = "GenerationInvocationGuardConflictError";
  }
}

// SPEC: Non-replayable providers reserve one immutable invocation guard before
// the remote call. A later Bull attempt may recover an unknown outcome, but it
// must never invoke the provider again when this guard already exists.
// INTENT: The guard is deliberately separate from the terminal record. It
// survives the exact failure window where the provider returned but both the
// terminal object write and Main transport update were unavailable.
export async function reserveGenerationInvocation(
  blob: BlobStore,
  guard: GenerationInvocationGuard,
): Promise<{ created: boolean; guard: GenerationInvocationGuard }> {
  const validatedGuard = parseInvocationGuard(guard);
  const persisted = await blob.putPrivateIfAbsent({
    key: invocationGuardStorageRef(validatedGuard.attemptId),
    body: new TextEncoder().encode(JSON.stringify(validatedGuard)),
    contentType: "application/json",
  });
  if (!persisted.ok) throw new Error(persisted.error.message);
  if (persisted.data.created) {
    return { created: true, guard: validatedGuard };
  }
  const existing = await loadGenerationInvocationGuard(
    blob,
    validatedGuard.attemptId,
  );
  if (!existing || !sameInvocationIdentity(existing, validatedGuard)) {
    throw new GenerationInvocationGuardConflictError(validatedGuard.attemptId);
  }
  return { created: false, guard: existing };
}

export async function loadGenerationInvocationGuard(
  blob: BlobStore,
  attemptId: string,
): Promise<GenerationInvocationGuard | null> {
  if (!blob.getPrivate) {
    throw new Error("blob provider cannot read provider invocation guards");
  }
  const loaded = await blob.getPrivate({ key: invocationGuardStorageRef(attemptId) });
  if (!loaded.ok) {
    if (loaded.error.code === "not_found") return null;
    throw new Error(loaded.error.message);
  }
  return parseInvocationGuard(
    JSON.parse(new TextDecoder().decode(loaded.data.body)),
  );
}

export async function persistTerminalRecord(
  blob: BlobStore,
  terminalRecord: GenerationTerminalRecord,
): Promise<GenerationTerminalRecordIngest> {
  const validatedRecord = generationTerminalRecordSchema.parse(terminalRecord);
  const terminalRecordChecksum = generationTerminalRecordChecksum(validatedRecord);
  const terminalRecordRef = terminalRecordStorageRef(validatedRecord.attemptId);
  const persisted = await blob.putPrivateIfAbsent({
    key: terminalRecordRef,
    body: new TextEncoder().encode(JSON.stringify(validatedRecord)),
    contentType: "application/json",
  });
  if (!persisted.ok) throw new Error(persisted.error.message);
  if (!persisted.data.created) {
    const existing = await loadPersistedTerminalRecord(blob, validatedRecord.attemptId);
    if (
      !existing ||
      existing.terminalRecordChecksum !== terminalRecordChecksum
    ) {
      throw new GenerationTerminalRecordConflictError(validatedRecord.attemptId);
    }
    return existing;
  }
  return {
    terminalRecordRef,
    terminalRecordChecksum,
    terminalRecord: validatedRecord,
  };
}

export async function loadPersistedTerminalRecord(
  blob: BlobStore,
  attemptId: string,
): Promise<GenerationTerminalRecordIngest | null> {
  if (!blob.getPrivate) return null;
  const loaded = await blob.getPrivate({ key: terminalRecordStorageRef(attemptId) });
  if (!loaded.ok) {
    if (loaded.error.code === "not_found") return null;
    throw new Error(loaded.error.message);
  }
  const terminalRecord = generationTerminalRecordSchema.parse(
    JSON.parse(new TextDecoder().decode(loaded.data.body)),
  );
  return {
    terminalRecordRef: terminalRecordStorageRef(attemptId),
    terminalRecordChecksum: generationTerminalRecordChecksum(terminalRecord),
    terminalRecord,
  };
}

function terminalRecordStorageRef(attemptId: string): string {
  return `gen/terminal-records/${attemptId}/terminal.json`;
}

function invocationGuardStorageRef(attemptId: string): string {
  return `gen/terminal-records/${attemptId}/provider-invocation.json`;
}

function parseInvocationGuard(value: unknown): GenerationInvocationGuard {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid generation provider invocation guard");
  }
  const guard = value as Partial<GenerationInvocationGuard>;
  if (
    guard.version !== 1 ||
    typeof guard.attemptId !== "string" || !guard.attemptId ||
    !Number.isInteger(guard.attemptNo) || (guard.attemptNo ?? 0) < 1 ||
    !Number.isInteger(guard.transportAttemptNo) ||
      (guard.transportAttemptNo ?? 0) < 1 ||
    typeof guard.providerIdempotencyKey !== "string" ||
      !guard.providerIdempotencyKey ||
    typeof guard.requestId !== "string" || !guard.requestId ||
    typeof guard.generationJobId !== "string" || !guard.generationJobId ||
    !["image", "video"].includes(guard.mode ?? "") ||
    typeof guard.provider !== "string" || !guard.provider ||
    !(typeof guard.model === "string" || guard.model === null) ||
    typeof guard.reservedAt !== "string" ||
      !Number.isFinite(Date.parse(guard.reservedAt))
  ) {
    throw new Error("invalid generation provider invocation guard");
  }
  return guard as GenerationInvocationGuard;
}

function sameInvocationIdentity(
  existing: GenerationInvocationGuard,
  requested: GenerationInvocationGuard,
) {
  return (
    existing.attemptId === requested.attemptId &&
    existing.attemptNo === requested.attemptNo &&
    existing.providerIdempotencyKey === requested.providerIdempotencyKey &&
    existing.requestId === requested.requestId &&
    existing.generationJobId === requested.generationJobId &&
    existing.mode === requested.mode &&
    existing.provider === requested.provider &&
    existing.model === requested.model
  );
}

// SPEC: A persisted terminal record crosses into Main only through its own
// durable Bull lifecycle. Main HTTP availability never controls provider retry.
export async function enqueueTerminalRecordRelay(
  input: GenerationTerminalRecordIngest,
): Promise<void> {
  const relay = generationTerminalRecordIngestSchema.parse(input);
  await enqueueDurable({
    queue: MAIN_QUEUES.generationTerminalIngest,
    payload: relay as unknown as Record<string, unknown>,
    dedupeKey: idempotencyKeys.generationTerminalRelay(
      relay.terminalRecord.attemptId,
    ),
    maxAttempts: GENERATION_TERMINAL_RELAY_MAX_ATTEMPTS,
  });
}
