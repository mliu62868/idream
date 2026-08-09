// 运营台「现在能用哪条生成路线」的发现逻辑：四个查询都在问同一张
// GenerationModelProfile，只是问法不同——身份自举要一条不吃参考图的 text-to-image、
// 路线评测要一条能吃下整套参考图的、身份校准要能力矩阵、视频要那条生产档位的成本与时长。
import { characterVideoProductionRecipe } from "@idream/shared/admin";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/server/lib/db";
import { generationCostDreamcoins } from "@/server/lib/generation-pricing";
import { generationWorkflowDescriptor } from "@/server/modules/generation/generation-catalog";
import { isProductionLtxVideoProfile } from "@/server/modules/generation/production-video-profile";
import { OPERATIONAL_USER_DATA_CLASS_SQL } from "@/server/modules/metric-data-scope";
import { jsonRecord as record, jsonStrings as strings } from "../shared/prisma-json";
import {
  generationRouteRuntimeCompatibility,
  identityCalibrationGenerationModes,
} from "./generation-route-authority";

const CHARACTER_VIDEO_HEALTH_WINDOW_DAYS = 7;

export async function loadCharacterVideoGenerationEstimate() {
  const profile = await prisma.generationModelProfile.findFirst({
    where: {
      profileKey: characterVideoProductionRecipe.profileKey,
      mode: "video",
      status: "active",
      enabled: true,
      rolloutPercent: { gt: 0 },
    },
    orderBy: { version: "desc" },
  });
  if (!profile || !isProductionLtxVideoProfile(profile)) {
    return {
      profileKey: characterVideoProductionRecipe.profileKey,
      estimatedCostDreamcoins: null,
      averageDurationMs: null,
      completedSampleCount: 0,
      windowDays: CHARACTER_VIDEO_HEALTH_WINDOW_DAYS,
    };
  }
  const since = new Date(
    Date.now() -
      CHARACTER_VIDEO_HEALTH_WINDOW_DAYS * 24 * 60 * 60 * 1_000,
  );
  const [healthRows, estimatedCostDreamcoins] = await Promise.all([
    prisma.$queryRaw<
      Array<{
        averageDurationMs: number | null;
        completedSampleCount: number;
      }>
    >`
      SELECT
        GREATEST(
          0,
          AVG(EXTRACT(EPOCH FROM (jobs."completedAt" - jobs."createdAt")) * 1000)
        )::float8 AS "averageDurationMs",
        count(*)::int AS "completedSampleCount"
      FROM "generation_jobs" jobs
      JOIN "users" owners ON owners.id = jobs."userId"
      WHERE jobs."createdAt" >= ${since}
        AND jobs."completedAt" IS NOT NULL
        AND jobs."mode" = 'video'
        AND jobs."profileId" = ${profile.profileKey}
        AND jobs."profileVersion" = ${profile.version}
        AND owners."dataClass" IN (${OPERATIONAL_USER_DATA_CLASS_SQL})
    `,
    generationCostDreamcoins(
      "video",
      characterVideoProductionRecipe.outputCount,
      profile.costMultiplier,
    ).catch(() => null),
  ]);
  const health = healthRows[0];
  return {
    profileKey: profile.profileKey,
    estimatedCostDreamcoins,
    averageDurationMs: health?.averageDurationMs ?? null,
    completedSampleCount: health?.completedSampleCount ?? 0,
    windowDays: CHARACTER_VIDEO_HEALTH_WINDOW_DAYS,
  };
}

export async function findBootstrapGenerationProfile() {
  const profiles = await prisma.generationModelProfile.findMany({
    where: {
      mode: "image",
      status: "active",
      enabled: true,
      rolloutPercent: { gt: 0 },
    },
    orderBy: [{ publishedAt: "desc" }, { version: "desc" }, { profileKey: "asc" }],
    take: 40,
  });
  const ordered = [...profiles].sort((left, right) => {
    const entitlementDelta = Number(Boolean(left.requiredEntitlement)) - Number(Boolean(right.requiredEntitlement));
    return entitlementDelta || left.profileKey.localeCompare(right.profileKey);
  });
  for (const profile of ordered) {
    const workflowKey = profile.workflowKey ?? profile.pipelineModel;
    const workflow = await generationWorkflowDescriptor(workflowKey);
    const capabilities = record(record(profile.runnerConfig).capabilities as Prisma.JsonValue | undefined);
    if (
      !workflow ||
      workflow.identity.mode !== "none" ||
      workflow.identity.maxReferences !== 0 ||
      !workflow.capabilities.includes("textToImage") ||
      capabilities.textToImage !== true
    ) {
      continue;
    }
    const allowedOrientations = strings(profile.allowedOrientations);
    return {
      profileKey: profile.profileKey,
      profileVersion: profile.version,
      label: profile.label,
      workflowKey,
      workflowVersion: workflow.version,
      orientation: allowedOrientations.includes("4:5")
        ? "4:5"
        : allowedOrientations[0] ?? "4:5",
    };
  }
  return null;
}

