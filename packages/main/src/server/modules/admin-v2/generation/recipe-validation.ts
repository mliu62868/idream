import type { Prisma } from "@prisma/client";
import type { GenerationRecipePreview } from "@idream/shared/admin";
import { dimensionsForImageOrientation } from "@idream/shared/media/image-orientation";
import { Errors } from "@/server/lib/errors";
import { evaluateMediaAssetCustomerPublishability, hasHydratableMediaBlobAuthority } from "@/server/lib/media-asset-authority";
import { canonicalSha256 } from "../shared/canonical-json";
import { jsonRecord, jsonStrings } from "../shared/prisma-json";
import { generationWorkflowDescriptor } from "@/server/modules/generation/generation-catalog";
import { buildGenerationPrompt, defaultImageNegativePrompt, imageNegativePrompt } from "@/server/modules/ourdream/generation-prompt";
import { resolvePresetPromptFragment } from "@/server/modules/ourdream/generation-job-create";
import { directCharacterAudienceWhere } from "@/server/modules/ourdream/public-content-audience";
import { resolveImageRecipeNegative, selectRecipe } from "@/server/modules/ourdream/generation-profile-selection";

type Recipe = Prisma.GenerationRecipeGetPayload<Record<string, never>>;
type Db = Prisma.TransactionClient;

// Labels are operator metadata; every generation input and the saved matrix are evidence authority.
export function recipeFingerprint(recipe: Pick<Recipe, "id" | "recipeKey" | "version" | "mode" | "useCase" | "body" | "negativeBase" | "presetOrder" | "safetyHints" | "sampleMatrix">) {
  const { id, recipeKey, version, mode, useCase, body, negativeBase, presetOrder, safetyHints, sampleMatrix } = recipe;
  return canonicalSha256({ id, recipeKey, version, mode, useCase, body, negativeBase, presetOrder, safetyHints, sampleMatrix });
}

