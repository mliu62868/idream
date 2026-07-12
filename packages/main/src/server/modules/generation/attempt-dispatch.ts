import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import type { ImageGeneratePayload, VideoGeneratePayload } from "@/server/ai/schemas";
import { imageReferenceInputsForGenerationJob } from "@/server/ai/reference-images";
import { recordGenerationAttemptQueuedEvent } from "@/server/ai/generation-attempt-events";
import { jobQueue } from "@/server/jobs/queue";
import { prisma } from "@/server/lib/db";
import { Errors } from "@/server/lib/errors";

export type ExistingGenerationJob = {
  id: string;
  userId: string;
  characterId: string | null;
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
  referenceAssetIds?: Prisma.JsonValue | null;
};

export async function enqueueGenerationAttempt(
  job: ExistingGenerationJob,
  suppliedAttempt?: { readonly attemptId: string; readonly attemptNo: number },
) {
  const attempt = await prisma.$transaction(async (tx) => {
    const row = suppliedAttempt
      ? await tx.generationAttempt.findUniqueOrThrow({ where: { id: suppliedAttempt.attemptId } })
      : await tx.generationAttempt.upsert({
          where: { requestId_attemptNo: { requestId: job.id, attemptNo: 1 } },
          create: { requestId: job.id, attemptNo: 1, status: "queued" },
          update: {},
        });
    await recordGenerationAttemptQueuedEvent(tx, row);
    return row;
  });
  if (attempt.requestId !== job.id || (suppliedAttempt && attempt.attemptNo !== suppliedAttempt.attemptNo)) {
    throw Errors.conflict("Generation Attempt does not belong to the requested generation authority");
  }
  const controls = await existingGenerationControls(job);
  const modelCapabilities = modelCapabilitiesFromControls(controls);
  const referenceImages =
    job.mode === "image" && (modelCapabilities.referenceImages || modelCapabilities.initImage)
      ? filterReferenceImagesForCapabilities(
          await imageReferenceInputsForGenerationJob({
            userId: job.userId,
            characterId: job.characterId,
            controls,
            referenceAssetIds: job.referenceAssetIds,
          }),
          modelCapabilities,
        )
      : [];
  const common = {
    version: 1 as const,
    requestId: `admin_requeue_${randomUUID()}`,
    generationJobId: job.id,
    attemptId: attempt.id,
    attemptNo: attempt.attemptNo,
    userId: job.userId,
    characterId: job.characterId,
    prompt: job.prompt ?? `${job.mode === "video" ? "Video" : "Image"} generation ${job.id}`,
    negativePrompt: job.negativePrompt,
    controls,
    seed: job.seed ?? job.id,
    model: job.model ?? (job.mode === "video" ? "mock-video" : "mock-image"),
    outputPrefix: `gen/${job.id}/`,
  };
  const payload: ImageGeneratePayload | VideoGeneratePayload =
    job.mode === "video"
      ? { ...common, kind: "video", seconds: numericControl(controls, "seconds", 4) }
      : {
          ...common,
          kind: "image",
          presetIds: jsonStringArray(job.presetIds),
          orientation: job.orientation ?? stringControl(controls, "orientation", "portrait"),
          count: job.outputCount,
          ...(referenceImages.length > 0 ? { referenceImages } : {}),
        };
  await jobQueue.enqueue({
    queue: job.mode === "video" ? "ai.video.generate" : "ai.image.generate",
    payload: payload as unknown as Prisma.InputJsonValue,
    dedupeKey: suppliedAttempt
      ? `generation:${job.id}:attempt:${attempt.attemptNo}`
      : `generation:${job.id}`,
    maxAttempts: 3,
  });
}

async function existingGenerationControls(job: Pick<ExistingGenerationJob, "controls" | "profileId" | "profileVersion">) {
  const controls = jsonRecord(job.controls);
  if (!job.profileId || !job.profileVersion) return controls;
  const profile = await prisma.generationModelProfile.findFirst({
    where: {
      version: job.profileVersion,
      OR: [{ profileKey: job.profileId }, { id: job.profileId }],
    },
  });
  if (!profile) return controls;
  return pruneUndefined({
    ...controls,
    modelCapabilities: normalizedModelCapabilities(profile.runnerConfig, profile.runner === "sd_cpp"),
    sdcpp: profile.runner === "sd_cpp" ? sdcppProfileRuntimeConfig(profile) : undefined,
  });
}

function normalizedModelCapabilities(runnerConfig: Prisma.JsonValue | null, sdCppDefault: boolean) {
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

function filterReferenceImagesForCapabilities(
  images: Awaited<ReturnType<typeof imageReferenceInputsForGenerationJob>>,
  capabilities: ReturnType<typeof modelCapabilitiesFromControls>,
) {
  return images.filter((image) =>
    image.role === "source_image" ? capabilities.initImage : capabilities.referenceImages,
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
