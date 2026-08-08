import {
  Prisma,
  type GenerationArtifact,
  type GenerationAttempt,
  type GenerationDelivery,
} from "@prisma/client";
import {
  generationArtifactArchiveStateSchema,
  generationArtifactValidationStateSchema,
  generationDeliveryStatusSchema,
  generationTransportExecutionStatusSchema,
} from "@idream/shared/admin";
import { Errors } from "@/server/lib/errors";
import { canonicalSha256 } from "@/server/modules/admin-v2/shared/canonical-json";

type StateOf<States extends readonly string[]> = States[number];
type TransitionRows<States extends readonly string[]> = {
  readonly [State in StateOf<States>]: readonly StateOf<States>[];
};

function defineAuthority<const States extends readonly string[]>(
  states: States,
  transitions: TransitionRows<States>,
) {
  const known = new Set<string>(states);
  return (from: string, to: string) =>
    known.has(from) && known.has(to) &&
    transitions[from as StateOf<States>].some((candidate) => candidate === to);
}

export const GENERATION_TRANSPORT_EXECUTION_STATES = generationTransportExecutionStatusSchema.options;
export const GENERATION_ARTIFACT_VALIDATION_STATES = generationArtifactValidationStateSchema.options;
export const GENERATION_ARTIFACT_ARCHIVE_STATES = generationArtifactArchiveStateSchema.options;
export const GENERATION_DELIVERY_STATES = generationDeliveryStatusSchema.options;

export const isGenerationTransportExecutionTransitionAllowed = defineAuthority(
  GENERATION_TRANSPORT_EXECUTION_STATES,
  {
    running: ["running", "succeeded", "failed", "unknown"],
    succeeded: ["succeeded"],
    failed: ["failed"],
    unknown: ["unknown"],
  },
);

export const isGenerationArtifactValidationTransitionAllowed = defineAuthority(
  GENERATION_ARTIFACT_VALIDATION_STATES,
  {
    produced: ["produced", "valid", "invalid", "rejected", "late_after_failed", "late_after_blocked", "late_after_cancelled", "late_after_refunded", "late_after_unknown"],
    valid: ["valid", "late_after_failed", "late_after_blocked", "late_after_cancelled", "late_after_refunded", "late_after_unknown"],
    invalid: ["invalid"],
    rejected: ["rejected"],
    late_after_failed: ["late_after_failed"],
    late_after_blocked: ["late_after_blocked"],
    late_after_cancelled: ["late_after_cancelled"],
    late_after_refunded: ["late_after_refunded"],
    late_after_unknown: ["late_after_unknown"],
  },
);

export const isGenerationArtifactArchiveTransitionAllowed = defineAuthority(
  GENERATION_ARTIFACT_ARCHIVE_STATES,
  { active: ["active", "archived"], archived: ["archived"] },
);

export const isGenerationDeliveryTransitionAllowed = defineAuthority(
  GENERATION_DELIVERY_STATES,
  {
    pending: ["pending", "delivered", "failed", "suppressed"],
    delivered: ["delivered"],
    failed: ["failed"],
    suppressed: ["suppressed"],
  },
);

type GenerationArtifactValidationState =
  (typeof GENERATION_ARTIFACT_VALIDATION_STATES)[number];

const LATE_ARTIFACT_STATE_BY_TERMINAL_STATUS = {
  cancelled: "late_after_cancelled",
  failed: "late_after_failed",
  blocked: "late_after_blocked",
  refunded: "late_after_refunded",
  unknown: "late_after_unknown",
} as const satisfies Record<string, GenerationArtifactValidationState>;

// SPEC: provider artifacts that land after their owning work already reached a
// terminal outcome are archived and suppressed, never delivered.
// INTENT: one function for one real-world fact. Terminal-record ingest sees the
// Attempt's terminal status while finalize sees the Request's, and they used to
// derive their own state strings from their own if-chains — which is how
// "arrived after cancel" ended up recorded under two different names, splitting
// every operator count that filters on validationState.
// INVARIANT: the Attempt fact wins when both are terminal. It is the more
// specific one — an Attempt can be terminal (e.g. unknown) while its Request is
// still active.
export function lateArtifactDisposition(input: {
  readonly requestStatus?: string | null;
  readonly attemptStatus?: string | null;
}): GenerationArtifactValidationState | null {
  const terminal = (status: string | null | undefined) =>
    status && status in LATE_ARTIFACT_STATE_BY_TERMINAL_STATUS
      ? LATE_ARTIFACT_STATE_BY_TERMINAL_STATUS[
          status as keyof typeof LATE_ARTIFACT_STATE_BY_TERMINAL_STATUS
        ]
      : null;
  return terminal(input.attemptStatus) ?? terminal(input.requestStatus);
}
type GenerationArtifactArchiveState =
  (typeof GENERATION_ARTIFACT_ARCHIVE_STATES)[number];