export async function loadRecipeMatrix(db: Db, recipeId: string, profileId: string, userId: string) {
  const recipe = await db.generationRecipe.findUnique({ where: { id: recipeId } });
  const profile = await db.generationModelProfile.findUnique({ where: { id: profileId } });
  if (!recipe) throw Errors.notFound("Generation recipe not found");
  if (!profile) throw Errors.notFound("Model profile not found");
  const mode = recipe.mode === "video" ? "video" : "image";
  const productionRecipe = recipe.mode === "negative" ? await selectRecipe("image", recipe.useCase, db) : recipe;
  const enhancement = recipe.mode !== "negative" && recipe.useCase === "enhance";
  const recipeNegative = mode === "image" && !enhancement ? await resolveImageRecipeNegative(productionRecipe, db,
    recipe.mode === "negative" ? { recipeKey: recipe.recipeKey, version: recipe.version, body: recipe.body } : undefined) : null;
  const issues: string[] = [];
  if (profile.mode !== mode || profile.status === "archived") issues.push("Choose an available profile for this recipe's media type.");
  if (profile.runner !== "comfyui") issues.push("Choose a workflow-native generation profile.");
  const workflow = await generationWorkflowDescriptor(profile.workflowKey ?? profile.pipelineModel);
  if (!workflow) issues.push("The selected profile has no executable workflow descriptor.");
  const allowed = jsonStrings(profile.allowedOrientations);
  const matrix = Array.isArray(recipe.sampleMatrix) ? recipe.sampleMatrix : [];
  if (!matrix.length) issues.push("Add at least one sample scene before running validation.");
  const samples = [];
  // A transaction adapter owns one pg client, including reads for different samples.
  for (const [index, raw] of matrix.entries()) {
    const sample = jsonRecord(raw);
    const controls = jsonRecord(sample.controls as Prisma.JsonValue | undefined);
    const orientation = typeof sample.orientation === "string" ? sample.orientation : allowed[0] ?? "1:1";
    const sampleIssues: string[] = [];
    if (!allowed.includes(orientation)) sampleIssues.push("Sample orientation is not supported by this profile.");
    const sourceImageAssetId = typeof sample.sourceImageAssetId === "string" ? sample.sourceImageAssetId : undefined;
    const sourceImage = sourceImageAssetId ? await db.mediaAsset.findFirst({ where: {
      id: sourceImageAssetId, type: "image", deletedAt: null,
      OR: [{ ownerId: userId }, { visibility: "public_pack" }],
    } }) : null;
    if (sourceImageAssetId && (!sourceImage || !hasHydratableMediaBlobAuthority(sourceImage))) sampleIssues.push("Select a readable, stored source image for this sample.");
    if ((mode === "video" || enhancement) && !sourceImageAssetId) sampleIssues.push("This recipe needs a source image in every sample.");
    if (mode === "image" && !sourceImageAssetId && !workflow?.capabilities.includes("textToImage")) sampleIssues.push("This workflow requires a source image.");
    if (enhancement && !workflow?.capabilities.includes("enhance")) sampleIssues.push("Choose an enhancement workflow for this recipe.");
    const characterId = typeof sample.characterId === "string" ? sample.characterId : undefined;
    const character = characterId ? await db.character.findFirst({ where: {
      id: characterId, deletedAt: null, status: "approved", OR: [{ creatorId: userId }, directCharacterAudienceWhere],
    } }) : null;
    if (characterId && !character) sampleIssues.push("Select a readable character for this sample.");
    const presetFragment = await resolvePresetPromptFragment({
      modePresetId: typeof controls.modePresetId === "string" ? controls.modePresetId : undefined,
      backgroundPresetId: typeof controls.backgroundPresetId === "string" ? controls.backgroundPresetId : undefined,
      posePresetId: typeof controls.posePresetId === "string" ? controls.posePresetId : undefined,
      outfitPresetId: typeof controls.outfitPresetId === "string" ? controls.outfitPresetId : undefined,
    }, userId, db);
    // Standard recipe bodies describe the template; only enhancement sends the body itself.
    const prompt = enhancement ? recipe.body : buildGenerationPrompt({
      mode, character, visualProfile: null, consistencyMode: "balanced",
      userPrompt: typeof sample.prompt === "string" ? sample.prompt : undefined,
      presetFragment, lookFragment: "", sourceImageAssetId,
    });
    const negativePrompt = mode === "image" && !enhancement
      ? imageNegativePrompt([defaultImageNegativePrompt(recipeNegative?.base ?? productionRecipe.negativeBase), typeof sample.negativePrompt === "string" ? sample.negativePrompt : null].filter(Boolean).join(", "), null)
      : typeof sample.negativePrompt === "string" ? sample.negativePrompt : null;
    const dimensions = enhancement && sourceImage?.width && sourceImage.height
      ? { width: sourceImage.width * 2, height: sourceImage.height * 2 }
      : mode === "image" ? dimensionsForImageOrientation({ orientation, defaultWidth: profile.defaultWidth, defaultHeight: profile.defaultHeight })
      : { width: profile.defaultWidth, height: profile.defaultHeight };
    samples.push({ index, prompt, negativePrompt, orientation, issues: sampleIssues, characterId, sourceImageAssetId, dimensions });
  }
  const profileFingerprint = canonicalSha256({
    profileKey: profile.profileKey, version: profile.version, runner: profile.runner, workflowKey: profile.workflowKey,
    pipelineModel: profile.pipelineModel, runnerConfig: profile.runnerConfig, width: profile.defaultWidth, height: profile.defaultHeight,
    allowedOrientations: profile.allowedOrientations, steps: profile.steps, sampler: profile.sampler, scheduler: profile.scheduler, cfgScale: profile.cfgScale,
    workflow,
  });
  // The preview is a promise about the exact compiled samples and executable profile, not only the recipe row.
  const fingerprint = canonicalSha256({
    recipe: recipeFingerprint(recipe), profile: profileFingerprint,
    samples: samples.map(({ index, prompt, negativePrompt, orientation, characterId, sourceImageAssetId, dimensions }) =>
      ({ index, prompt, negativePrompt, orientation, characterId, sourceImageAssetId, dimensions })),
    ...(recipeNegative?.negativeRecipe ? { promptRecipeFingerprint: recipeNegative.promptRecipeFingerprint } : {}),
  });
  return { recipe, productionRecipe, recipeNegative, profile, profileFingerprint, fingerprint, mode, samples, issues };
}

