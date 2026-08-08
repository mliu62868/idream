import type { Prisma } from "@prisma/client";
import {
  generationDispatchRequestId,
  generationProviderIdempotencyKey,
  generationTerminalRecordRef,
  generationTerminalRecordSchema,
  idempotencyKeys,
  imageGeneratePayloadSchema,
  videoGeneratePayloadSchema,
  type GenerationTerminalRecord,
} from "@idream/shared/contracts";
import { MAIN_OUTBOX_GENERATION_DISPATCH_EVENT_TYPES } from "@/server/events/main-outbox-transport";
import { providers } from "@/server/providers";

export type GenerationDispatchMode = "image" | "video";

// Identity every piece of provider evidence carries: the pre-provider transport
// event, the Blob terminal record, and the terminal relay row all present it.
export type GenerationDispatchEvidenceIdentity = {
  readonly requestId?: string;
  readonly generationJobId: string;
  readonly attemptId: string;
  readonly attemptNo: number;
  readonly transportAttemptNo: number;
  readonly provider: string;
  readonly model?: string;
  readonly providerIdempotencyKey?: string;
};

export type PinnedGenerationAttempt = {
  readonly id: string;
  readonly requestId: string;
  readonly attemptNo: number;
  readonly provider: string | null;
  readonly profileKey: string | null;
  readonly profileVersion: number | null;
  readonly workflowKey: string | null;
  readonly workflowVersion: number | null;
};

export type GenerationDispatchJobAuthority = {
  readonly id: string;
  readonly mode: string;
};

export type GenerationDispatchOutboxRow = {
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly payload: Prisma.JsonValue | unknown;
};

export type ExactGenerationDispatchAuthority = {
  readonly mode: GenerationDispatchMode;
  readonly queue: string;
  readonly dedupeKey: string;
  readonly maxAttempts: number;
  readonly queueInput: Readonly<Record<string, unknown>>;
  readonly queuePayload: Readonly<Record<string, unknown>>;
};

export type GenerationDispatchAuthorityCode =
  | "generation_dispatch_identity_mismatch"
  | "generation_request_not_found"
  | "generation_dispatch_mode_unsupported"
  | "generation_dispatch_authority_not_found"
  | "generation_dispatch_authority_ambiguous"
  | "generation_dispatch_envelope_payload_invalid"
  | "generation_dispatch_transport_identity_mismatch"
  | "generation_dispatch_provider_mismatch"
  | "generation_dispatch_model_mismatch"
  | "generation_dispatch_provider_invocation_identity_mismatch"
  | "generation_dispatch_workflow_pin_mismatch";

export type GenerationDispatchEvidenceResolution =
  | { readonly ok: true; readonly authority: ExactGenerationDispatchAuthority }
  | { readonly ok: false; readonly code: GenerationDispatchAuthorityCode };