type GenerationDeliveryStatus = (typeof GENERATION_DELIVERY_STATES)[number];

async function lockGenerationAttempt(
  tx: Prisma.TransactionClient,
  attemptId: string,
): Promise<GenerationAttempt> {
  const locked = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT id
    FROM generation_attempts
    WHERE id = ${attemptId}
    FOR UPDATE
  `);
  if (locked.length !== 1) {
    throw Errors.conflict("Generation Artifact requires a reserved Attempt", {
      attemptId,
    });
  }
  return tx.generationAttempt.findUniqueOrThrow({ where: { id: attemptId } });
}

async function lockGenerationArtifact(
  tx: Prisma.TransactionClient,
  artifactId: string,
): Promise<GenerationArtifact> {
  const locked = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT id
    FROM generation_artifacts
    WHERE id = ${artifactId}
    FOR UPDATE
  `);
  if (locked.length !== 1) {
    throw Errors.conflict("Generation Artifact does not exist", { artifactId });
  }
  return tx.generationArtifact.findUniqueOrThrow({ where: { id: artifactId } });
}

function artifactOrdinalFromMediaMetadata(metadata: Prisma.JsonValue) {
  if (Array.isArray(metadata) || metadata === null || typeof metadata !== "object") {
    return null;
  }
  const ordinal = metadata.index;
  return typeof ordinal === "number" && Number.isInteger(ordinal) && ordinal >= 0
    ? ordinal
    : null;
}

async function generationRequestOwnerId(
  tx: Prisma.TransactionClient,
  requestId: string,
  artifactId: string,
) {
  const request = await tx.generationJob.findUnique({
    where: { id: requestId },
    select: { userId: true },
  });
  if (!request) {
    throw Errors.conflict("Generation Artifact has no owning Generation Request", {
      artifactId,
      requestId,
    });
  }
  return request.userId;
}

async function assertMediaAssetBinding(
  tx: Prisma.TransactionClient,
  artifact: GenerationArtifact,
  assetId: string,
) {
  await tx.$queryRaw(Prisma.sql`
    SELECT id
    FROM media_assets
    WHERE id = ${assetId}
    FOR SHARE
  `);
  const asset = await tx.mediaAsset.findUnique({
    where: { id: assetId },
    select: {
      ownerId: true,
      sourceJobId: true,
      providerAssetId: true,
      metadata: true,
    },
  });
  const attempt = await tx.generationAttempt.findUnique({
    where: { id: artifact.attemptId },
    select: { requestId: true },
  });
  const requestOwnerId = attempt
    ? await generationRequestOwnerId(tx, attempt.requestId, artifact.id)
    : null;
  if (
    !asset ||
    !attempt ||
    asset.ownerId !== requestOwnerId ||
    asset.sourceJobId !== attempt.requestId ||
    artifactOrdinalFromMediaMetadata(asset.metadata) !== artifact.ordinal ||
    (artifact.providerRef !== null &&
      asset.providerAssetId !== artifact.providerRef)
  ) {
    throw Errors.conflict(
      "MediaAsset does not match its Generation Artifact evidence",
      { artifactId: artifact.id, assetId },
    );
  }
}

function assertProducedArtifactIdentity(
  artifact: GenerationArtifact,
  input: {
    readonly attemptId: string;
    readonly ordinal: number;
    readonly providerRef: string | null;
    readonly terminalRecordChecksum: string;
  },
) {
  if (
    artifact.attemptId !== input.attemptId ||
    artifact.ordinal !== input.ordinal ||
    artifact.providerRef !== input.providerRef ||
    artifact.terminalRecordChecksum !== input.terminalRecordChecksum
  ) {
    throw Errors.conflict(
      "Generation Artifact identity was replayed with different provider evidence",
      { artifactId: artifact.id, attemptId: input.attemptId, ordinal: input.ordinal },
    );
  }
}

