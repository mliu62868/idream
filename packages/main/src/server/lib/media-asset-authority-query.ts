import { resolveGenerationAssetSuccessAttempts } from "@/server/ai/generation-asset-success-authority";
import type { Prisma, PrismaClient } from "@prisma/client";
import { Errors } from "@/server/lib/errors";
import {
  evaluateMediaAssetCustomerPublishability,
  inspectOperatorUploadAuthority,
  type MediaAssetCustomerPublishabilityReason,
} from "@/server/lib/media-asset-authority";

type Db = PrismaClient | Prisma.TransactionClient;

export type MediaAssetAuthoritySubject = {
  readonly id: string;
  readonly sourceJobId: string | null;
  readonly storageKey?: string | null;
  readonly url?: string | null;
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
  const attemptsByAssetId = await resolveGenerationAssetSuccessAttempts(db, assets);
  const jobProviderById = new Map(jobs.map((job) => [job.id, job.provider] as const));

  return new Map(
    assets.map((asset) => {
      const uploadAuthority = inspectOperatorUploadAuthority(asset);
      const authority = uploadAuthority
        ? combineAuthorityReasons(
            evaluateMediaAssetCustomerPublishability({
              metadata: asset.metadata,
            }),
            uploadAuthority,
          )
        : evaluateMediaAssetCustomerPublishability({
            metadata: asset.metadata,
            jobProvider: asset.sourceJobId
              ? jobProviderById.get(asset.sourceJobId) ?? null
              : null,
            jobProviderRequired: true,
            latestAttemptProvider: asset.sourceJobId
              ? attemptsByAssetId.get(asset.id)?.provider ?? null
              : null,
            latestAttemptProviderRequired: true,
          });
      return [asset.id, authority] as const;
    }),
  );
}

function combineAuthorityReasons(
  ...authorities: readonly ResolvedMediaAssetAuthority[]
): ResolvedMediaAssetAuthority {
  const reasons = [...new Set(authorities.flatMap((authority) => authority.reasons))];
  return { publishable: reasons.length === 0, reasons };
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
