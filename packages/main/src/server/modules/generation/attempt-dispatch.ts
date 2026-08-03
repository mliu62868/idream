import type { Prisma } from "@prisma/client";
import {
  generationDispatchRequestId,
  idempotencyKeys,
} from "@idream/shared/contracts";
import {
  assignWorkflowReferenceSlots,
  type WorkflowDescriptor,
} from "@idream/shared/gen-workflow";
import type { ImageGeneratePayload, VideoGeneratePayload } from "@/server/ai/schemas";
import {
  imageReferenceInputsForGenerationJob,
  type ImageReferenceInput,
} from "@/server/ai/reference-images";
import type { EnqueueJobInput } from "@/server/jobs/queue";
import { prisma } from "@/server/lib/db";
import { Errors } from "@/server/lib/errors";
import { generationWorkflowDescriptor } from "@/server/modules/generation/generation-catalog";
import { normalizedGenerationReferenceRole } from "@/server/modules/admin-v2/characters/generation-route-authority";
import { lockCharacterGenerationAuthority } from "@/server/modules/admin-v2/characters/generation-authority-lock";
import {
  PUBLIC_CATALOG_EDITORIAL_IMPORT_POLICY_VERSION,
  PUBLIC_CATALOG_QUALIFICATION_SCHEMA_VERSION,
} from "@/server/modules/ourdream/public-catalog-qualification";
import { publicCharacterAudienceWhere } from "@/server/modules/ourdream/public-content-audience";

export const LEGACY_CHARACTER_GENERATION_AUTHORITY_SCHEMA_VERSION =
  "legacy-character-generation-authority-v1";

// SPEC: A video transport gets two recovery attempts after the initial run.
// GenerationExecution resumes a persisted terminal record before any adapter
// or provider code, while its invocation guard prevents non-replayable calls.
export const VIDEO_GENERATION_TRANSPORT_MAX_ATTEMPTS = 3;

const EDITORIAL_RELEASE_PROVENANCE_SCHEMA_VERSION =
  "character-release-editorial-import-v1";

export type LegacyCharacterGenerationAuthority = {
  readonly schemaVersion: typeof LEGACY_CHARACTER_GENERATION_AUTHORITY_SCHEMA_VERSION;
  readonly characterId: string;
  readonly releaseId: string;
  readonly releaseSnapshotHash: string;
  readonly releaseProvenanceSchemaVersion: typeof EDITORIAL_RELEASE_PROVENANCE_SCHEMA_VERSION;
  readonly qualificationId: string;
  readonly qualificationKind: "editorial_import";
  readonly qualificationEvidenceSchemaVersion: typeof PUBLIC_CATALOG_QUALIFICATION_SCHEMA_VERSION;
  readonly qualificationPolicyVersion: typeof PUBLIC_CATALOG_EDITORIAL_IMPORT_POLICY_VERSION;
};

export type ExistingGenerationJob = {
  id: string;
  userId: string;
  characterId: string | null;
  visualProfileId?: string | null;
  visualProfileVersion?: number | null;
  mode: string;
  prompt: string | null;
  negativePrompt: string | null;
  controls: Prisma.JsonValue;
  presetIds: Prisma.JsonValue;
  model: string | null;
  profileId?: string | null;
  profileVersion?: number | null;
  provider?: string | null;
  orientation: string | null;
  outputCount: number;
  seed?: string | null;
  sourceType?: string | null;
  referenceAssetIds?: Prisma.JsonValue | null;
  referenceSetRevisionId?: string | null;
  referenceManifest?: Prisma.JsonValue | null;
};

export type ReservedGenerationAttempt = {
  readonly id: string;
  readonly requestId: string;
  readonly attemptNo: number;
  readonly provider: string;
  readonly profileKey: string | null;
  readonly profileVersion: number | null;
  readonly workflowKey: string | null;
  readonly workflowVersion: number | null;
};