// SPEC: Provider output identity is immutable once an Attempt records it.
// INVARIANT: The Attempt row lock serializes all Artifact ordinals for one invocation.
export async function ensureProducedGenerationArtifact(
  tx: Prisma.TransactionClient,
  input: {
    readonly attemptId: string;
    readonly ordinal: number;
    readonly providerRef: string | null;
    readonly terminalRecordChecksum: string;
  },
): Promise<GenerationArtifact & { disposition: "created" | "duplicate" }> {
  if (!Number.isInteger(input.ordinal) || input.ordinal < 0) {
    throw Errors.badRequest("Generation Artifact ordinal must be non-negative");
  }
  if (!/^[a-f0-9]{64}$/.test(input.terminalRecordChecksum)) {
    throw Errors.badRequest("Generation Artifact requires a terminal record checksum");
  }
  await lockGenerationAttempt(tx, input.attemptId);
  const key = {
    attemptId_ordinal: { attemptId: input.attemptId, ordinal: input.ordinal },
  } as const;
  const existing = await tx.generationArtifact.findUnique({ where: key });
  if (existing) {
    assertProducedArtifactIdentity(existing, input);
    return { ...existing, disposition: "duplicate" };
  }
  const artifact = await tx.generationArtifact.create({
    data: {
      attemptId: input.attemptId,
      ordinal: input.ordinal,
      providerRef: input.providerRef,
      terminalRecordChecksum: input.terminalRecordChecksum,
      validationState: "produced",
      archiveState: "active",
    },
  });
  return { ...artifact, disposition: "created" };
}

// SPEC: Evidence advances through one finite state authority and may bind one MediaAsset.
// INVARIANT: Neither validation/archive state nor the bound asset can be rewritten by races.
export async function transitionGenerationArtifactEvidence(
  tx: Prisma.TransactionClient,
  input: {
    readonly artifactId: string;
    readonly validationState: GenerationArtifactValidationState;
    readonly archiveState?: GenerationArtifactArchiveState;
    readonly assetId?: string;
  },
): Promise<GenerationArtifact & { disposition: "updated" | "duplicate" }> {
  const validationState = generationArtifactValidationStateSchema.parse(
    input.validationState,
  );
  const archiveState = input.archiveState === undefined
    ? undefined
    : generationArtifactArchiveStateSchema.parse(input.archiveState);
  if (input.assetId !== undefined && input.assetId.length === 0) {
    throw Errors.badRequest("Generation Artifact asset id cannot be empty");
  }
  const artifact = await lockGenerationArtifact(tx, input.artifactId);
  if (
    !isGenerationArtifactValidationTransitionAllowed(
      artifact.validationState,
      validationState,
    ) ||
    (archiveState !== undefined &&
      !isGenerationArtifactArchiveTransitionAllowed(
        artifact.archiveState,
        archiveState,
      ))
  ) {
    throw Errors.conflict("Generation Artifact evidence is already terminal", {
      artifactId: artifact.id,
      validationState: artifact.validationState,
      archiveState: artifact.archiveState,
    });
  }
  if (
    input.assetId !== undefined &&
    artifact.assetId !== null &&
    artifact.assetId !== input.assetId
  ) {
    throw Errors.conflict("Generation Artifact is already bound to another MediaAsset", {
      artifactId: artifact.id,
      assetId: artifact.assetId,
    });
  }
  if (input.assetId !== undefined) {
    await assertMediaAssetBinding(tx, artifact, input.assetId);
  }
  const nextArchiveState = archiveState ?? artifact.archiveState;
  const nextAssetId = input.assetId ?? artifact.assetId;
  if (
    artifact.validationState === validationState &&
    artifact.archiveState === nextArchiveState &&
    artifact.assetId === nextAssetId
  ) {
    return { ...artifact, disposition: "duplicate" };
  }
  const updated = await tx.generationArtifact.updateMany({
    where: {
      id: artifact.id,
      validationState: artifact.validationState,
      archiveState: artifact.archiveState,
      assetId: artifact.assetId,
    },
    data: {
      validationState,
      archiveState: nextArchiveState,
      assetId: nextAssetId,
    },
  });
  if (updated.count !== 1) {
    throw Errors.conflict("Generation Artifact evidence changed during transition", {
      artifactId: artifact.id,
    });
  }
  const result = await tx.generationArtifact.findUniqueOrThrow({
    where: { id: artifact.id },
  });
  return { ...result, disposition: "updated" };
}

function deliveryId(input: {
  readonly requestId: string;
  readonly artifactId: string;
  readonly targetType: string;
  readonly targetId: string;
}) {
  return `generation_delivery_${canonicalSha256(input).slice(0, 32)}`;
}

