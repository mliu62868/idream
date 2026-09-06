import { pathToFileURL } from "node:url";
import { prisma } from "@/server/lib/db";
import { generationWorkflowDescriptor } from "@/server/modules/generation/generation-catalog";
import {
  productionVideoRecipeForProfile,
} from "@/server/modules/generation/production-video-profile";
import { characterVideoProductionRecipe } from "@idream/shared";
import {
  filterPublicTextToImageGenerationProfiles,
  generationProfileDeclaresTextToImage,
} from "@/server/modules/ourdream/generation-profile-selection";
import { publicCharacterAudienceWhere } from "@/server/modules/ourdream/public-content-audience";
import type { ProbeReportOf, ProductConfigProbeEvidence } from "./readiness/evidence";
import {
  probeReportPath,
  writeProbeReport,
} from "./readiness/probe-report";

type ProbeOptions = {
  report: string | null;
};

// SPEC: 写出的 JSON 由 launch gate 的 evidence 契约约束，两端共用 readiness/evidence.ts。
type ProductConfigProbeReport = ProbeReportOf<ProductConfigProbeEvidence>;

function readOptions(): ProbeOptions {
  return {
    report: probeReportPath("productConfigProbe"),
  };
}

async function main() {
  const options = readOptions();
  const report = await runProbe();

  if (options.report) {
    await writeProbeReport(options.report, report);
  }

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.ok) process.exitCode = 1;
}