export function legacyCharacterGenerationAuthorityFromControls(
  controls: unknown,
): LegacyCharacterGenerationAuthority | null {
  const authority = jsonRecord(
    jsonRecord(controls).legacyReleaseAuthority,
  );
  const characterId = stringFromRecord(authority, "characterId");
  const releaseId = stringFromRecord(authority, "releaseId");
  const releaseSnapshotHash = stringFromRecord(
    authority,
    "releaseSnapshotHash",
  );
  const qualificationId = stringFromRecord(authority, "qualificationId");
  if (
    authority.schemaVersion !==
      LEGACY_CHARACTER_GENERATION_AUTHORITY_SCHEMA_VERSION ||
    !characterId ||
    !releaseId ||
    !releaseSnapshotHash ||
    authority.releaseProvenanceSchemaVersion !==
      EDITORIAL_RELEASE_PROVENANCE_SCHEMA_VERSION ||
    !qualificationId ||
    authority.qualificationKind !== "editorial_import" ||
    authority.qualificationEvidenceSchemaVersion !==
      PUBLIC_CATALOG_QUALIFICATION_SCHEMA_VERSION ||
    authority.qualificationPolicyVersion !==
      PUBLIC_CATALOG_EDITORIAL_IMPORT_POLICY_VERSION
  ) {
    return null;
  }
  return {
    schemaVersion: LEGACY_CHARACTER_GENERATION_AUTHORITY_SCHEMA_VERSION,
    characterId,
    releaseId,
    releaseSnapshotHash,
    releaseProvenanceSchemaVersion:
      EDITORIAL_RELEASE_PROVENANCE_SCHEMA_VERSION,
    qualificationId,
    qualificationKind: "editorial_import",
    qualificationEvidenceSchemaVersion:
      PUBLIC_CATALOG_QUALIFICATION_SCHEMA_VERSION,
    qualificationPolicyVersion:
      PUBLIC_CATALOG_EDITORIAL_IMPORT_POLICY_VERSION,
  };
}

export async function loadLockedLiveEditorialLegacyGenerationAuthority(
  tx: Prisma.TransactionClient,
  characterId: string,
): Promise<LegacyCharacterGenerationAuthority | null> {
  await lockCharacterGenerationAuthority(tx, characterId);
  const serving = await tx.characterServing.findUnique({
    where: { characterId },
    select: {
      state: true,
      currentRelease: {
        select: {
          id: true,
          snapshotHash: true,
          legacy: true,
          status: true,
          readiness: true,
          publishedAt: true,
          visualProfileId: true,
          visualProfileVersion: true,
          referenceSetRevisionId: true,
          generationProvenance: true,
          publicCatalogQualification: {
            select: {
              id: true,
              releaseSnapshotHash: true,
              kind: true,
              validationRunId: true,
              evidence: true,
              revokedAt: true,
            },
          },
        },
      },
    },
  });
  const release = serving?.currentRelease ?? null;
  const qualification = release?.publicCatalogQualification ?? null;
  const provenance = jsonRecord(release?.generationProvenance);
  const qualificationEvidence = jsonRecord(qualification?.evidence);
  if (
    serving?.state !== "live" ||
    !release ||
    release.legacy !== true ||
    release.status !== "published" ||
    release.readiness !== "ready" ||
    release.publishedAt === null ||
    release.visualProfileId !== null ||
    release.visualProfileVersion !== null ||
    release.referenceSetRevisionId !== null ||
    provenance.schemaVersion !==
      EDITORIAL_RELEASE_PROVENANCE_SCHEMA_VERSION ||
    !qualification ||
    qualification.kind !== "editorial_import" ||
    qualification.validationRunId !== null ||
    qualification.revokedAt !== null ||
    qualification.releaseSnapshotHash !== release.snapshotHash ||
    qualificationEvidence.schemaVersion !==
      PUBLIC_CATALOG_QUALIFICATION_SCHEMA_VERSION ||
    qualificationEvidence.policyVersion !==
      PUBLIC_CATALOG_EDITORIAL_IMPORT_POLICY_VERSION
  ) {
    return null;
  }
  return {
    schemaVersion: LEGACY_CHARACTER_GENERATION_AUTHORITY_SCHEMA_VERSION,
    characterId,
    releaseId: release.id,
    releaseSnapshotHash: release.snapshotHash,
    releaseProvenanceSchemaVersion:
      EDITORIAL_RELEASE_PROVENANCE_SCHEMA_VERSION,
    qualificationId: qualification.id,
    qualificationKind: "editorial_import",
    qualificationEvidenceSchemaVersion:
      PUBLIC_CATALOG_QUALIFICATION_SCHEMA_VERSION,
    qualificationPolicyVersion:
      PUBLIC_CATALOG_EDITORIAL_IMPORT_POLICY_VERSION,
  };
}

