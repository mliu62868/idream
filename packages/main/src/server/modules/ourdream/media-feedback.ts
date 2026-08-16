import { prisma } from "@/server/lib/db";
import { Errors } from "@/server/lib/errors";
import { isRecord } from "@/server/lib/request-json";
import { lockMediaAssetAuthority } from "@/server/modules/admin-v2/characters/generation-authority-lock";
import { jsonRecord } from "./json-values";
import { appendGenerationEvent } from "./generation-job-authority";
import type { GenerationVisualProfile } from "./generation-character-authority";
import {
  assertMediaOwner,
  mediaMetadataWithQuality,
} from "./customer-media-authority";

// SPEC: 用户对一张生成图打「像 / 不像本人」的身份反馈。
//
// INTENT: 这条反馈同时是三样东西：一条不可变的 GenerationJobEvent（审计）、一行当前有效的
// GenerationFeedback（可被后续修订取代）、以及一条 ReferenceCandidate（喂给身份参考集）。
// 三者必须同一个事务里写成，否则「用户说像」和「这张图成为候选参考」会漂开。
//
// INVARIANT: 重复提交同一个取值是幂等的 —— 直接回放已存的反馈，不追加事件、不涨 revision。

export async function recordMediaIdentityFeedback(input: {
  readonly userId: string;
  readonly mediaAssetId: string;
  readonly feedbackType: "identity_match" | "identity_mismatch";
  readonly sourceSurface: "chat" | "generator" | "gallery";
}) {
  const { mediaAssetId: id, sourceSurface, userId } = input;
  const asset = await assertMediaOwner(id, userId);
  if (asset.type !== "image") throw Errors.badRequest("Feedback is only supported for image media");
  if (!asset.sourceJobId) throw Errors.badRequest("Generated image feedback requires a source job");
  const job = await prisma.generationJob.findFirst({
    where: { id: asset.sourceJobId, userId },
    select: {
      id: true,
      characterId: true,
      visualProfileId: true,
      visualProfileVersion: true,
    },
  });
  if (!job) throw Errors.notFound("Generation job not found for media feedback");
  const visualProfile = await generationJobVisualProfileForFeedback(job);

  const value = input.feedbackType === "identity_match" ? "match" : "mismatch";
  const quality = jsonRecord(jsonRecord(asset.metadata).quality);
  const current = mediaIdentityFeedback(quality.identityFeedback);
  if (current?.value === value) {
    const referenceCandidate = visualProfile
      ? await prisma.referenceCandidate.findUnique({
          where: {
            visualProfileId_mediaAssetId: {
              visualProfileId: visualProfile.id,
              mediaAssetId: asset.id,
            },
          },
        })
      : null;
    return {
      feedback: current,
      eventId: current.eventId,
      referenceCandidate: referenceCandidate ? referenceCandidateDTO(referenceCandidate) : null,
    };
  }

  const result = await prisma.$transaction(async (tx) => {
    await lockMediaAssetAuthority(tx, asset.id);
    const lockedAsset = await tx.mediaAsset.findFirst({
      where: {
        id: asset.id,
        ownerId: userId,
        type: "image",
        deletedAt: null,
      },
    });
    if (!lockedAsset) {
      throw Errors.conflict("Media asset changed before feedback was recorded");
    }
    const lockedVisualProfile = visualProfile
      ? await tx.characterVisualProfile.findFirst({
          where: {
            id: visualProfile.id,
            characterId: job.characterId!,
            version: job.visualProfileVersion!,
          },
        })
      : null;
    if (visualProfile && !lockedVisualProfile) {
      throw Errors.conflict(
        "Generation job identity authority changed before feedback was recorded",
        {
          generationJobId: job.id,
          visualProfileId: job.visualProfileId,
          visualProfileVersion: job.visualProfileVersion,
        },
      );
    }
    const lockedQuality = jsonRecord(jsonRecord(lockedAsset.metadata).quality);
    const lockedFeedback = mediaIdentityFeedback(
      lockedQuality.identityFeedback,
    );
    const currentFeedbackRow = await tx.generationFeedback.findFirst({
      where: {
        actorId: userId,
        mediaAssetId: asset.id,
        dimension: "identity",
        active: true,
      },
      orderBy: { revision: "desc" },
    });
    if (lockedFeedback?.value === value) {
      const referenceCandidate = lockedVisualProfile
        ? await tx.referenceCandidate.findUnique({
            where: {
              visualProfileId_mediaAssetId: {
                visualProfileId: lockedVisualProfile.id,
                mediaAssetId: lockedAsset.id,
              },
            },
          })
        : null;
      return {
        storedFeedback: lockedFeedback,
        referenceCandidate,
      };
    }
    const revision =
      Math.max(
        currentFeedbackRow?.revision ?? 0,
        lockedFeedback?.revision ?? 0,
      ) + 1;
    const feedback = {
      id: `feedback:${userId}:${asset.id}:identity`,
      dimension: "identity",
      value,
      revision,
      sourceSurface,
    } as const;
    const event = await appendGenerationEvent(tx, job.id, "user_feedback", "User rated character identity", {
      schemaVersion: 1,
      actorId: userId,
      mediaAssetId: asset.id,
      feedbackId: feedback.id,
      feedbackType: input.feedbackType,
      feedbackDimension: feedback.dimension,
      feedbackValue: feedback.value,
      idempotencyKey: feedback.id,
      revision,
      sourceSurface,
      supersedesEventId:
        currentFeedbackRow?.eventId ?? lockedFeedback?.eventId ?? null,
    });
    await tx.generationFeedback.updateMany({
      where: {
        actorId: userId,
        mediaAssetId: asset.id,
        dimension: feedback.dimension,
        active: true,
      },
      data: { active: false },
    });
    await tx.generationFeedback.create({
      data: {
        feedbackKey: feedback.id,
        actorId: userId,
        mediaAssetId: asset.id,
        generationJobId: job.id,
        dimension: feedback.dimension,
        value: feedback.value,
        revision,
        sourceSurface,
        active: true,
        supersedesId: currentFeedbackRow?.id,
        eventId: event.id,
      },
    });
    const storedFeedback = { ...feedback, eventId: event.id };
    await tx.mediaAsset.update({
      where: { id: asset.id },
      data: {
        metadata: mediaMetadataWithQuality(lockedAsset.metadata, {
          identityFeedback: storedFeedback,
        }),
      },
    });
    const referenceCandidate = lockedVisualProfile
      ? await tx.referenceCandidate.upsert({
          where: {
            visualProfileId_mediaAssetId: {
              visualProfileId: lockedVisualProfile.id,
              mediaAssetId: asset.id,
            },
          },
          update: {
            sourceJobId: job.id,
            status: value === "match" ? "candidate" : "rejected",
            rejectionReason: value === "mismatch" ? "user_identity_mismatch" : null,
          },
          create: {
            visualProfileId: lockedVisualProfile.id,
            mediaAssetId: asset.id,
            sourceJobId: job.id,
            proposedRole: "identity_reference",
            source: "user_feedback",
            status: value === "match" ? "candidate" : "rejected",
            rejectionReason: value === "mismatch" ? "user_identity_mismatch" : null,
          },
        })
      : null;
    return { storedFeedback, referenceCandidate };
  });
  return {
    feedback: result.storedFeedback,
    eventId: result.storedFeedback.eventId,
    referenceCandidate: result.referenceCandidate
      ? referenceCandidateDTO(result.referenceCandidate)
      : null,
  };
}

