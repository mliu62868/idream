import { existsSync } from "node:fs";
import type { Prisma } from "@prisma/client";
import { resolveLocalBlobPath } from "@idream/shared/storage/local-blob";

export function redactGenerationJob(job: {
  id: string;
  userId: string;
  derivedFromJobId?: string | null;
  mode: string;
  prompt: string | null;
  negativePrompt: string | null;
  presetIds: Prisma.JsonValue;
  model: string | null;
  profileId: string | null;
  profileVersion: number | null;
  recipeId: string | null;
  recipeVersion: number | null;
  orientation: string | null;
  outputCount: number;
  status: string;
  costDreamcoins: number;
  provider: string | null;
  errorCode: string | null;
  createdAt: Date;
  updatedAt?: Date;
  completedAt: Date | null;
  assets?: Array<{
    id: string;
    type: string;
    url: string;
    thumbnailUrl: string | null;
    storageKey?: string | null;
    safetyStatus: string;
    createdAt: Date;
  }>;
}) {
  return {
    id: job.id,
    userId: job.userId,
    derivedFromJobId: job.derivedFromJobId ?? null,
    mode: job.mode,
    model: job.model,
    profileId: job.profileId,
    profileVersion: job.profileVersion,
    recipeId: job.recipeId,
    recipeVersion: job.recipeVersion,
    presetIds: job.presetIds,
    orientation: job.orientation,
    outputCount: job.outputCount,
    status: job.status,
    costDreamcoins: job.costDreamcoins,
    provider: job.provider,
    errorCode: job.errorCode,
    promptHidden: Boolean(job.prompt),
    negativePromptHidden: Boolean(job.negativePrompt),
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    completedAt: job.completedAt,
    assets: job.assets?.filter(isReadableMediaAsset).map(redactMediaAsset) ?? [],
  };
}

export function redactMediaAsset(asset: {
  id: string;
  type: string;
  url: string;
  thumbnailUrl: string | null;
  storageKey?: string | null;
  safetyStatus: string;
  createdAt: Date;
}) {
  return {
    id: asset.id,
    type: asset.type,
    url: asset.url,
    thumbnailUrl: asset.thumbnailUrl ?? asset.url,
    safetyStatus: asset.safetyStatus,
    createdAt: asset.createdAt,
  };
}

export function isReadableMediaAsset(asset: { storageKey?: string | null }) {
  if ((process.env.BLOB_PROVIDER ?? "mock") !== "mock") return true;
  if (!asset.storageKey) return true;
  return existsSync(resolveLocalBlobPath(asset.storageKey));
}

export function publicUser(user: {
  id: string;
  email: string;
  displayName: string | null;
  name: string | null;
  role: string;
  status: string;
  createdAt: Date;
}) {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName ?? user.name,
    role: user.role,
    status: user.status,
    createdAt: user.createdAt,
  };
}