export async function assertPinnedLegacyCharacterGenerationAuthority(
  tx: Prisma.TransactionClient,
  input: {
    readonly generationJobId: string;
    readonly characterId: string;
    readonly controls: unknown;
  },
) {
  const pinned = legacyCharacterGenerationAuthorityFromControls(
    input.controls,
  );
  const current =
    await loadLockedLiveEditorialLegacyGenerationAuthority(
      tx,
      input.characterId,
    );
  if (
    !pinned ||
    !current ||
    pinned.characterId !== input.characterId ||
    !legacyCharacterGenerationAuthoritiesEqual(pinned, current)
  ) {
    throw Errors.conflict(
      "Pinned legacy Character Release authority no longer matches live serving authority",
      {
        generationJobId: input.generationJobId,
        characterId: input.characterId,
        pinnedReleaseId: pinned?.releaseId ?? null,
        pinnedReleaseSnapshotHash: pinned?.releaseSnapshotHash ?? null,
        currentReleaseId: current?.releaseId ?? null,
        currentReleaseSnapshotHash:
          current?.releaseSnapshotHash ?? null,
      },
    );
  }
  return current;
}

export function unavailablePinnedManifestReferenceRoles(input: {
  readonly referenceManifest: unknown;
  readonly referenceImages: readonly Pick<ImageReferenceInput, "assetId" | "role">[];
}) {
  const manifestReferenceRoles = referenceManifestEntries(
    input.referenceManifest,
  ).flatMap((entry) => {
    const assetId = stringFromRecord(entry, "mediaAssetId");
    const rawRole = stringFromRecord(entry, "role");
    if (!assetId || !rawRole) return [];
    return [{
      assetId,
      rawRole,
      normalizedRole: normalizedGenerationReferenceRole(rawRole),
    }];
  });
  const dispatchedReferenceRoleKeys = new Set(input.referenceImages.map(
    (image) => referenceRoleKey(image.assetId, image.role),
  ));
  return manifestReferenceRoles
    .filter((reference) =>
      reference.normalizedRole === null ||
      !dispatchedReferenceRoleKeys.has(
        referenceRoleKey(reference.assetId, reference.normalizedRole),
      )
    )
    .map((reference) => ({
      assetId: reference.assetId,
      role: reference.rawRole,
    }));
}

export function generationDispatchModelKey(input: {
  readonly mode: string;
  readonly workflowKey: string | null;
  readonly model: string | null;
  readonly profileId?: string | null;
}) {
  return input.workflowKey
    ?? input.model
    ?? input.profileId
    ?? (input.mode === "video"
      ? "unresolved-video-model"
      : "unresolved-image-model");
}

// INVARIANT: generated bytes belong to one immutable Attempt. Request-level
// prefixes let a later Attempt reuse image bytes or overwrite video bytes while
// an older terminal record still points at the same key.
export function generationAttemptOutputPrefix(
  generationJobId: string,
  attemptId: string,
) {
  return `gen/${generationJobId}/attempts/${attemptId}/`;
}

