import { z } from "zod";
import type { Prisma, PrismaClient } from "@prisma/client";
import { parseCharacterReleaseAssetManifest } from "@idream/shared/admin";
import { resolveMediaAssetAuthorityMap } from "@/server/lib/media-asset-authority-query";
import { resolveGenerationAssetSuccessAttempts } from "@/server/ai/generation-asset-success-authority";
import { hasHydratableMediaBlobAuthority, isMediaAssetOperationalForAuthority } from "@/server/lib/media-asset-authority";
import { canonicalSha256 } from "../shared/canonical-json";
import { characterVisualProfileSnapshotHash, referenceSetSnapshotHash } from "./release-snapshot";

type Db = PrismaClient | Prisma.TransactionClient;
const id = z.string().min(1);
const version = z.number().int().positive();
const generationSchema = z.object({
  generationJobId: id, jobCharacterId: z.null(), provider: id,
  generationProfileKey: id, generationProfileVersion: version,
  workflowKey: id, workflowVersion: version, attemptId: id, attemptNo: version,
  visualProfileId: z.null(), visualProfileVersion: z.null(), referenceSetRevisionId: z.null(),
  referenceAssetIds: z.array(id).length(0).nullable(), referenceManifestHash: z.null(),
  deliveredOutputCount: version, completedAt: id,
}).strict();
const receiptSchema = z.object({
  schemaVersion: z.literal("customer-selected-preview-v1"),
  characterId: id, creatorId: id, submissionId: id, contentVersionId: id, contentHash: id,
  assetId: id, draftId: id, previewJobId: id, artifactId: id, deliveryId: id,
  visualProfileId: id, visualProfileVersion: version, visualProfileHash: id,
  referenceSetRevisionId: id, referenceSetHash: id,
  generation: generationSchema,
}).strict();
export type CustomerIdentityReceipt = z.infer<typeof receiptSchema>;
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value)
  ? value as Record<string, unknown> : {};

export function customerIdentityReceipt(snapshot: unknown): CustomerIdentityReceipt | null {
  const parsed = receiptSchema.safeParse(record(snapshot).customerIdentity);
  return parsed.success ? parsed.data : null;
}