function assertDeliveryIdentity(
  delivery: GenerationDelivery,
  input: {
    readonly requestId: string;
    readonly artifactId: string;
    readonly targetType: string;
    readonly targetId: string;
  },
) {
  if (
    delivery.requestId !== input.requestId ||
    delivery.artifactId !== input.artifactId ||
    delivery.targetType !== input.targetType ||
    delivery.targetId !== input.targetId
  ) {
    throw Errors.conflict("Generation Delivery identity was replayed differently", {
      deliveryId: delivery.id,
    });
  }
}

function assertArtifactReadyForDelivery(
  artifact: GenerationArtifact,
  status: GenerationDeliveryStatus,
) {
  const validDelivery =
    status === "pending" ||
    (status === "delivered" &&
      artifact.validationState === "valid" &&
      artifact.assetId !== null &&
      artifact.archiveState === "active") ||
    (status === "failed" &&
      ["invalid", "rejected"].includes(artifact.validationState) &&
      artifact.archiveState === "archived") ||
    (status === "suppressed" &&
      artifact.validationState.startsWith("late_after_") &&
      artifact.archiveState === "archived");
  if (!validDelivery) {
    throw Errors.conflict("Generation Delivery conflicts with Artifact evidence", {
      artifactId: artifact.id,
      validationState: artifact.validationState,
      archiveState: artifact.archiveState,
      assetId: artifact.assetId,
      deliveryStatus: status,
    });
  }
}

// SPEC: A Delivery is the projection of one existing Artifact to one target.
// INVARIANT: deliveredAt is written exactly once with the pending -> delivered edge.
export async function projectGenerationDelivery(
  tx: Prisma.TransactionClient,
  input: {
    readonly requestId: string;
    readonly artifactId: string;
    readonly targetType: string;
    readonly targetId: string;
    readonly status: GenerationDeliveryStatus;
    readonly occurredAt: Date;
  },
): Promise<GenerationDelivery & { disposition: "created" | "updated" | "duplicate" }> {
  const status = generationDeliveryStatusSchema.parse(input.status);
  const artifact = await lockGenerationArtifact(tx, input.artifactId);
  const attempt = await tx.generationAttempt.findUnique({
    where: { id: artifact.attemptId },
    select: { requestId: true },
  });
  if (attempt?.requestId !== input.requestId) {
    throw Errors.conflict("Generation Delivery does not belong to its Request", {
      artifactId: artifact.id,
      requestId: input.requestId,
    });
  }
  if (input.targetType === "user_library") {
    const requestOwnerId = await generationRequestOwnerId(
      tx,
      input.requestId,
      artifact.id,
    );
    if (input.targetId !== requestOwnerId) {
      throw Errors.conflict(
        "Generation Delivery user library target is not the Request owner",
        {
          artifactId: artifact.id,
          requestId: input.requestId,
          targetId: input.targetId,
        },
      );
    }
    if (artifact.assetId !== null) {
      await tx.$queryRaw(Prisma.sql`
        SELECT id
        FROM media_assets
        WHERE id = ${artifact.assetId}
        FOR SHARE
      `);
      const asset = await tx.mediaAsset.findUnique({
        where: { id: artifact.assetId },
        select: { ownerId: true },
      });
      if (!asset || asset.ownerId !== requestOwnerId) {
        throw Errors.conflict(
          "Generation Delivery MediaAsset is not owned by its library target",
          {
            artifactId: artifact.id,
            assetId: artifact.assetId,
            targetId: input.targetId,
          },
        );
      }
    }
  }
  assertArtifactReadyForDelivery(artifact, status);
  const key = {
    artifactId_targetType_targetId: {
      artifactId: input.artifactId,
      targetType: input.targetType,
      targetId: input.targetId,
    },
  } as const;
  if (input.targetType === "user_library") {
    const existingLibraryTarget = await tx.generationDelivery.findFirst({
      where: { artifactId: input.artifactId, targetType: input.targetType },
    });
    if (
      existingLibraryTarget &&
      existingLibraryTarget.targetId !== input.targetId
    ) {
      throw Errors.conflict(
        "Generation Artifact is already projected to another user library",
        { artifactId: input.artifactId, targetId: existingLibraryTarget.targetId },
      );
    }
  }
  const existing = await tx.generationDelivery.findUnique({ where: key });
  if (!existing) {
    const delivery = await tx.generationDelivery.create({
      data: {
        id: deliveryId(input),
        requestId: input.requestId,
        artifactId: input.artifactId,
        targetType: input.targetType,
        targetId: input.targetId,
        status,
        deliveredAt: status === "delivered" ? input.occurredAt : null,
      },
    });
    return { ...delivery, disposition: "created" };
  }
  assertDeliveryIdentity(existing, input);
  if (!isGenerationDeliveryTransitionAllowed(existing.status, status)) {
    throw Errors.conflict("Generation Delivery is already terminal", {
      deliveryId: existing.id,
      status: existing.status,
    });
  }
  if (existing.status === status) {
    return { ...existing, disposition: "duplicate" };
  }
  const updated = await tx.generationDelivery.updateMany({
    where: { id: existing.id, status: existing.status },
    data: {
      status,
      deliveredAt: status === "delivered" ? input.occurredAt : null,
    },
  });
  if (updated.count !== 1) {
    throw Errors.conflict("Generation Delivery changed during transition", {
      deliveryId: existing.id,
    });
  }
  const result = await tx.generationDelivery.findUniqueOrThrow({
    where: { id: existing.id },
  });
  return { ...result, disposition: "updated" };
}