export async function buildGenerationAttemptQueueInput(
  job: ExistingGenerationJob,
  attempt: ReservedGenerationAttempt,
  input: {
    readonly dedupeKey?: string;
    readonly db?: Prisma.TransactionClient;
  } = {},
): Promise<EnqueueJobInput> {
  if (attempt.requestId !== job.id) {
    throw Errors.conflict(
      "Generation Attempt does not belong to the requested generation authority",
    );
  }
  if (!input.db) {
    return prisma.$transaction((tx) =>
      buildGenerationAttemptQueueInput(job, attempt, { ...input, db: tx })
    );
  }
  await assertGenerationCharacterDispatchable(input.db, job);
  const runtime = await existingGenerationRuntime(input.db, job, attempt);
  const controls = runtime.controls;
  const modelCapabilities = modelCapabilitiesFromControls(controls);
  const requestedSourceImageAssetId = stringFromRecord(
    controls,
    "sourceImageAssetId",
  );
  const requestedLookReferenceAssetId = stringFromRecord(
    controls,
    "lookReferenceAssetId",
  );
  const resolvedReferenceImages =
    job.mode === "image" || job.mode === "video"
      ? await imageReferenceInputsForGenerationJob({
          userId: job.userId,
          characterId: job.characterId,
          controls,
          referenceAssetIds: job.referenceAssetIds,
          referenceManifest: job.referenceManifest,
          maxReferences: Number.MAX_SAFE_INTEGER,
          db: input.db,
        })
      : [];
  const manifestEntries = referenceManifestEntries(job.referenceManifest);
  const manifestSourceImageAssetIds = [
    ...new Set(manifestEntries.flatMap((entry) =>
      entry.role === "source_image" &&
      typeof entry.mediaAssetId === "string"
        ? [entry.mediaAssetId]
        : []
    )),
  ];
  const unresolvedManifestSourceImageAssetIds =
    manifestSourceImageAssetIds.filter((assetId) =>
      !resolvedReferenceImages.some(
        (image) => image.assetId === assetId && image.role === "source_image",
      )
    );
  if (
    (job.mode === "image" || job.mode === "video") &&
    unresolvedManifestSourceImageAssetIds.length > 0
  ) {
    throw Errors.conflict(
      "Generation dispatch could not resolve every source_image pinned by the reference manifest",
      {
        generationJobId: job.id,
        referenceSetRevisionId: job.referenceSetRevisionId,
        unavailableSourceImageAssetIds: unresolvedManifestSourceImageAssetIds,
      },
    );
  }
  const pinnedReferenceAssetIds = [
    ...new Set([
      ...jsonStringArray(job.referenceAssetIds),
      ...referenceManifestAssetIds(job.referenceManifest),
    ]),
  ];
  const dispatchedReferenceAssetIds = new Set(
    resolvedReferenceImages.map((image) => image.assetId),
  );
  const unavailablePinnedReferenceAssetIds = pinnedReferenceAssetIds.filter(
    (assetId) => !dispatchedReferenceAssetIds.has(assetId),
  );
  if (
    (job.mode === "image" || job.mode === "video") &&
    job.referenceSetRevisionId &&
    (
      pinnedReferenceAssetIds.length === 0 ||
      unavailablePinnedReferenceAssetIds.length > 0
    )
  ) {
    throw Errors.conflict(
      "Generation dispatch could not resolve the complete pinned Character reference authority",
      {
        generationJobId: job.id,
        referenceSetRevisionId: job.referenceSetRevisionId,
        unavailableReferenceAssetIds: unavailablePinnedReferenceAssetIds,
      },
    );
  }
  const unavailableManifestReferenceRoles =
    unavailablePinnedManifestReferenceRoles({
      referenceManifest: job.referenceManifest,
      referenceImages: resolvedReferenceImages,
    });
  if (
    (job.mode === "image" || job.mode === "video") &&
    unavailableManifestReferenceRoles.length > 0
  ) {
    throw Errors.conflict(
      "Generation dispatch could not preserve every asset-role tuple pinned by the reference manifest",
      {
        generationJobId: job.id,
        referenceSetRevisionId: job.referenceSetRevisionId,
        unavailableManifestReferenceRoles,
      },
    );
  }
  if (
    (job.mode === "image" || job.mode === "video") &&
    requestedSourceImageAssetId &&
    !resolvedReferenceImages.some(
      (image) =>
        image.assetId === requestedSourceImageAssetId &&
        image.role === "source_image",
    )
  ) {
    throw Errors.conflict(
      "Generation dispatch could not resolve the pinned source image authority",
      {
        generationJobId: job.id,
        sourceImageAssetId: requestedSourceImageAssetId,
      },
    );
  }
  if (
    (job.mode === "image" || job.mode === "video") &&
    requestedLookReferenceAssetId &&
    !resolvedReferenceImages.some(
      (image) =>
        image.assetId === requestedLookReferenceAssetId &&
        image.role === "look_reference",
    )
  ) {
    throw Errors.conflict(
      "Generation dispatch could not resolve the pinned Character Look image authority",
      {
        generationJobId: job.id,
        lookReferenceAssetId: requestedLookReferenceAssetId,
      },
    );
  }
  const referenceImages =
    job.mode === "image" || job.mode === "video"
      ? runtimeReferenceImagesForDispatch({
          generationJobId: job.id,
          images: resolvedReferenceImages,
          capabilities: modelCapabilities,
          workflow: runtime.workflow,
          workflowKey: runtime.workflowKey,
          storedWorkflowKey: runtime.storedWorkflowKey,
          storedWorkflowVersion: runtime.storedWorkflowVersion,
        })
      : [];
  const common = {
    version: 1 as const,
    requestId: generationDispatchRequestId(attempt.id),
    generationJobId: job.id,
    attemptId: attempt.id,
    attemptNo: attempt.attemptNo,
    provider: attempt.provider,
    userId: job.userId,
    characterId: job.characterId,
    prompt: job.prompt ?? `${job.mode === "video" ? "Video" : "Image"} generation ${job.id}`,
    negativePrompt: job.negativePrompt,
    controls,
    seed: job.seed ?? job.id,
    model: generationDispatchModelKey({
      mode: job.mode,
      workflowKey: runtime.workflowKey,
      model: job.model,
      profileId: job.profileId,
    }),
    outputPrefix: generationAttemptOutputPrefix(job.id, attempt.id),
  };
  const payload: ImageGeneratePayload | VideoGeneratePayload =
    job.mode === "video"
      ? {
          ...common,
          kind: "video",
          seconds: numericControl(controls, "seconds", 4),
          ...(referenceImages.length > 0 ? { referenceImages } : {}),
        }
      : {
          ...common,
          kind: "image",
          presetIds: jsonStringArray(job.presetIds),
          orientation: job.orientation ?? stringControl(controls, "orientation", "portrait"),
          count: job.outputCount,
          ...(referenceImages.length > 0 ? { referenceImages } : {}),
        };
  return {
    queue: job.mode === "video" ? "ai.video.generate" : "ai.image.generate",
    payload: payload as unknown as Prisma.InputJsonValue,
    dedupeKey:
      input.dedupeKey ??
        idempotencyKeys.generationAttempt(job.id, attempt.attemptNo),
    // INTENT: later video transport attempts recover only persisted terminal
    // relay admission. A non-replayable provider outcome without terminal
    // persistence is projected unknown instead of entering this retry path.
    maxAttempts:
      job.mode === "video" ? VIDEO_GENERATION_TRANSPORT_MAX_ATTEMPTS : 3,
  };
}

