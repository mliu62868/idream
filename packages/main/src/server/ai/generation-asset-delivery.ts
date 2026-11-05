// SPEC: the one place a terminal record's asset becomes a MediaAsset row.
// INTENT: finalize and unknown-success adoption each carried a copy of this, and the
// copies had drifted: adopted assets lost `quality`, `synthetic` and `source`. A
// derivative added to one copy would have silently skipped the other path.
// INVARIANT: the caller owns the transaction, the settlement lock and the row id.
// Nothing here reads a mutable Job field outside the frozen projection it is given.
import type { GenerationJob, Prisma } from "@prisma/client";
import { generationAssetDerivativeKey, type AiFinalizePayload } from "@idream/shared/contracts";
import { toInputJson } from "@/server/modules/admin-v2/shared/prisma-json";
import { mediaThumbnailViewUrl, mediaViewUrl } from "@/server/modules/ourdream/public-read-model";

type CompletedPayload = Extract<AiFinalizePayload, { kind: "generation.completed" }>;
type DeliveredAsset = CompletedPayload["assets"][number];

// INVARIANT: MediaAsset.sourcePromptHash keeps the established generation projection
// format so adopted and normal outputs remain query-compatible.
function generationPromptHash(value: string) {
  let hash = 5381;
  for (const char of value) hash = (hash * 33) ^ char.charCodeAt(0);
  return `prompt_${Math.abs(hash)}`;
}

/** Evidence for an asset whose worker predates quality scoring. */
export function generatedAssetQuality(asset: DeliveredAsset) {
  return asset.quality ?? {
    schemaVersion: "1" as const,
    evaluatorVersion: "not_provided",
    artifact: { status: "unscored" as const, reason: "worker_did_not_provide_evidence" },
    faceCount: { status: "unscored" as const, reason: "evaluator_unavailable" },
    identity: { status: "unscored" as const, reason: "evaluator_unavailable" },
    intent: { status: "unscored" as const, reason: "evaluator_unavailable" },
  };
}

export async function createDeliveredGenerationAsset(
  tx: Prisma.TransactionClient,
  input: {
    readonly id: string;
    readonly request: Pick<
      GenerationJob,
      | "id" | "userId" | "characterId" | "prompt" | "sourceType" | "visualProfileId"
      | "visualProfileVersion" | "consistencyMode" | "seed" | "referenceAssetIds"
    >;
    readonly payload: Pick<CompletedPayload, "mode" | "usage">;
    readonly provider: string;
    readonly asset: DeliveredAsset;
    readonly ordinal: number;
    readonly safetyStatus: Prisma.MediaAssetUncheckedCreateInput["safetyStatus"];
    /** Path-specific evidence, e.g. the terminal receipt an adoption was bound to. */
    readonly evidence?: Readonly<Record<string, unknown>>;
  },
): Promise<{ id: string }> {
  const { asset, request } = input;
  const displayUrl = mediaViewUrl({ id: input.id, type: input.payload.mode, contentType: asset.contentType, storageKey: asset.key, url: "" });
  const providerKey = typeof asset.providerKey === "string" ? asset.providerKey : asset.key;
  // Serving derives the key from storageKey, so a ready derivative under any other
  // key would be a thumbnail URL that 404s. Ingest already rejects that; this guards
  // records that were accepted before it did.
  const derivativeReady = asset.derivative?.status === "ready" &&
    asset.derivative.key === generationAssetDerivativeKey(asset.key);
  return tx.mediaAsset.create({
    data: {
      id: input.id,
      ownerId: request.userId,
      sourceJobId: request.id,
      characterId: request.characterId,
      type: input.payload.mode,
      url: displayUrl,
      // Video has no fallback image: a poster is the derivative or nothing.
      thumbnailUrl: derivativeReady
        ? mediaThumbnailViewUrl({ id: input.id })
        : input.payload.mode === "image" ? displayUrl : null,
      storageKey: asset.key,
      contentType: asset.contentType,
      width: asset.width,
      height: asset.height,
      providerAssetId: providerKey,
      sourcePromptHash: request.prompt ? generationPromptHash(request.prompt) : null,
      prompt: request.prompt,
      visibility: "private",
      safetyStatus: input.safetyStatus,
      metadata: toInputJson({
        index: input.ordinal,
        provider: input.provider,
        providerKey,
        synthetic: input.provider.startsWith("mock"),
        contentType: asset.contentType,
        width: asset.width,
        height: asset.height,
        seconds: asset.seconds,
        usage: input.payload.usage,
        storageKey: asset.key,
        ...(request.sourceType === "character_preview" ? { source: "character_preview" } : {}),
        visualProfileId: request.visualProfileId,
        visualProfileVersion: request.visualProfileVersion,
        consistencyMode: request.consistencyMode,
        seed: request.seed,
        referenceAssetIds: request.referenceAssetIds,
        quality: generatedAssetQuality(asset),
        // The record of a failed derivative stays with the asset it degraded.
        ...(asset.derivative ? { derivative: asset.derivative } : {}),
        ...input.evidence,
      }),
    },
    select: { id: true },
  });
}
