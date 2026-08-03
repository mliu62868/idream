import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { prisma } from "@/server/lib/db";
import { isProductionLtxVideoProfile } from "@/server/modules/generation/production-video-profile";
import { publicCharacterAudienceWhere } from "@/server/modules/ourdream/public-content-audience";
import type { ProbeReportOf, ProductConfigProbeEvidence } from "./readiness/evidence";

type ProbeOptions = {
  report: string | null;
};

// SPEC: 写出的 JSON 由 launch gate 的 evidence 契约约束，两端共用 readiness/evidence.ts。
type ProductConfigProbeReport = ProbeReportOf<ProductConfigProbeEvidence>;

function readArg(name: string) {
  const prefix = `--${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function readOptions(): ProbeOptions {
  return {
    report: readArg("report") ?? process.env.PRODUCT_CONFIG_PROBE_REPORT ?? null,
  };
}

async function main() {
  const options = readOptions();
  const report = await runProbe();

  if (options.report) {
    const reportPath = resolveWorkspacePath(options.report);
    await mkdir(path.dirname(reportPath), { recursive: true });
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  }

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.ok) process.exitCode = 1;
}

async function runProbe(): Promise<ProductConfigProbeReport> {
  const checkedAt = new Date().toISOString();
  const startedAt = Date.now();

  try {
    const [
      videoFlag,
      activeImageProfiles,
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
      prisma.generationModelProfile.count({
        where: { mode: "image", status: "active", enabled: true },
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
    const activeVideoProfiles = activeVideoProfileCandidates.filter(
      isProductionLtxVideoProfile,
    ).length;
    const failureReasons = [
      activeImageProfiles < 1 ? "missing active image model profile" : null,
      activeImageCharacterTemplates < 1
        ? "missing active image character prompt template"
        : null,
      activeImageFreeplayTemplates < 1
        ? "missing active image freeplay prompt template"
        : null,
      activeImagePricingRules !== 1
        ? `image pricing requires exactly one active rule (found ${activeImagePricingRules})`
        : null,
      videoFeatureEnabled && activeVideoProfiles < 1
        ? "video_gen enabled without the exact production LTX video profile"
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
      publicCharacters > 0 && publicCharactersWithSystemPrompt < 1
        ? "public characters have no chat system prompts"
        : null,
    ].filter((reason): reason is string => Boolean(reason));

    return {
      ok: failureReasons.length === 0,
      checkedAt,
      durationMs: Date.now() - startedAt,
      videoFeatureEnabled,
      activeImageProfiles,
      activeImageCharacterTemplates,
      activeImageFreeplayTemplates,
      activeImagePricingRules,
      activeVideoProfiles,
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
      activeImageCharacterTemplates: 0,
      activeImageFreeplayTemplates: 0,
      activeImagePricingRules: 0,
      activeVideoProfiles: 0,
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

function resolveWorkspacePath(filePath: string) {
  if (path.isAbsolute(filePath)) return filePath;
  return path.resolve(workspaceRoot(), filePath);
}

function workspaceRoot() {
  let current = process.cwd();
  while (true) {
    if (
      existsSync(path.join(current, "package.json")) &&
      (existsSync(path.join(current, "turbo.json")) ||
        existsSync(path.join(current, "bun.lock")))
    ) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) return process.cwd();
    current = parent;
  }
}

main().catch((error: unknown) => {
  process.stderr.write(error instanceof Error ? `${error.message}\n` : `${String(error)}\n`);
  process.exitCode = 1;
});