async function existingGenerationRuntime(
  db: Prisma.TransactionClient,
  job: Pick<ExistingGenerationJob, "controls" | "profileId" | "profileVersion">,
  attempt: {
    profileKey: string | null;
    profileVersion: number | null;
    workflowKey: string | null;
    workflowVersion: number | null;
  },
) {
  const storedControls = jsonRecord(job.controls);
  const storedWorkflowKey =
    attempt.workflowKey ?? stringFromRecord(storedControls, "workflowKey");
  const storedWorkflowVersion =
    attempt.workflowVersion ??
    (nonnegativeIntegerFromRecord(storedControls, "workflowVersion") ||
      undefined);
  if (!job.profileId || !job.profileVersion) {
    return {
      controls: storedControls,
      workflow: null,
      workflowKey: null,
      storedWorkflowKey,
      storedWorkflowVersion,
    };
  }
  const profile = await db.generationModelProfile.findFirst({
    where: {
      version: job.profileVersion,
      OR: [{ profileKey: job.profileId }, { id: job.profileId }],
    },
  });
  if (!profile) {
    return {
      controls: storedControls,
      workflow: null,
      workflowKey: null,
      storedWorkflowKey,
      storedWorkflowVersion,
    };
  }
  if (
    (attempt.profileKey && attempt.profileKey !== profile.profileKey) ||
    (
      attempt.profileVersion !== null &&
      attempt.profileVersion !== profile.version
    )
  ) {
    throw Errors.conflict(
      "Generation Attempt profile pin does not match the Generation Job",
      {
        generationJobProfileKey: profile.profileKey,
        generationJobProfileVersion: profile.version,
        attemptProfileKey: attempt.profileKey,
        attemptProfileVersion: attempt.profileVersion,
      },
    );
  }
  const workflowKey = profile.workflowKey ?? profile.pipelineModel;
  const workflow = await generationWorkflowDescriptor(workflowKey);
  const controls = pruneUndefined({
    ...storedControls,
    generationProfileKey: profile.profileKey,
    generationProfileVersion: profile.version,
    workflowKey,
    // INVARIANT: dispatched controls carry the Attempt's immutable workflow
    // pin, not a freshly resolved descriptor version. Reading the live
    // descriptor here forked from the pin two ways: a bumped descriptor
    // version overwrote an older pinned Request, and a missing descriptor
    // dropped the field entirely while the pin still carried the profile's
    // runnerConfig fallback. Both made dispatch authority reject its own
    // envelope.
    workflowVersion: attempt.workflowVersion ?? workflow?.version,
    workflowIdentity: workflow?.identity,
    modelCapabilities: normalizedModelCapabilities(profile.runnerConfig, profile.runner === "sd_cpp"),
    sdcpp: profile.runner === "sd_cpp" ? sdcppProfileRuntimeConfig(profile) : undefined,
  });
  return {
    controls,
    workflow,
    workflowKey,
    storedWorkflowKey,
    storedWorkflowVersion,
  };
}