export async function findRouteEvaluationGenerationProfiles(
  requiredReferenceRoles: readonly string[],
) {
  if (requiredReferenceRoles.length === 0) return [];
  const profiles = await prisma.generationModelProfile.findMany({
    where: {
      mode: "image",
      status: "active",
      enabled: true,
      rolloutPercent: { gt: 0 },
    },
    orderBy: [
      { publishedAt: "desc" },
      { version: "desc" },
      { profileKey: "asc" },
    ],
    take: 80,
  });
  const compatible: Array<{
    profileKey: string;
    profileVersion: number;
    label: string;
    workflowKey: string;
    workflowVersion: number;
    orientation: string;
    requiredEntitlement: string | null;
  }> = [];
  for (const profile of profiles) {
    const workflowKey = profile.workflowKey ?? profile.pipelineModel;
    const workflow = await generationWorkflowDescriptor(workflowKey);
    const incompatibility = generationRouteRuntimeCompatibility({
      workflow,
      qualificationWorkflowVersion: workflow?.version ?? 0,
      profileCapabilities: record(profile.runnerConfig).capabilities,
      requiredReferenceCount: requiredReferenceRoles.length,
      requiredReferenceRoles,
    });
    if (incompatibility || !workflow) continue;
    const allowedOrientations = strings(profile.allowedOrientations);
    compatible.push({
      profileKey: profile.profileKey,
      profileVersion: profile.version,
      label: profile.label,
      workflowKey,
      workflowVersion: workflow.version,
      orientation: allowedOrientations.includes("4:5")
        ? "4:5"
        : allowedOrientations[0] ?? "4:5",
      requiredEntitlement: profile.requiredEntitlement,
    });
  }
  compatible.sort((left, right) =>
    Number(Boolean(left.requiredEntitlement)) -
      Number(Boolean(right.requiredEntitlement)) ||
    left.profileKey.localeCompare(right.profileKey) ||
    right.profileVersion - left.profileVersion
  );
  return compatible.map((profile, index) => ({
    profileKey: profile.profileKey,
    profileVersion: profile.profileVersion,
    label: profile.label,
    workflowKey: profile.workflowKey,
    workflowVersion: profile.workflowVersion,
    orientation: profile.orientation,
    recommended: index === 0,
  }));
}

export async function findIdentityCalibrationGenerationProfiles() {
  const profiles = await prisma.generationModelProfile.findMany({
    where: {
      mode: "image",
      status: "active",
      enabled: true,
      rolloutPercent: { gt: 0 },
    },
    orderBy: [
      { publishedAt: "desc" },
      { version: "desc" },
      { profileKey: "asc" },
    ],
    take: 80,
  });
  const compatible: Array<{
    profileKey: string;
    profileVersion: number;
    label: string;
    modelId: string;
    workflowKey: string;
    workflowVersion: number;
    orientation: string;
    allowedOrientations: string[];
    modes: Array<"text_to_image" | "image_to_image">;
    requiredEntitlement: string | null;
  }> = [];
  for (const profile of profiles) {
    const workflowKey = profile.workflowKey ?? profile.pipelineModel;
    const workflow = await generationWorkflowDescriptor(workflowKey);
    if (!workflow) continue;
    const capabilities = record(
      record(profile.runnerConfig).capabilities as Prisma.JsonValue | undefined,
    );
    const modes = identityCalibrationGenerationModes({
      workflow,
      profileCapabilities: capabilities,
    });
    if (modes.length === 0) continue;
    const allowedOrientations = strings(profile.allowedOrientations);
    compatible.push({
      profileKey: profile.profileKey,
      profileVersion: profile.version,
      label: profile.label,
      modelId: profile.pipelineModel,
      workflowKey,
      workflowVersion: workflow.version,
      orientation: allowedOrientations.includes("4:5")
        ? "4:5"
        : allowedOrientations[0] ?? "4:5",
      allowedOrientations: allowedOrientations.length > 0
        ? allowedOrientations
        : ["4:5"],
      modes,
      requiredEntitlement: profile.requiredEntitlement,
    });
  }
  compatible.sort((left, right) =>
    Number(!left.modes.includes("text_to_image")) -
      Number(!right.modes.includes("text_to_image")) ||
    Number(Boolean(left.requiredEntitlement)) -
      Number(Boolean(right.requiredEntitlement)) ||
    left.profileKey.localeCompare(right.profileKey) ||
    right.profileVersion - left.profileVersion
  );
  return compatible.map((profile, index) => ({
    profileKey: profile.profileKey,
    profileVersion: profile.profileVersion,
    label: profile.label,
    modelId: profile.modelId,
    workflowKey: profile.workflowKey,
    workflowVersion: profile.workflowVersion,
    orientation: profile.orientation,
    allowedOrientations: profile.allowedOrientations,
    modes: profile.modes,
    recommended: index === 0,
  }));
}