async function generationJobVisualProfileForFeedback(job: {
  readonly id: string;
  readonly characterId: string | null;
  readonly visualProfileId: string | null;
  readonly visualProfileVersion: number | null;
}): Promise<GenerationVisualProfile | null> {
  if (
    job.visualProfileId === null &&
    job.visualProfileVersion === null
  ) {
    return null;
  }
  if (
    !job.characterId ||
    !job.visualProfileId ||
    job.visualProfileVersion === null
  ) {
    throw Errors.conflict(
      "Generation job has incomplete identity authority for feedback",
      { generationJobId: job.id },
    );
  }
  const profile = await prisma.characterVisualProfile.findFirst({
    where: {
      id: job.visualProfileId,
      characterId: job.characterId,
      version: job.visualProfileVersion,
    },
  });
  if (!profile) {
    throw Errors.conflict(
      "Generation job identity authority is unavailable for feedback",
      {
        generationJobId: job.id,
        visualProfileId: job.visualProfileId,
        visualProfileVersion: job.visualProfileVersion,
      },
    );
  }
  return profile;
}

function mediaIdentityFeedback(value: unknown) {
  if (!isRecord(value)) return null;
  const id = typeof value.id === "string" ? value.id : null;
  const dimension = value.dimension === "identity" ? "identity" as const : null;
  const feedbackValue = value.value === "match" || value.value === "mismatch" ? value.value : null;
  const revision = typeof value.revision === "number" && Number.isInteger(value.revision) ? value.revision : null;
  const sourceSurface =
    value.sourceSurface === "chat" || value.sourceSurface === "generator" || value.sourceSurface === "gallery"
      ? value.sourceSurface
      : null;
  const eventId = typeof value.eventId === "string" ? value.eventId : null;
  if (!id || !dimension || !feedbackValue || revision === null || !sourceSurface || !eventId) return null;
  return { id, dimension, value: feedbackValue, revision, sourceSurface, eventId };
}

function referenceCandidateDTO(candidate: {
  id: string;
  visualProfileId: string;
  mediaAssetId: string;
  sourceJobId: string | null;
  proposedRole: string;
  qualityScore: number | null;
  identityScore: number | null;
  source: string;
  status: string;
  rejectionReason: string | null;
  promotedRevisionId: string | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: candidate.id,
    visualProfileId: candidate.visualProfileId,
    mediaAssetId: candidate.mediaAssetId,
    sourceJobId: candidate.sourceJobId,
    proposedRole: candidate.proposedRole,
    qualityScore: candidate.qualityScore,
    identityScore: candidate.identityScore,
    source: candidate.source,
    status: candidate.status,
    rejectionReason: candidate.rejectionReason,
    promotedRevisionId: candidate.promotedRevisionId,
    createdAt: candidate.createdAt,
    updatedAt: candidate.updatedAt,
  };
}
