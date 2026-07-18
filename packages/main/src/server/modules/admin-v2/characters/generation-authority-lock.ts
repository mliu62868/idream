import type { Prisma } from "@prisma/client";

/**
 * Serializes every mutation that can change, consume, or revoke Character
 * image-generation authority. Acquire it before narrower identity/reference
 * locks so all callers share one deadlock-free ordering.
 */
export async function lockCharacterGenerationAuthority(
  tx: Pick<Prisma.TransactionClient, "$executeRaw">,
  characterId: string,
) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`character-generation-authority:${characterId}`}))`;
}

/**
 * Locks the same authority keys used by Media Library mutations. Character
 * callers must acquire `character-generation-authority` first, then call this
 * helper once with the complete asset set so every caller uses the same sorted
 * lock order.
 */
export async function lockCharacterMediaAssetAuthorities(
  tx: Pick<Prisma.TransactionClient, "$executeRaw">,
  assetIds: readonly string[],
) {
  const orderedAssetIds = [...new Set(assetIds)].sort();
  for (const assetId of orderedAssetIds) {
    await lockMediaAssetAuthority(tx, assetId);
  }
}

/**
 * Serializes every writer and consumer of one MediaAsset's operational
 * authority. Writers must share this lock with Character consumers; a row
 * update alone cannot serialize transactions that only validate the asset.
 */
export async function lockMediaAssetAuthority(
  tx: Pick<Prisma.TransactionClient, "$executeRaw">,
  assetId: string,
) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`media-asset-authority:${assetId}`}))`;
}

/**
 * Convenience for Character operations whose complete media set is already
 * known before entering the authority section.
 */
export async function lockCharacterGenerationAndMediaAssetAuthorities(
  tx: Pick<Prisma.TransactionClient, "$executeRaw">,
  characterId: string,
  assetIds: readonly string[],
) {
  await lockCharacterGenerationAuthority(tx, characterId);
  await lockCharacterMediaAssetAuthorities(tx, assetIds);
}