// SPEC: Failed/suppressed business outcomes archive every Artifact of the Attempt.
// INVARIANT: No terminal Delivery is projected without its Artifact transition.
export async function projectAttemptArtifactDisposition(
  tx: Prisma.TransactionClient,
  input: {
    readonly requestId: string;
    readonly attemptId: string;
    readonly targetId: string;
    readonly validationState: GenerationArtifactValidationState;
    readonly deliveryStatus: Extract<GenerationDeliveryStatus, "failed" | "suppressed">;
    readonly occurredAt: Date;
  },
) {
  const attempt = await lockGenerationAttempt(tx, input.attemptId);
  if (attempt.requestId !== input.requestId) {
    throw Errors.conflict("Artifact disposition does not belong to its Request", {
      attemptId: input.attemptId,
      requestId: input.requestId,
    });
  }
  const artifacts = await tx.generationArtifact.findMany({
    where: { attemptId: input.attemptId },
    orderBy: { ordinal: "asc" },
  });
  for (const artifact of artifacts) {
    const existingDelivery = await tx.generationDelivery.findUnique({
      where: {
        artifactId_targetType_targetId: {
          artifactId: artifact.id,
          targetType: "user_library",
          targetId: input.targetId,
        },
      },
    });
    if (
      existingDelivery &&
      existingDelivery.status !== "pending" &&
      existingDelivery.status !== input.deliveryStatus
    ) {
      if (
        artifact.archiveState === "archived" &&
        artifact.validationState !== "produced" &&
        artifact.validationState !== "valid"
      ) {
        // INTENT: competing terminal Request outcomes keep the first durable
        // Artifact/Delivery disposition. A late finalizer may acknowledge and
        // audit the loser, but it cannot rewrite terminal evidence.
        continue;
      }
      throw Errors.conflict(
        "Generation Artifact has a conflicting terminal Delivery",
        {
          artifactId: artifact.id,
          deliveryStatus: existingDelivery.status,
          requestedDeliveryStatus: input.deliveryStatus,
        },
      );
    }
    await transitionGenerationArtifactEvidence(tx, {
      artifactId: artifact.id,
      validationState: input.validationState,
      archiveState: "archived",
    });
    await projectGenerationDelivery(tx, {
      requestId: input.requestId,
      artifactId: artifact.id,
      targetType: "user_library",
      targetId: input.targetId,
      status: input.deliveryStatus,
      occurredAt: input.occurredAt,
    });
  }
  return artifacts.length;
}

// SPEC: Delivery binds final MediaAssets by provider ordinal.
// INTENT: Missing Artifact evidence fails closed; no synthetic legacy Artifact id is invented.
export async function deliverGenerationArtifacts(
  tx: Prisma.TransactionClient,
  input: {
    readonly requestId: string;
    readonly attemptId: string;
    readonly targetId: string;
    readonly assets: readonly { readonly ordinal: number; readonly assetId: string }[];
    readonly occurredAt: Date;
  },
) {
  const attempt = await lockGenerationAttempt(tx, input.attemptId);
  if (attempt.requestId !== input.requestId) {
    throw Errors.conflict("Artifact delivery does not belong to its Request", {
      attemptId: input.attemptId,
      requestId: input.requestId,
    });
  }
  for (const asset of input.assets) {
    const artifact = await tx.generationArtifact.findUnique({
      where: {
        attemptId_ordinal: {
          attemptId: input.attemptId,
          ordinal: asset.ordinal,
        },
      },
    });
    if (!artifact) {
      throw Errors.conflict("Delivered MediaAsset has no provider Artifact evidence", {
        attemptId: input.attemptId,
        ordinal: asset.ordinal,
      });
    }
    await transitionGenerationArtifactEvidence(tx, {
      artifactId: artifact.id,
      validationState: "valid",
      assetId: asset.assetId,
    });
    await projectGenerationDelivery(tx, {
      requestId: input.requestId,
      artifactId: artifact.id,
      targetType: "user_library",
      targetId: input.targetId,
      status: "delivered",
      occurredAt: input.occurredAt,
    });
  }
  return input.assets.length;
}