export async function runProbe(): Promise<ProductConfigProbeReport> {
  const checkedAt = new Date().toISOString();
  const startedAt = Date.now();

  try {
    const [
      videoFlag,
      activeImageProfileCandidates,
      activeImageCharacterTemplates,
      activeImageFreeplayTemplates,
      activeImagePricingRules,
      activeVideoProfileCandidates,
      activeVideoCharacterTemplates,
      activeVideoFreeplayTemplates,
      activeVideoPricingRules,
      activeVoicePricingRules,
      publicCharacters,
      publicCharactersWithSystemPrompt,
    ] = await Promise.all([
      prisma.featureFlag.findUnique({ where: { key: "video_gen" } }),
      prisma.generationModelProfile.findMany({
        where: { mode: "image", status: "active", enabled: true },
        select: {
          id: true,
          mode: true,
          runner: true,
          runnerConfig: true,
          pipelineModel: true,
          workflowKey: true,
          allowedOrientations: true,
          maxCount: true,
          rolloutPercent: true,
        },
      }),
      prisma.generationRecipe.count({
        where: { mode: "image", useCase: "character", status: "active" },
      }),
      prisma.generationRecipe.count({
        where: { mode: "image", useCase: "freeplay", status: "active" },
      }),
      prisma.pricingRule.count({ where: { mode: "image", status: "active" } }),
      prisma.generationModelProfile.findMany({
        where: { mode: "video", status: "active", enabled: true },
      }),
      prisma.generationRecipe.count({
        where: { mode: "video", useCase: "character", status: "active" },
      }),
      prisma.generationRecipe.count({
        where: { mode: "video", useCase: "freeplay", status: "active" },
      }),
      prisma.pricingRule.count({ where: { mode: "video", status: "active" } }),
      prisma.pricingRule.count({ where: { mode: "voice", status: "active" } }),
      prisma.character.count({
        where: publicCharacterAudienceWhere,
      }),
      prisma.character.count({
        where: {
          AND: [
            publicCharacterAudienceWhere,
            { systemPrompt: { not: null } },
            { systemPrompt: { not: "" } },
          ],
        },
      }),
    ]);

    const videoFeatureEnabled =
      videoFlag?.enabled === true && videoFlag.rolloutPercent === 100;
    const eligibleImageProfiles =
      await filterPublicTextToImageGenerationProfiles(
        activeImageProfileCandidates,
      );
    const eligibleImageProfileIds = new Set(
      eligibleImageProfiles.map((profile) => profile.id),
    );
    const activeImageExecutionBindings = await Promise.all(
      eligibleImageProfiles.map(async (profile) => {
        const descriptor = profile.workflowKey
          ? await generationWorkflowDescriptor(profile.workflowKey)
          : null;
        return {
          profileId: profile.id,
          runner: profile.runner,
          // Main dispatches workflowKey when present; this is the exact value
          // copied into the immutable Attempt and resolved by Gen.
          model: profile.workflowKey ?? profile.pipelineModel,
          workflowKey: profile.workflowKey,
          workflowVersion: descriptor?.version ?? null,
        };
      }),
    );
    const activeImageProfiles = eligibleImageProfiles.length;
    const invalidActiveImageProfileIds = activeImageProfileCandidates
      .filter(generationProfileDeclaresTextToImage)
      .filter((profile) => !eligibleImageProfileIds.has(profile.id))
      .map((profile) => profile.id);
    const activeVideoExecutionBindings = activeVideoProfileCandidates.flatMap(
      (profile) => {
        const recipe = productionVideoRecipeForProfile(profile);
        return recipe
          ? [{
              profileId: profile.id,
              profileKey: recipe.profileKey,
              model: recipe.workflowKey,
              workflowKey: recipe.workflowKey,
              workflowVersion: recipe.workflowVersion,
            }]
          : [];
      },
    );
    const activeVideoProfiles = activeVideoExecutionBindings.length;
    const invalidActiveVideoProfileIds = activeVideoProfileCandidates
      .filter((profile) => productionVideoRecipeForProfile(profile) === null)
      .map((profile) => profile.id);
    const activeVideoProfileKeys = new Set(
      activeVideoExecutionBindings.map((binding) => binding.profileKey),
    );
    // Optional, explicitly selected recipes may be disabled by operators.
    // Readiness requires the canonical default route plus validation of every exposed route.
    const missingVideoProfileKeys = [characterVideoProductionRecipe.profileKey]
      .filter((profileKey) => !activeVideoProfileKeys.has(profileKey));
    const failureReasons = [
      activeImageProfiles < 1 ? "missing active image model profile" : null,
      invalidActiveImageProfileIds.length > 0
        ? `active image profiles are not public text-to-image executable: ${invalidActiveImageProfileIds.join(", ")}`
        : null,
      activeImageCharacterTemplates < 1
        ? "missing active image character prompt template"
        : null,
      activeImageFreeplayTemplates < 1
        ? "missing active image freeplay prompt template"
        : null,
      activeImagePricingRules !== 1
        ? `image pricing requires exactly one active rule (found ${activeImagePricingRules})`
        : null,
      videoFeatureEnabled && missingVideoProfileKeys.length > 0
        ? `video_gen enabled without production video profiles: ${missingVideoProfileKeys.join(", ")}`
        : null,
      videoFeatureEnabled && invalidActiveVideoProfileIds.length > 0
        ? `active video profiles do not match production authority: ${invalidActiveVideoProfileIds.join(", ")}`
        : null,
      videoFeatureEnabled && activeVideoCharacterTemplates < 1
        ? "video_gen enabled without active video character prompt template"
        : null,
      videoFeatureEnabled && activeVideoPricingRules !== 1
        ? `video_gen requires exactly one active video pricing rule (found ${activeVideoPricingRules})`
        : null,
      activeVoicePricingRules !== 1
        ? `voice pricing requires exactly one active rule (found ${activeVoicePricingRules})`
        : null,
      publicCharactersWithSystemPrompt !== publicCharacters
        ? `${publicCharacters - publicCharactersWithSystemPrompt} public character(s) have no chat system prompt`
        : null,
    ].filter((reason): reason is string => Boolean(reason));

    return {
      ok: failureReasons.length === 0,
      checkedAt,
      durationMs: Date.now() - startedAt,
      videoFeatureEnabled,
      activeImageProfiles,
      activeImageExecutionBindings,
      invalidActiveImageProfileIds,
      activeImageCharacterTemplates,
      activeImageFreeplayTemplates,
      activeImagePricingRules,
      activeVideoProfiles,
      activeVideoExecutionBindings,
      invalidActiveVideoProfileIds,
      activeVideoCharacterTemplates,
      activeVideoFreeplayTemplates,
      activeVideoPricingRules,
      activeVoicePricingRules,
      publicCharacters,
      publicCharactersWithSystemPrompt,
      failureReasons,
      error:
        failureReasons.length === 0
          ? null
          : {
              code: "product_config_incomplete",
              message: failureReasons.join("; "),
              retryable: false,
            },
    };
  } catch (error) {
    return {
      ok: false,
      checkedAt,
      durationMs: Date.now() - startedAt,
      videoFeatureEnabled: false,
      activeImageProfiles: 0,
      activeImageExecutionBindings: [],
      invalidActiveImageProfileIds: [],
      activeImageCharacterTemplates: 0,
      activeImageFreeplayTemplates: 0,
      activeImagePricingRules: 0,
      activeVideoProfiles: 0,
      activeVideoExecutionBindings: [],
      invalidActiveVideoProfileIds: [],
      activeVideoCharacterTemplates: 0,
      activeVideoFreeplayTemplates: 0,
      activeVideoPricingRules: 0,
      activeVoicePricingRules: 0,
      publicCharacters: 0,
      publicCharactersWithSystemPrompt: 0,
      failureReasons: ["product config probe failed"],
      error: {
        code: "product_config_probe_failed",
        message: error instanceof Error ? error.message : String(error),
        retryable: true,
      },
    };
  } finally {
    await prisma.$disconnect();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((error: unknown) => {
  process.stderr.write(error instanceof Error ? `${error.message}\n` : `${String(error)}\n`);
  process.exitCode = 1;
});