export function normalizedModelCapabilities(
  runnerConfig: Prisma.JsonValue | null,
  sdCppDefault: boolean,
) {
  const config = jsonRecord(runnerConfig);
  const capabilities = jsonRecord(config.capabilities);
  return {
    textToImage: booleanFromRecord(capabilities, "textToImage", true),
    stableSeed: booleanFromRecord(capabilities, "stableSeed", true),
    referenceImages: booleanFromRecord(capabilities, "referenceImages", false),
    initImage: booleanFromRecord(capabilities, "initImage", sdCppDefault),
    lora: booleanFromRecord(capabilities, "lora", false),
  };
}

function modelCapabilitiesFromControls(controls: Record<string, unknown>) {
  const capabilities = jsonRecord(controls.modelCapabilities);
  return {
    referenceImages: booleanFromRecord(capabilities, "referenceImages", false),
    initImage: booleanFromRecord(capabilities, "initImage", false),
  };
}

export function runtimeReferenceImagesForDispatch(input: {
  generationJobId: string;
  images: readonly ImageReferenceInput[];
  capabilities: ReturnType<typeof modelCapabilitiesFromControls>;
  workflow: WorkflowDescriptor | null;
  workflowKey: string | null;
  storedWorkflowKey?: string;
  storedWorkflowVersion?: number;
}) {
  const sourceCount = input.images.filter(
    (image) => image.role === "source_image",
  ).length;
  const lookCount = input.images.filter(
    (image) => image.role === "look_reference",
  ).length;
  const identityCount = input.images.length - sourceCount;
  if (
    (sourceCount > 0 && !input.capabilities.initImage) ||
    (identityCount > 0 && !input.capabilities.referenceImages)
  ) {
    throw Errors.conflict(
      "Generation dispatch profile cannot consume every pinned image reference",
      {
        generationJobId: input.generationJobId,
        sourceReferenceCount: sourceCount,
        identityReferenceCount: identityCount,
      },
    );
  }
  if (!input.workflow) {
    if (input.images.length === 0) return [];
    throw Errors.conflict(
      "Generation dispatch requires a concrete workflow descriptor for image references",
      {
        generationJobId: input.generationJobId,
        workflowKey: input.workflowKey,
      },
    );
  }
  if (
    input.storedWorkflowKey &&
    input.storedWorkflowKey !== input.workflow.workflowKey
  ) {
    throw Errors.conflict(
      "Generation dispatch workflow no longer matches the pinned job workflow",
      {
        generationJobId: input.generationJobId,
        pinnedWorkflowKey: input.storedWorkflowKey,
        effectiveWorkflowKey: input.workflow.workflowKey,
      },
    );
  }
  if (
    input.storedWorkflowVersion !== undefined &&
    input.storedWorkflowVersion !== input.workflow.version
  ) {
    throw Errors.conflict(
      "Generation dispatch workflow version drifted after the job was created",
      {
        generationJobId: input.generationJobId,
        pinnedWorkflowVersion: input.storedWorkflowVersion,
        effectiveWorkflowVersion: input.workflow.version,
      },
    );
  }
  if (
    lookCount > 0 &&
    !input.workflow?.identity.supportsLookReference
  ) {
    throw Errors.conflict(
      "Generation workflow cannot consume the pinned Character Look image reference",
      {
        generationJobId: input.generationJobId,
        workflowKey: input.workflowKey,
      },
    );
  }
  if (
    sourceCount > 0 &&
    identityCount > 0 &&
    !input.workflow.identity.supportsSourceImageWithIdentity
  ) {
    throw Errors.conflict(
      "Generation workflow cannot combine source and identity image references",
      {
        generationJobId: input.generationJobId,
        workflowKey: input.workflow.workflowKey,
        workflowVersion: input.workflow.version,
      },
    );
  }
  const slotAuthority = assignWorkflowReferenceSlots(
    input.workflow,
    input.images.map((image) => image.role),
  );
  if (!slotAuthority.ok) {
    throw Errors.conflict(
      "Generation workflow cannot assign every pinned image reference to a semantic slot",
      {
        generationJobId: input.generationJobId,
        workflowKey: input.workflow.workflowKey,
        workflowVersion: input.workflow.version,
        referenceRoles: input.images.map((image) => image.role),
        slotAuthority,
      },
    );
  }
  return [...input.images];
}

