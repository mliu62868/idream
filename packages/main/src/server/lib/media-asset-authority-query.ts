import type { Prisma, PrismaClient } from "@prisma/client";
import { Errors } from "@/server/lib/errors";
import {
  evaluateMediaAssetCustomerPublishability,
  type MediaAssetCustomerPublishabilityReason,
} from "@/server/lib/media-asset-authority";

type Db = PrismaClient | Prisma.TransactionClient;

export type MediaAssetAuthoritySubject = {
  readonly id: string;
  readonly sourceJobId: string | null;
  readonly metadata: unknown;
};

export type ResolvedMediaAssetAuthority = {
  readonly publishable: boolean;
  readonly reasons: readonly MediaAssetCustomerPublishabilityReason[];
};

export async function resolveMediaAssetAuthorityMap(
  db: Db,
  assets: readonly MediaAssetAuthoritySubject[],
): Promise<ReadonlyMap<string, ResolvedMediaAssetAuthority>> {
  const sourceJobIds = [
    ...new Set(
      assets.flatMap((asset) =>
        asset.sourceJobId ? [asset.sourceJobId] : [],
      ),
    ),
  ];
  const jobs = sourceJobIds.length > 0
    ? await db.generationJob.findMany({
        where: { id: { in: sourceJobIds } },
        select: { id: true, provider: true },
      })
    : [];
  const attempts = sourceJobIds.length > 0
    ? await db.generationAttempt.findMany({
        where: {
          requestId: { in: sourceJobIds },
          status: "succeeded",
        },
        orderBy: [{ requestId: "asc" }, { attemptNo: "desc" }],
        select: { requestId: true, provider: true },
      })
    : [];
  const jobProviderById = new Map(
    jobs.map((job) => [job.id, job.provider] as const),
  );
  const latestAttemptProviderByJobId = new Map<string, string | null>();
  for (const attempt of attempts) {
    if (!latestAttemptProviderByJobId.has(attempt.requestId)) {
      latestAttemptProviderByJobId.set(attempt.requestId, attempt.provider);
    }
  }

  return new Map(
    assets.map((asset) => {
      const authority = evaluateMediaAssetCustomerPublishability({
        metadata: asset.metadata,
        jobProvider: asset.sourceJobId
          ? jobProviderById.get(asset.sourceJobId) ?? null
          : null,
        jobProviderRequired: true,
        latestAttemptProvider: asset.sourceJobId
          ? latestAttemptProviderByJobId.get(asset.sourceJobId) ?? null
          : null,
        latestAttemptProviderRequired: true,
      });
      return [asset.id, authority] as const;
    }),
  );
}

export function assertResolvedMediaAssetCustomerPublishable(
  assetId: string,
  authority: ResolvedMediaAssetAuthority,
) {
  if (authority.publishable) return;
  throw Errors.badRequest(
    "This media asset is not customer-publishable",
    {
      code: "media_asset_not_customer_publishable",
      assetId,
      reasons: authority.reasons,
    },
  );
}

export async function assertMediaAssetCustomerPublishable(
  db: Db,
  asset: MediaAssetAuthoritySubject,
) {
  const authority = (
    await resolveMediaAssetAuthorityMap(db, [asset])
  ).get(asset.id);
  if (!authority) {
    throw Errors.internal("Media asset authority could not be resolved");
  }
  assertResolvedMediaAssetCustomerPublishable(asset.id, authority);
  return authority;
}
