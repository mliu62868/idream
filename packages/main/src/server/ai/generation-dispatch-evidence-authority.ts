import type { Prisma } from "@prisma/client";
import { MAIN_OUTBOX_GENERATION_DISPATCH_EVENT_TYPES } from "@/server/events/main-outbox-transport";

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

type PinnedGenerationAttempt = {
  readonly id: string;
  readonly requestId: string;
  readonly attemptNo: number;
  readonly provider: string | null;
  readonly profileKey: string | null;
  readonly profileVersion: number | null;
  readonly workflowKey: string | null;
  readonly workflowVersion: number | null;
};

export type ExactGenerationDispatchAuthority = {
  readonly mode: "image" | "video";
  readonly queueInput: Readonly<Record<string, unknown>>;
  readonly queuePayload: Readonly<Record<string, unknown>>;
};

export type GenerationDispatchEvidenceResolution =
  | { readonly ok: true; readonly authority: ExactGenerationDispatchAuthority }
  | { readonly ok: false; readonly code: string };

// SPEC: Gen evidence is accepted only against the exact immutable dispatch
// envelope that reserved this Attempt. Mutable Request fields are not replay
// authority, and an invalid early transport event must not reserve identities
// that can poison a later correct terminal record.
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

  const [job, rows] = await Promise.all([
    tx.generationJob.findUnique({
      where: { id: attempt.requestId },
      select: { mode: true },
    }),
    tx.mainOutboxEvent.findMany({
      where: {
        aggregateType: "generation_request",
        aggregateId: attempt.requestId,
        eventType: { in: [...MAIN_OUTBOX_GENERATION_DISPATCH_EVENT_TYPES] },
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    }),
  ]);
  if (!job) return mismatch("generation_request_not_found");
  const mode = job.mode === "video" ? "video" : job.mode === "image" ? "image" : null;
  if (!mode) return mismatch("generation_dispatch_mode_unsupported");

  const matchingRows = rows.filter(
    (row) => jsonRecord(row.payload).attemptId === attempt.id,
  );
  if (matchingRows.length === 0) {
    return mismatch("generation_dispatch_authority_not_found");
  }
  if (matchingRows.length > 1) {
    return mismatch("generation_dispatch_authority_ambiguous");
  }

  const dispatch = matchingRows[0]!;
  const dispatchPayload = jsonRecord(dispatch.payload);
  const queueInput = jsonRecord(dispatchPayload.queueInput);
  const queuePayload = jsonRecord(queueInput.payload);
  if (
    dispatch.aggregateType !== "generation_request" ||
    dispatch.aggregateId !== attempt.requestId ||
    dispatchPayload.generationJobId !== attempt.requestId ||
    dispatchPayload.attemptId !== attempt.id ||
    dispatchPayload.attemptNo !== attempt.attemptNo ||
    queuePayload.requestId !== `generation_dispatch_${attempt.id}` ||
    (evidence.requestId !== undefined && evidence.requestId !== queuePayload.requestId) ||
    queuePayload.generationJobId !== attempt.requestId ||
    queuePayload.attemptId !== attempt.id ||
    queuePayload.attemptNo !== attempt.attemptNo
  ) {
    return mismatch("generation_dispatch_identity_mismatch");
  }

  const maxAttempts = queueInput.maxAttempts;
  if (
    queueInput.queue !== `ai.${mode}.generate` ||
    queuePayload.kind !== mode ||
    queueInput.dedupeKey !==
      `generation:${attempt.requestId}:attempt:${attempt.attemptNo}` ||
    typeof maxAttempts !== "number" ||
    !Number.isSafeInteger(maxAttempts) ||
    maxAttempts < 1 ||
    evidence.transportAttemptNo > maxAttempts
  ) {
    return mismatch("generation_dispatch_transport_identity_mismatch");
  }

  if (
    attempt.provider === null ||
    evidence.provider !== attempt.provider ||
    queuePayload.provider !== attempt.provider
  ) {
    return mismatch("generation_dispatch_provider_mismatch");
  }
  if (
    typeof evidence.model !== "string" ||
    evidence.model.length === 0 ||
    typeof queuePayload.model !== "string" ||
    evidence.model !== queuePayload.model
  ) {
    return mismatch("generation_dispatch_model_mismatch");
  }
  if (
    evidence.providerIdempotencyKey !==
      `generation:${attempt.id}:provider`
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

  return { ok: true, authority: { mode, queueInput, queuePayload } };
}

function mismatch(code: string): GenerationDispatchEvidenceResolution {
  return { ok: false, code };
}

function jsonRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