async function assertGenerationCharacterDispatchable(
  tx: Prisma.TransactionClient,
  job: Pick<
    ExistingGenerationJob,
    | "id"
    | "userId"
    | "characterId"
    | "controls"
    | "mode"
    | "sourceType"
    | "visualProfileId"
  >,
) {
  if (!job.characterId) return;
  await lockCharacterGenerationAuthority(tx, job.characterId);
  const contentProduction = job.sourceType === "content_production_item";
  const character = await tx.character.findFirst({
    where: contentProduction
      ? {
          id: job.characterId,
          deletedAt: null,
          status: { notIn: ["archived", "removed"] },
        }
      : job.mode === "video"
      ? {
          AND: [
            {
              id: job.characterId,
              deletedAt: null,
              age: { gte: 18 },
              status: "approved",
            },
            publicCharacterAudienceWhere,
          ],
        }
      : {
        AND: [
          {
            id: job.characterId,
            deletedAt: null,
            age: { gte: 18 },
            status: "approved",
          },
          {
            OR: [
              { creatorId: job.userId },
              publicCharacterAudienceWhere,
            ],
          },
        ],
      },
    select: { id: true, imageAssetId: true },
  });
  if (!character) {
    throw Errors.conflict(
      "Generation dispatch rejected a Character that is no longer active for its owner",
      {
        generationJobId: job.id,
        characterId: job.characterId,
      },
    );
  }
  const pinnedSourceImageAssetId = stringFromRecord(
    jsonRecord(job.controls),
    "sourceImageAssetId",
  );
  if (
    job.mode === "video" &&
    !contentProduction &&
    (
      !pinnedSourceImageAssetId ||
      character.imageAssetId !== pinnedSourceImageAssetId
    )
  ) {
    throw Errors.conflict(
      "Generation dispatch rejected a video whose published primary image changed",
      {
        generationJobId: job.id,
        characterId: job.characterId,
        pinnedSourceImageAssetId: pinnedSourceImageAssetId ?? null,
        currentSourceImageAssetId: character.imageAssetId,
      },
    );
  }
  // SPEC: Admin 角色视频可固定任意一张仍可用的角色图片；引用解析随后会重新校验
  // 归属、可读取性和 source_image 角色。只有用户侧视频必须继续绑定当前公开主图。
  if (
    job.mode === "image" &&
    job.visualProfileId == null &&
    (
      job.sourceType !== "content_production_item" ||
      legacyCharacterGenerationAuthorityFromControls(job.controls) !== null
    )
  ) {
    await assertPinnedLegacyCharacterGenerationAuthority(tx, {
      generationJobId: job.id,
      characterId: job.characterId,
      controls: job.controls,
    });
  }
}

function legacyCharacterGenerationAuthoritiesEqual(
  left: LegacyCharacterGenerationAuthority,
  right: LegacyCharacterGenerationAuthority,
) {
  return (
    left.schemaVersion === right.schemaVersion &&
    left.characterId === right.characterId &&
    left.releaseId === right.releaseId &&
    left.releaseSnapshotHash === right.releaseSnapshotHash &&
    left.releaseProvenanceSchemaVersion ===
      right.releaseProvenanceSchemaVersion &&
    left.qualificationId === right.qualificationId &&
    left.qualificationKind === right.qualificationKind &&
    left.qualificationEvidenceSchemaVersion ===
      right.qualificationEvidenceSchemaVersion &&
    left.qualificationPolicyVersion === right.qualificationPolicyVersion
  );
}