// Sharing authorizes the exact confirmed identity. A gallery image, a mutable
// portrait pointer, or a metadata marker alone never creates publication authority.
export async function inspectCustomerIdentitySource(db: Db, input: {
  characterId: string;
  submissionId: string;
  contentVersionId: string;
  sealed?: CustomerIdentityReceipt;
  publishedRelease?: { id: string; projectId: string; customerIdentityRevisionId: string };
}) {
  const character = await db.character.findUnique({ where: { id: input.characterId }, include: { creator: { select: { dataClass: true } } } });
  if (!character || character.source !== "user" || character.deletedAt || !character.creatorId ||
    !["public", "unlisted"].includes(character.visibility) ||
    !["customer", "internal"].includes(character.creator?.dataClass ?? "")) return null;
  if (character.status !== "approved") {
    if (character.status !== "archived" || !input.sealed || !input.publishedRelease) return null;
    const { sealed, publishedRelease } = input;
    const serving = await db.characterServing.findUnique({ where: { characterId: character.id }, include: { currentRelease: true } });
    const release = serving?.currentRelease;
    const manifest = parseCharacterReleaseAssetManifest(release?.releasePlacementManifest);
    // Pause projects Character.status to archived. Only the current published
    // Release may resume its exact receipt; this never authorizes a new proposal.
    // Text-only Releases may pin newer content while retaining the same identity.
    if (serving?.state !== "paused" || serving.currentReleaseId !== publishedRelease.id ||
      !release || release.id !== publishedRelease.id || release.projectId !== publishedRelease.projectId ||
      release.status !== "published" || !release.publishedAt || release.visualProfileId !== sealed.visualProfileId ||
      release.visualProfileVersion !== sealed.visualProfileVersion || release.referenceSetRevisionId !== sealed.referenceSetRevisionId ||
      !manifest?.placements.some(placement => placement.customerIdentityRevisionId === publishedRelease.customerIdentityRevisionId &&
        placement.assetId === sealed.assetId && placement.generationJobId === sealed.generation.generationJobId)) return null;
  }
  const submission = await db.characterSubmission.findFirst({ where: {
    id: input.submissionId, characterId: character.id, submitterId: character.creatorId, status: "approved",
  } });
  const content = await db.characterContentVersion.findFirst({ where: { id: input.contentVersionId, characterId: character.id } });
  if (!submission || !content) return null;
  const assetId = input.sealed?.assetId ?? character.imageAssetId;
  if (!assetId) return null;
  const asset = await db.mediaAsset.findUnique({ where: { id: assetId } });
  if (!asset || asset.ownerId !== character.creatorId || asset.characterId !== character.id || asset.type !== "image" ||
    asset.deletedAt || asset.safetyStatus !== "passed" || !asset.sourceJobId ||
    !hasHydratableMediaBlobAuthority(asset) || !isMediaAssetOperationalForAuthority(asset.metadata) ||
    record(record(asset.metadata).platformAsset).status === "archived") return null;
  const job = await db.generationJob.findUnique({ where: { id: asset.sourceJobId } });
  if (!job || job.userId !== character.creatorId || job.sourceType !== "character_preview" || !job.sourceId ||
    job.status !== "completed" || job.mode !== "image" || job.deliveredOutputCount < 1 || !job.completedAt ||
    job.characterId !== null || job.visualProfileId !== null || job.visualProfileVersion !== null || job.referenceSetRevisionId !== null ||
    job.referenceManifest !== null || (job.referenceAssetIds !== null && (!Array.isArray(job.referenceAssetIds) || job.referenceAssetIds.length > 0))) return null;
  const preview = await db.characterPreviewJob.findUnique({ where: { id: job.sourceId }, include: { draft: true } });
  const submittedCharacterId = record(preview?.draft.advancedDetails).submittedCharacterId;
  if (!preview || preview.status !== "completed" || preview.resultAssetId !== asset.id ||
    preview.draft.ownerId !== character.creatorId || preview.draft.previewJobId !== preview.id ||
    record(job.sourceMeta).draftId !== preview.draftId || record(job.sourceMeta).previewJobId !== preview.id ||
    (preview.draft.editsCharacterId !== null && preview.draft.editsCharacterId !== character.id) ||
    !(submittedCharacterId === undefined || submittedCharacterId === null
      ? content.sourceId === preview.draftId
      : submittedCharacterId === character.id)) return null;

  // Use the delivered Artifact's Attempt, never a later successful retry of the
  // same request. Keep these original (pre-Character) null pins immutable.
  const artifacts = await db.generationArtifact.findMany({ where: { assetId: asset.id, validationState: "valid", archiveState: "active" } });
  if (artifacts.length !== 1) return null;
  const artifact = artifacts[0]!;
  const attempt = await db.generationAttempt.findUnique({ where: { id: artifact.attemptId } });
  const delivery = await db.generationDelivery.findFirst({ where: {
    artifactId: artifact.id, requestId: job.id, targetType: "user_library", targetId: character.creatorId,
    status: "delivered", deliveredAt: { not: null },
  } });
  const recoveredAttempt = attempt?.status === "unknown"
    ? (await resolveGenerationAssetSuccessAttempts(db, [asset])).get(asset.id) : null;
  if (!attempt || !(attempt.status === "succeeded" || recoveredAttempt?.id === artifact.attemptId) || attempt.requestId !== job.id || !delivery ||
    attempt.provider !== job.provider || attempt.profileKey !== job.profileId || attempt.profileVersion !== job.profileVersion ||
    attempt.workflowKey !== job.model || !(await resolveMediaAssetAuthorityMap(db, [asset])).get(asset.id)?.publishable) return null;
  const profile = await db.characterVisualProfile.findFirst({ where: {
    characterId: character.id,
    ...(input.sealed ? { id: input.sealed.visualProfileId } : { status: "active" }),
  }, orderBy: { version: "desc" } });
  if (!profile || !profile.immutableHash || profile.immutableHash !== characterVisualProfileSnapshotHash(profile)) return null;
  const referenceSet = await db.referenceSetRevision.findFirst({ where: {
    visualProfileId: profile.id,
    ...(input.sealed ? { id: input.sealed.referenceSetRevisionId } : { status: "active" }),
  }, orderBy: { revision: "desc" }, include: { references: { orderBy: { position: "asc" } } } });
  if (!referenceSet || !referenceSet.snapshotHash || referenceSet.snapshotHash !== referenceSetSnapshotHash(referenceSet) ||
    !referenceSet.references.some(reference => reference.mediaAssetId === asset.id && ["primary_face", "identity_anchor"].includes(reference.role))) return null;
  const parsed = receiptSchema.safeParse({
    schemaVersion: "customer-selected-preview-v1", characterId: character.id, creatorId: character.creatorId,
    submissionId: submission.id, contentVersionId: content.id, contentHash: content.contentHash,
    assetId: asset.id, draftId: preview.draftId, previewJobId: preview.id, artifactId: artifact.id, deliveryId: delivery.id,
    visualProfileId: profile.id, visualProfileVersion: profile.version, visualProfileHash: profile.immutableHash,
    referenceSetRevisionId: referenceSet.id, referenceSetHash: referenceSet.snapshotHash,
    generation: {
      generationJobId: job.id, jobCharacterId: job.characterId, provider: job.provider,
      generationProfileKey: job.profileId, generationProfileVersion: job.profileVersion,
      workflowKey: job.model, workflowVersion: attempt.workflowVersion, attemptId: attempt.id, attemptNo: attempt.attemptNo,
      visualProfileId: job.visualProfileId, visualProfileVersion: job.visualProfileVersion, referenceSetRevisionId: job.referenceSetRevisionId,
      referenceAssetIds: job.referenceAssetIds, referenceManifestHash: null,
      deliveredOutputCount: job.deliveredOutputCount, completedAt: job.completedAt.toISOString(),
    },
  });
  if (!parsed.success || (input.sealed && canonicalSha256(parsed.data) !== canonicalSha256(input.sealed))) return null;
  return { receipt: parsed.data, job, attempt, asset };
}