// SPEC: single decision for "does this belong to the exact immutable dispatch
// envelope that reserved this Attempt". Runtime evidence ingest, stale
// recovery, and the offline cutover gate all ask it here, so a row one of them
// accepts is never silently rejected by another.
// INTENT: pure — every authority row is supplied by the caller so the same
// judgement can run inside a PostgreSQL transaction and inside a read-only
// offline sweep that already loaded its rows in bulk.
// INVARIANT: omitting `evidence` checks only the envelope itself; supplying it
// additionally binds that evidence to the envelope. Mutable Request fields are
// never replay authority.
export function checkExactGenerationDispatchAuthority(input: {
  readonly job: GenerationDispatchJobAuthority;
  readonly attempt: PinnedGenerationAttempt;
  readonly dispatch: GenerationDispatchOutboxRow;
  readonly evidence?: GenerationDispatchEvidenceIdentity;
}): GenerationDispatchEvidenceResolution {
  const { job, attempt, dispatch, evidence } = input;
  const mode: GenerationDispatchMode | null = job.mode === "video"
    ? "video"
    : job.mode === "image"
      ? "image"
      : null;
  if (!mode) return mismatch("generation_dispatch_mode_unsupported");

  const dispatchPayload = jsonRecord(dispatch.payload);
  const queueInput = jsonRecord(dispatchPayload.queueInput);
  const parsed = (mode === "video"
    ? videoGeneratePayloadSchema
    : imageGeneratePayloadSchema).safeParse(queueInput.payload);
  if (!parsed.success) {
    return mismatch("generation_dispatch_envelope_payload_invalid");
  }
  const queuePayload = parsed.data as unknown as Record<string, unknown>;

  if (
    attempt.requestId !== job.id ||
    dispatch.aggregateType !== "generation_request" ||
    dispatch.aggregateId !== job.id ||
    dispatchPayload.generationJobId !== job.id ||
    dispatchPayload.attemptId !== attempt.id ||
    dispatchPayload.attemptNo !== attempt.attemptNo ||
    queuePayload.requestId !== generationDispatchRequestId(attempt.id) ||
    queuePayload.generationJobId !== job.id ||
    queuePayload.attemptId !== attempt.id ||
    queuePayload.attemptNo !== attempt.attemptNo ||
    (evidence !== undefined &&
      (evidence.generationJobId !== job.id ||
        evidence.attemptId !== attempt.id ||
        evidence.attemptNo !== attempt.attemptNo ||
        (evidence.requestId !== undefined &&
          evidence.requestId !== queuePayload.requestId)))
  ) {
    return mismatch("generation_dispatch_identity_mismatch");
  }

  const queue = `ai.${mode}.generate`;
  const dedupeKey = idempotencyKeys.generationAttempt(job.id, attempt.attemptNo);
  const maxAttempts = queueInput.maxAttempts;
  if (
    queueInput.queue !== queue ||
    queueInput.dedupeKey !== dedupeKey ||
    typeof maxAttempts !== "number" ||
    !Number.isSafeInteger(maxAttempts) ||
    maxAttempts < 1 ||
    (evidence !== undefined && evidence.transportAttemptNo > maxAttempts)
  ) {
    return mismatch("generation_dispatch_transport_identity_mismatch");
  }

  if (
    attempt.provider === null ||
    queuePayload.provider !== attempt.provider ||
    (evidence !== undefined && evidence.provider !== attempt.provider)
  ) {
    return mismatch("generation_dispatch_provider_mismatch");
  }
  if (
    evidence !== undefined &&
    (typeof evidence.model !== "string" ||
      evidence.model.length === 0 ||
      typeof queuePayload.model !== "string" ||
      evidence.model !== queuePayload.model)
  ) {
    return mismatch("generation_dispatch_model_mismatch");
  }
  if (
    evidence !== undefined &&
    evidence.providerIdempotencyKey !==
      generationProviderIdempotencyKey(attempt.id)
  ) {
    return mismatch("generation_dispatch_provider_invocation_identity_mismatch");
  }

  const controls = jsonRecord(queuePayload.controls);
  const dispatchedWorkflowKey =
    typeof controls.workflowKey === "string"
      ? controls.workflowKey
      : queuePayload.model;
  if (
    (attempt.workflowKey !== null &&
      dispatchedWorkflowKey !== attempt.workflowKey) ||
    (attempt.workflowVersion !== null &&
      controls.workflowVersion !== attempt.workflowVersion) ||
    (attempt.profileKey !== null &&
      controls.generationProfileKey !== attempt.profileKey) ||
    (attempt.profileVersion !== null &&
      controls.generationProfileVersion !== attempt.profileVersion)
  ) {
    return mismatch("generation_dispatch_workflow_pin_mismatch");
  }

  return {
    ok: true,
    authority: { mode, queue, dedupeKey, maxAttempts, queueInput, queuePayload },
  };
}

