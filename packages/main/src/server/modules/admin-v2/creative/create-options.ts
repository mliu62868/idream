import { prisma } from "@/server/lib/db";
import { creativeRunCreateOptionsSchema } from "@idream/shared/admin";
import type { AdminActor } from "@/server/modules/admin-v2/shared/authority";
import { generationWorkflowDescriptor } from "@/server/modules/generation/generation-catalog";
import { jsonRecord, nonEmptyStrings } from "./json";

// SPEC: 建 Creative Run 之前，运营能选哪些用途与哪条文生图路线。
// INTENT: 这是创建路径的读侧 —— 它回答的是「现在能不能建、建成什么样」，与 run-create
// 的写权威成对，和评审 / 投放 / 列表都无关。

const GENERIC_CREATIVE_PURPOSES = [
  {
    value: "campaign",
    label: "Campaign",
    description: "Create a reviewed campaign image that can be verified against the live campaign surface.",
    defaultOrientation: "16:9",
    runtimePlacementSupported: true,
  },
  {
    value: "homepage",
    label: "Homepage feature",
    description: "Create a homepage candidate for review and handoff. Live placement is not yet automated.",
    defaultOrientation: "16:9",
    runtimePlacementSupported: false,
  },
  {
    value: "feed",
    label: "Feed image",
    description: "Create a feed-ready image for review and downstream curation.",
    defaultOrientation: "1:1",
    runtimePlacementSupported: false,
  },
  {
    value: "seo",
    label: "SEO image",
    description: "Create a search or editorial image for review and downstream publishing.",
    defaultOrientation: "16:9",
    runtimePlacementSupported: false,
  },
  {
    value: "template_cover",
    label: "Template cover",
    description: "Create a reusable template cover for review and downstream adoption.",
    defaultOrientation: "4:5",
    runtimePlacementSupported: false,
  },
] as const;

export async function getCreativeRunCreateOptions(input: {
  readonly actor: AdminActor;
}) {
  void input.actor;
  const [profiles, recipe] = await Promise.all([
    prisma.generationModelProfile.findMany({
      where: {
        mode: "image",
        status: "active",
        enabled: true,
        rolloutPercent: { gt: 0 },
      },
      orderBy: [{ publishedAt: "desc" }, { version: "desc" }, { profileKey: "asc" }],
      take: 80,
    }),
    prisma.generationRecipe.findFirst({
      where: { mode: "image", useCase: "freeplay", status: "active" },
      select: { id: true },
    }),
  ]);
  const compatible: Array<{
    profileKey: string;
    profileVersion: number;
    label: string;
    workflowKey: string;
    workflowVersion: number;
    allowedOrientations: string[];
    requiredEntitlement: string | null;
  }> = [];
  for (const profile of profiles) {
    const workflowKey = profile.workflowKey ?? profile.pipelineModel;
    const workflow = await generationWorkflowDescriptor(workflowKey);
    const capabilities = jsonRecord(jsonRecord(profile.runnerConfig).capabilities);
    if (
      !workflow ||
      workflow.identity.mode !== "none" ||
      workflow.identity.maxReferences !== 0 ||
      !workflow.capabilities.includes("textToImage") ||
      capabilities.textToImage !== true
    ) {
      continue;
    }
    const allowedOrientations = nonEmptyStrings(profile.allowedOrientations);
    compatible.push({
      profileKey: profile.profileKey,
      profileVersion: profile.version,
      label: profile.label,
      workflowKey,
      workflowVersion: workflow.version,
      allowedOrientations: allowedOrientations.length > 0 ? allowedOrientations : ["1:1"],
      requiredEntitlement: profile.requiredEntitlement,
    });
  }
  compatible.sort((left, right) =>
    Number(Boolean(left.requiredEntitlement)) - Number(Boolean(right.requiredEntitlement)) ||
    left.profileKey.localeCompare(right.profileKey) ||
    right.profileVersion - left.profileVersion
  );
  return creativeRunCreateOptionsSchema.parse({
    purposes: GENERIC_CREATIVE_PURPOSES,
    profiles: compatible.map((profile, index) => ({
      profileKey: profile.profileKey,
      profileVersion: profile.profileVersion,
      label: profile.label,
      workflowKey: profile.workflowKey,
      workflowVersion: profile.workflowVersion,
      allowedOrientations: profile.allowedOrientations,
      recommended: index === 0,
    })),
    readiness: {
      ready: compatible.length > 0 && Boolean(recipe),
      blocker: compatible.length === 0
        ? "No compatible text-to-image route is currently available."
        : !recipe
          ? "No active freeplay image recipe is currently available."
          : null,
    },
    characterAssetStudioHref: "/admin/characters",
  });
}