export async function inspectRecipeValidation(db: Db, matrix: Awaited<ReturnType<typeof loadRecipeMatrix>>): Promise<GenerationRecipePreview["validation"]> {
  const summary = jsonRecord(matrix.recipe.dryRunSummary);
  const ids = jsonStrings(summary.jobIds as Prisma.JsonValue);
  if (summary.source !== "admin_recipe_validation" || !ids.length) return { status: "not_run", issues: ["Run the saved sample matrix before publishing."], jobs: [] };
  if (summary.fingerprint !== matrix.fingerprint || summary.profileFingerprint !== matrix.profileFingerprint || summary.profileId !== matrix.profile.id) return { status: "stale", issues: ["Recipe or test profile inputs changed. Run the saved matrix again."], jobs: [] };
  const jobs = await db.generationJob.findMany({ where: { id: { in: ids } }, include: { assets: true } });
  const attempts = await db.generationAttempt.findMany({ where: { requestId: { in: ids } }, orderBy: { attemptNo: "desc" } });
  const artifacts = await db.generationArtifact.findMany({ where: { attemptId: { in: attempts.map(attempt => attempt.id) }, validationState: "valid", archiveState: "active" } });
  const deliveries = await db.generationDelivery.findMany({ where: { requestId: { in: ids }, status: "delivered", deliveredAt: { not: null }, targetType: "user_library" } });
  const issues = [...matrix.issues, ...matrix.samples.flatMap(sample => sample.issues)];
  let running = false;
  const rows: GenerationRecipePreview["validation"]["jobs"][number][] = [];
  const seen = new Set<number>();
  for (const job of jobs) {
    const meta = jsonRecord(job.sourceMeta);
    const index = typeof meta.sampleIndex === "number" ? meta.sampleIndex : -1;
    const sample = matrix.samples[index];
    const attempt = attempts.find(candidate => candidate.requestId === job.id);
    const validIdentity = sample && !seen.has(index) && job.sourceType === "admin_recipe_test" && meta.recipeRecordId === matrix.recipe.id &&
      meta.fingerprint === matrix.fingerprint && meta.profileFingerprint === matrix.profileFingerprint &&
      job.recipeId === matrix.productionRecipe.recipeKey && job.recipeVersion === matrix.productionRecipe.version &&
      (!matrix.recipeNegative?.negativeRecipe || canonicalSha256(meta.negativeRecipe ?? null) === canonicalSha256(matrix.recipeNegative.negativeRecipe)) &&
      job.profileId === matrix.profile.profileKey && job.profileVersion === matrix.profile.version &&
      job.prompt === sample.prompt && job.negativePrompt === sample.negativePrompt && job.orientation === sample.orientation;
    if (!validIdentity) { issues.push("A sample job does not match the current saved matrix."); continue; }
    seen.add(index);
    const deliveredAssets = job.assets.filter(asset => !asset.deletedAt && hasHydratableMediaBlobAuthority(asset) &&
      evaluateMediaAssetCustomerPublishability({ metadata: asset.metadata, jobProvider: job.provider, jobProviderRequired: true, latestAttemptProvider: attempt?.provider, latestAttemptProviderRequired: true }).publishable &&
      artifacts.some(artifact => artifact.attemptId === attempt?.id && artifact.assetId === asset.id && deliveries.some(delivery => delivery.artifactId === artifact.id && delivery.targetId === job.userId)));
    const complete = job.status === "completed" && attempt?.status === "succeeded" && job.deliveredOutputCount === 1 && deliveredAssets.length === 1;
    if (!complete) {
      if (["queued", "moderating_input", "running", "moderating_output"].includes(job.status)) running = true;
      else issues.push("A sample has no verified generated output and library delivery.");
    }
    rows.push({ id: job.id, sampleIndex: index, status: complete ? "completed" : job.status, assetUrls: deliveredAssets.map(asset => asset.url) });
  }
  if (seen.size !== matrix.samples.length || ids.length !== matrix.samples.length) issues.push("Every saved matrix sample must have exactly one matching job.");
  return { status: issues.length ? "failed" : running ? "running" : summary.status === "passed" ? "passed" : "ready", issues, jobs: rows.sort((a, b) => a.sampleIndex - b.sampleIndex) };
}
