import { Prisma, type GenerationJob } from "@prisma/client";
import { Errors } from "@/server/lib/errors";
import {
  GENERATION_REQUEST_STATES,
  isGenerationRequestTransitionAllowed,
} from "@/server/modules/admin-v2/shared/state-transition-authority";

export type GenerationRequestStatus = (typeof GENERATION_REQUEST_STATES)[number];

type GenerationRequestTransitionData = Omit<
  Prisma.GenerationJobUpdateManyMutationInput,
  "status" | "version"
>;

interface GenerationRequestTransitionExpectation {
  readonly from?: GenerationRequestStatus | readonly GenerationRequestStatus[];
  readonly version?: number;
}

interface TransitionGenerationRequestInput {
  readonly requestId: string;
  readonly to: GenerationRequestStatus;
  readonly expected?: GenerationRequestTransitionExpectation;
  readonly data?: GenerationRequestTransitionData;
  readonly onConflict?: "throw" | "return-null";
}

export interface GenerationRequestTransitionResult {
  readonly request: GenerationJob;
  readonly disposition: "applied" | "duplicate";
}

export function updateGenerationRequestSourceMeta(
  tx: Prisma.TransactionClient,
  input: {
    readonly requestId: string;
    readonly sourceMeta: Prisma.InputJsonValue;
  },
): Promise<GenerationJob> {
  return tx.generationJob.update({
    where: { id: input.requestId },
    data: { sourceMeta: input.sourceMeta },
  });
}

function expectedStates(expected: GenerationRequestTransitionExpectation | undefined) {
  if (!expected?.from) return null;
  return Array.isArray(expected.from) ? expected.from : [expected.from];
}

function conflict(
  input: Pick<TransitionGenerationRequestInput, "requestId" | "onConflict">,
  message: string,
  details: Record<string, unknown>,
) {
  if (input.onConflict === "return-null") return null;
  throw Errors.conflict(message, details);
}

export function transitionGenerationRequest(
  tx: Prisma.TransactionClient,
  input: TransitionGenerationRequestInput & { readonly onConflict: "return-null" },
): Promise<GenerationJob | null>;
export function transitionGenerationRequest(
  tx: Prisma.TransactionClient,
  input: TransitionGenerationRequestInput & { readonly onConflict?: "throw" },
): Promise<GenerationJob>;
export async function transitionGenerationRequest(
  tx: Prisma.TransactionClient,
  input: TransitionGenerationRequestInput,
): Promise<GenerationJob | null> {
  const result = await transitionGenerationRequestWithDisposition(tx, input);
  return result?.request ?? null;
}

export async function transitionGenerationRequestWithDisposition(
  tx: Prisma.TransactionClient,
  input: TransitionGenerationRequestInput,
): Promise<GenerationRequestTransitionResult | null> {
  const current = await tx.generationJob.findUnique({ where: { id: input.requestId } });
  if (!current) {
    return conflict(input, "Generation Request does not exist", { requestId: input.requestId });
  }

  const states = expectedStates(input.expected);
  if (
    (states && !states.includes(current.status as GenerationRequestStatus)) ||
    (input.expected?.version !== undefined && current.version !== input.expected.version)
  ) {
    return conflict(input, "Generation Request changed before transition", {
      requestId: input.requestId,
      expectedFrom: states,
      actualFrom: current.status,
      expectedVersion: input.expected?.version,
      actualVersion: current.version,
    });
  }
  if (!isGenerationRequestTransitionAllowed(current.status, input.to)) {
    return conflict(
      input,
      `Generation Request transition ${current.status} -> ${input.to} is not allowed`,
      { requestId: input.requestId, version: current.version },
    );
  }
  if (current.status === input.to) {
    await projectCharacterPreviewRequestState(tx, current);
    return { request: current, disposition: "duplicate" };
  }

  const changed = await tx.generationJob.updateMany({
    where: {
      id: current.id,
      status: current.status,
      version: current.version,
    },
    data: {
      ...input.data,
      status: input.to,
      version: { increment: 1 },
    },
  });
  if (changed.count !== 1) {
    return conflict(input, "Generation Request changed during transition", {
      requestId: input.requestId,
      from: current.status,
      to: input.to,
      version: current.version,
    });
  }
  const request = await tx.generationJob.findUniqueOrThrow({
    where: { id: current.id },
  });
  await projectCharacterPreviewRequestState(tx, request);
  return { request, disposition: "applied" };
}

async function projectCharacterPreviewRequestState(
  tx: Prisma.TransactionClient,
  request: GenerationJob,
) {
  if (request.sourceType !== "character_preview" || !request.sourceId) return;
  const preview = await tx.characterPreviewJob.findUnique({
    where: { id: request.sourceId },
    include: { draft: { select: { ownerId: true } } },
  });
  // The draft may have been deliberately deleted while provider work was in
  // flight. That removes the Preview target but must not strand terminal ACK.
  if (!preview) return;
  if (preview.draft.ownerId !== request.userId) {
    throw Errors.conflict(
      "Character Preview source does not belong to the Generation Request owner",
      { requestId: request.id, previewJobId: preview.id },
    );
  }

  if (request.status === "queued") {
    await tx.characterPreviewJob.update({
      where: { id: preview.id },
      data: {
        status: "queued",
        provider: request.provider,
        resultAssetId: null,
        errorCode: null,
        completedAt: null,
      },
    });
    return;
  }
  if (["moderating_input", "running", "moderating_output"].includes(request.status)) {
    if (!["completed", "failed"].includes(preview.status)) {
      await tx.characterPreviewJob.update({
        where: { id: preview.id },
        data: { status: "running", provider: request.provider },
      });
    }
    return;
  }
  if (request.status === "completed") {
    const asset = await tx.mediaAsset.findFirst({
      where: { sourceJobId: request.id },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { id: true },
    });
    if (!asset) {
      throw Errors.conflict(
        "Completed Character Preview Generation Request has no delivered asset",
        { requestId: request.id, previewJobId: preview.id },
      );
    }
    if (preview.status === "failed") {
      throw Errors.conflict(
        "Failed Character Preview cannot be overwritten by a late Generation result",
        { requestId: request.id, previewJobId: preview.id },
      );
    }
    await tx.characterPreviewJob.update({
      where: { id: preview.id },
      data: {
        status: "completed",
        provider: request.provider,
        resultAssetId: asset.id,
        errorCode: null,
        completedAt: request.completedAt ?? request.finishedAt ?? new Date(),
      },
    });
    await tx.characterDraft.updateMany({
      where: { id: preview.draftId, ownerId: request.userId },
      data: { previewJobId: preview.id },
    });
    return;
  }
  if (["failed", "blocked", "refunded", "cancelled"].includes(request.status)) {
    if (preview.status === "completed") return;
    await tx.characterPreviewJob.update({
      where: { id: preview.id },
      data: {
        status: "failed",
        provider: request.provider,
        resultAssetId: null,
        errorCode: request.errorCode ?? `generation_${request.status}`,
        completedAt: request.finishedAt ?? new Date(),
      },
    });
  }
}