// SPEC: An operator may adopt a recovered success only through the unknown
// reconciliation command after the terminal record has already been validated.
// INTENT: this is deliberately not part of the general transition matrices:
// late evidence stays archived unless this narrow, fully guarded path binds the
// exact MediaAssets and suppressed Deliveries in one transaction.
export async function adoptRecoveredUnknownArtifacts(
  tx: Prisma.TransactionClient,
  input: {
    readonly requestId: string;
    readonly attemptId: string;
    readonly targetId: string;
    readonly assets: readonly {
      readonly ordinal: number;
      readonly assetId: string;
      readonly providerRef: string | null;
      readonly terminalRecordChecksum: string;
    }[];
    readonly occurredAt: Date;
  },
) {
  const attempt = await lockGenerationAttempt(tx, input.attemptId);
  if (attempt.requestId !== input.requestId || attempt.status !== "unknown") {
    throw Errors.conflict("Recovered success requires the unknown owning Attempt", {
      attemptId: input.attemptId,
      requestId: input.requestId,
      attemptStatus: attempt.status,
    });
  }
  const artifacts = await tx.generationArtifact.findMany({
    where: { attemptId: input.attemptId },
    orderBy: { ordinal: "asc" },
  });
  if (
    artifacts.length !== input.assets.length ||
    input.assets.some((asset, index) => asset.ordinal !== index)
  ) {
    throw Errors.conflict("Recovered success Artifact set is incomplete", {
      attemptId: input.attemptId,
      expected: artifacts.length,
      actual: input.assets.length,
    });
  }
  for (const [index, assetInput] of input.assets.entries()) {
    const artifact = await lockGenerationArtifact(tx, artifacts[index]!.id);
    if (
      artifact.ordinal !== assetInput.ordinal ||
      artifact.providerRef !== assetInput.providerRef ||
      artifact.terminalRecordChecksum !== assetInput.terminalRecordChecksum ||
      artifact.validationState !== "late_after_unknown" ||
      artifact.archiveState !== "archived" ||
      artifact.assetId !== null
    ) {
      throw Errors.conflict("Recovered success Artifact evidence changed", {
        artifactId: artifact.id,
        attemptId: input.attemptId,
      });
    }
    const delivery = await tx.generationDelivery.findUnique({
      where: {
        artifactId_targetType_targetId: {
          artifactId: artifact.id,
          targetType: "user_library",
          targetId: input.targetId,
        },
      },
    });
    if (!delivery || delivery.requestId !== input.requestId || delivery.status !== "suppressed") {
      throw Errors.conflict("Recovered success requires its suppressed Delivery", {
        artifactId: artifact.id,
        deliveryStatus: delivery?.status ?? null,
      });
    }
    await assertMediaAssetBinding(tx, artifact, assetInput.assetId);
    const artifactChanged = await tx.generationArtifact.updateMany({
      where: {
        id: artifact.id,
        validationState: "late_after_unknown",
        archiveState: "archived",
        assetId: null,
      },
      data: {
        validationState: "valid",
        archiveState: "active",
        assetId: assetInput.assetId,
      },
    });
    if (artifactChanged.count !== 1) {
      throw Errors.conflict("Recovered success Artifact changed during adoption", {
        artifactId: artifact.id,
      });
    }
    const deliveryChanged = await tx.generationDelivery.updateMany({
      where: { id: delivery.id, status: "suppressed", deliveredAt: null },
      data: { status: "delivered", deliveredAt: input.occurredAt },
    });
    if (deliveryChanged.count !== 1) {
      throw Errors.conflict("Recovered success Delivery changed during adoption", {
        deliveryId: delivery.id,
      });
    }
  }
  return input.assets.length;
}