function sdcppProfileRuntimeConfig(profile: {
  profileKey: string;
  version: number;
  pipelineModel: string;
  sourceModelPath: string | null;
  convertedModelPath: string | null;
  modelFormat: string;
  runnerConfig: Prisma.JsonValue | null;
  steps: number;
  sampler: string;
  scheduler: string;
  cfgScale: number;
  defaultWidth: number;
  defaultHeight: number;
}) {
  const config = jsonRecord(profile.runnerConfig);
  const conversion = jsonRecord(config.conversion);
  return pruneUndefined({
    profileKey: profile.profileKey,
    profileVersion: profile.version,
    apiModelId: profile.pipelineModel,
    modelFormat: profile.modelFormat,
    sourceModelPath: profile.sourceModelPath,
    convertedModelPath: profile.convertedModelPath,
    modelPath: stringFromRecord(config, "modelPath"),
    diffusionModelPath: stringFromRecord(config, "diffusionModelPath"),
    llmPath: stringFromRecord(config, "llmPath"),
    vaePath: stringFromRecord(config, "vaePath"),
    llmVisionPath: stringFromRecord(config, "llmVisionPath"),
    clipLPath: stringFromRecord(config, "clipLPath"),
    clipGPath: stringFromRecord(config, "clipGPath"),
    t5xxlPath: stringFromRecord(config, "t5xxlPath"),
    backend: stringFromRecord(config, "backend"),
    loraModelDir: stringFromRecord(config, "loraModelDir"),
    loraApplyMode: stringFromRecord(config, "loraApplyMode"),
    loras: normalizeSdcppLoras(config.loras),
    conversion: conversion.enabled === true
      ? pruneUndefined({
          enabled: true,
          targetFormat: "gguf",
          outputPath: stringFromRecord(conversion, "outputPath") ?? profile.convertedModelPath,
          type: stringFromRecord(conversion, "type") ?? "q8_0",
          sourceArg: stringFromRecord(conversion, "sourceArg") ?? "model",
          convertName: conversion.convertName === true,
          tensorTypeRules: stringFromRecord(conversion, "tensorTypeRules"),
        })
      : undefined,
    steps: profile.steps,
    sampler: profile.sampler,
    scheduler: profile.scheduler,
    cfgScale: profile.cfgScale,
    defaultWidth: profile.defaultWidth,
    defaultHeight: profile.defaultHeight,
  });
}

function normalizeSdcppLoras(value: unknown) {
  if (!Array.isArray(value)) return undefined;
  const loras = value
    .filter(isRecord)
    .map((item) => pruneUndefined({
      key: stringFromRecord(item, "key"),
      path: stringFromRecord(item, "path"),
      weight: typeof item.weight === "number" && Number.isFinite(item.weight) ? item.weight : 1,
      enabled: item.enabled !== false,
    }))
    .filter((item) => typeof item.key === "string" || typeof item.path === "string");
  return loras.length ? loras : undefined;
}

function jsonRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringFromRecord(value: Record<string, unknown>, key: string) {
  const child = value[key];
  return typeof child === "string" && child.trim() ? child.trim() : undefined;
}

function booleanFromRecord(value: Record<string, unknown>, key: string, fallback: boolean) {
  const child = value[key];
  return typeof child === "boolean" ? child : fallback;
}

function pruneUndefined(value: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(value).filter(([, child]) => child !== undefined));
}

function stringControl(controls: Record<string, unknown>, key: string, fallback: string) {
  const value = controls[key];
  return typeof value === "string" && value.trim() ? value : fallback;
}

function numericControl(controls: Record<string, unknown>, key: string, fallback: number) {
  const value = controls[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function jsonStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function referenceManifestAssetIds(value: unknown): string[] {
  return referenceManifestEntries(value).flatMap((item) => {
    const mediaAssetId = stringFromRecord(item, "mediaAssetId");
    return mediaAssetId ? [mediaAssetId] : [];
  });
}

function referenceManifestEntries(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(jsonRecord) : [];
}

function nonnegativeIntegerFromRecord(
  value: Record<string, unknown>,
  key: string,
) {
  const child = value[key];
  return typeof child === "number" &&
    Number.isSafeInteger(child) &&
    child >= 0
    ? child
    : 0;
}

function referenceRoleKey(assetId: string, role: string) {
  return `${assetId}\u0000${role}`;
}