// A receipt outlives a text-only edit. Selection still uses the current identity;
// validation of a pinned historical Release supplies its own exact identity.
export async function resolveCustomerIdentitySource(db: Db, input: {
  characterId: string;
  revisionId?: string;
  visualProfileId?: string;
  referenceSetRevisionId?: string;
  releaseId?: string;
}) {
  const project = await db.characterProject.findFirst({ where: { characterId: input.characterId }, orderBy: [{ updatedAt: "desc" }, { id: "desc" }] });
  if (!project) return null;
  const revisions = await db.characterRevision.findMany({ where: {
    projectId: project.id, ...(input.revisionId ? { id: input.revisionId } : {}),
  }, orderBy: { revision: "desc" } });
  const profile = input.visualProfileId ? null : await db.characterVisualProfile.findFirst({
    where: { characterId: input.characterId, status: "active" }, orderBy: { version: "desc" },
  });
  const referenceSet = input.referenceSetRevisionId ? null : profile && await db.referenceSetRevision.findFirst({
    where: { visualProfileId: profile.id, status: "active" }, orderBy: { revision: "desc" },
  });
  for (const revision of revisions) {
    const receipt = customerIdentityReceipt(revision.projectSnapshot);
    if (!receipt || receipt.characterId !== input.characterId || receipt.contentVersionId !== revision.characterContentVersionId ||
      receipt.visualProfileId !== (input.visualProfileId ?? profile?.id) ||
      receipt.referenceSetRevisionId !== (input.referenceSetRevisionId ?? referenceSet?.id)) continue;
    const source = await inspectCustomerIdentitySource(db, {
      characterId: input.characterId, submissionId: receipt.submissionId, contentVersionId: receipt.contentVersionId, sealed: receipt,
      publishedRelease: input.releaseId ? { id: input.releaseId, projectId: project.id, customerIdentityRevisionId: revision.id } : undefined,
    });
    if (source) return { ...source, revisionId: revision.id, projectId: project.id };
  }
  return null;
}

export type CustomerIdentitySource = NonNullable<Awaited<ReturnType<typeof resolveCustomerIdentitySource>>>;

export function customerIdentityGenerationMatches(source: CustomerIdentitySource, pinned: Record<string, unknown>) {
  return pinned.customerIdentityRevisionId === source.revisionId &&
    pinned.runId == null && pinned.itemId == null && pinned.reviewDecisionId == null &&
    canonicalSha256(Object.fromEntries(Object.keys(source.receipt.generation).map(key => [key, pinned[key]]))) === canonicalSha256(source.receipt.generation);
}
