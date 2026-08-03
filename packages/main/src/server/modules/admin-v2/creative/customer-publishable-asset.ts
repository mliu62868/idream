import type { Prisma } from "@prisma/client";
import { Errors } from "@/server/lib/errors";
import {
  evaluateCreativeMediaAuthority,
  type CreativeMediaProviderSnapshot,
} from "@/server/lib/creative-media-authority";
import { parseSingleContinuousFrameEvidence } from "@idream/shared/media/generated-image-sanity";
import { jsonRecord } from "./json";

// SPEC: 「这张图能不能成为面向客户的 Creative 权威」只有这一个判断入口。
// INTENT: 评审通过与投放上线是两条独立路径，但两者都在把一张素材推向客户可见面；
// 合成图 / mock provider 产出的素材在任一条路径上放行，结果都一样。

export function systemSingleFrameEvidence(metadata: unknown) {
  const quality = jsonRecord(jsonRecord(metadata).quality);
  return parseSingleContinuousFrameEvidence(quality);
}

async function creativeMediaProviderSnapshot(
  tx: Prisma.TransactionClient,
  asset: { readonly sourceJobId: string | null },
): Promise<CreativeMediaProviderSnapshot> {
  if (!asset.sourceJobId) {
    return {
      sourceJobId: null,
      jobProvider: null,
      latestAttemptProvider: null,
    };
  }
  const job = await tx.generationJob.findUnique({
    where: { id: asset.sourceJobId },
    select: { provider: true },
  });
  const latestAttempt = await tx.generationAttempt.findFirst({
    where: {
      requestId: asset.sourceJobId,
      status: "succeeded",
    },
    orderBy: { attemptNo: "desc" },
    select: { provider: true },
  });
  return {
    sourceJobId: asset.sourceJobId,
    jobProvider: job?.provider ?? null,
    latestAttemptProvider: latestAttempt?.provider ?? null,
  };
}

export async function assertCustomerPublishableCreativeAsset(
  tx: Prisma.TransactionClient,
  asset: {
    readonly id: string;
    readonly metadata: unknown;
    readonly sourceJobId: string | null;
  },
  pinned?: CreativeMediaProviderSnapshot,
  options?: {
    readonly requireCompleteProviderAuthority?: boolean;
  },
) {
  const current = await creativeMediaProviderSnapshot(tx, asset);
  const authority = evaluateCreativeMediaAuthority({
    metadata: asset.metadata,
    current,
    pinned,
    requireCompleteProviderAuthority:
      options?.requireCompleteProviderAuthority,
  });
  if (authority.publishable) return authority.snapshot;
  throw Errors.badRequest(
    "Synthetic or mock-provider media cannot become customer-facing Creative authority",
    {
      code: "creative_asset_not_customer_publishable",
      mediaAssetId: asset.id,
      reasons: authority.reasons,
    },
  );
}