// A terminal record is provider evidence like any other transport event: it
// only binds to the envelope that produced it.
export function generationTerminalRecordEvidence(
  record: GenerationTerminalRecord,
): GenerationDispatchEvidenceIdentity {
  return {
    requestId: record.requestId,
    generationJobId: record.generationJobId,
    attemptId: record.attemptId,
    attemptNo: record.attemptNo,
    transportAttemptNo: record.transportAttemptNo,
    provider: record.provider,
    model: record.model,
    providerIdempotencyKey: record.providerIdempotencyKey,
  };
}

export type AttemptTerminalRecordRead =
  | { readonly ok: true; readonly record: GenerationTerminalRecord }
  | { readonly ok: false; readonly code: "absent" | "unreadable" }
  | { readonly ok: false; readonly code: "unavailable"; readonly message: string };

// SPEC: the Blob terminal record is read-only recovery evidence. A missing or
// corrupt object is a definite "no evidence"; an unreachable Blob store is not,
// so it is reported apart and each caller picks its own fail direction.
export async function readAttemptTerminalRecord(
  attemptId: string,
): Promise<AttemptTerminalRecordRead> {
  const blob = providers.blob;
  if (!blob.getPrivate) {
    return { ok: false, code: "unavailable", message: "blob terminal read unavailable" };
  }
  let loaded: Awaited<ReturnType<NonNullable<typeof blob.getPrivate>>>;
  try {
    loaded = await blob.getPrivate({
      key: generationTerminalRecordRef(attemptId),
    });
  } catch (error) {
    return {
      ok: false,
      code: "unavailable",
      message: error instanceof Error ? error.message : "blob terminal read failed",
    };
  }
  if (!loaded.ok) {
    return loaded.error.code === "not_found"
      ? { ok: false, code: "absent" }
      : { ok: false, code: "unavailable", message: loaded.error.message };
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(new TextDecoder().decode(loaded.data.body));
  } catch {
    return { ok: false, code: "unreadable" };
  }
  const parsed = generationTerminalRecordSchema.safeParse(decoded);
  return parsed.success
    ? { ok: true, record: parsed.data }
    : { ok: false, code: "unreadable" };
}

// SPEC: Gen evidence is accepted only against the exact immutable dispatch
// envelope that reserved this Attempt. An invalid early transport event must
// not reserve identities that can poison a later correct terminal record.
export async function resolveExactGenerationDispatchAuthority(
  tx: Prisma.TransactionClient,
  evidence: GenerationDispatchEvidenceIdentity,
  attempt: PinnedGenerationAttempt,
): Promise<GenerationDispatchEvidenceResolution> {
  if (
    evidence.generationJobId !== attempt.requestId ||
    evidence.attemptId !== attempt.id ||
    evidence.attemptNo !== attempt.attemptNo
  ) {
    return mismatch("generation_dispatch_identity_mismatch");
  }

  const job = await tx.generationJob.findUnique({
    where: { id: attempt.requestId },
    select: { id: true, mode: true },
  });
  const rows = await tx.mainOutboxEvent.findMany({
    where: {
      aggregateType: "generation_request",
      aggregateId: attempt.requestId,
      eventType: { in: [...MAIN_OUTBOX_GENERATION_DISPATCH_EVENT_TYPES] },
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  if (!job) return mismatch("generation_request_not_found");

  const matchingRows = rows.filter(
    (row) => jsonRecord(row.payload).attemptId === attempt.id,
  );
  if (matchingRows.length === 0) {
    return mismatch("generation_dispatch_authority_not_found");
  }
  if (matchingRows.length > 1) {
    return mismatch("generation_dispatch_authority_ambiguous");
  }

  return checkExactGenerationDispatchAuthority({
    job,
    attempt,
    dispatch: matchingRows[0]!,
    evidence,
  });
}

export function generationDispatchForAttempt<
  T extends { readonly payload: Prisma.JsonValue | unknown },
>(outboxes: readonly T[], attemptId: string): T | undefined {
  return outboxes.find(
    (row) => jsonRecord(row.payload).attemptId === attemptId,
  );
}

function mismatch(
  code: GenerationDispatchAuthorityCode,
): GenerationDispatchEvidenceResolution {
  return { ok: false, code };
}

function jsonRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
