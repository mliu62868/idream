import { createHash } from "node:crypto";
import { z } from "zod";
import { prisma } from "@/server/lib/db";
import { Errors } from "@/server/lib/errors";
import { generationCostFromAuthority, resolveGenerationPricingAuthority } from "@/server/lib/generation-pricing";
import { toInputJson } from "@/server/lib/request-json";
import { lockCharacterMediaAssetAuthorities } from "@/server/modules/admin-v2/characters/generation-authority-lock";
import { dreamcoinBalance } from "@/server/modules/billing/ledger";
import { generationWorkflowDescriptor } from "@/server/modules/generation/generation-catalog";
import { acceptGenerationJobForUser, findExistingGenerationJob, generationWriteRequestFingerprint, wakeQueuedGenerationDispatch } from "./generation-job-authority";
import { generationQuoteAuthoritySchema } from "./generation-quote-contract";
import { assertQuoteStillValid, generationPricingFingerprint } from "./generation-quote";
import { assertMediaEnhancementSource, loadMediaEnhancementSource } from "./media-enhancement-source";
import { entitlementMap } from "./subscription-lifecycle";
import { jsonRecord } from "./json-values";

export const mediaEnhancementQuoteBodySchema = z.object({ scale: z.literal(2) }).strict();
export const mediaEnhancementBodySchema = mediaEnhancementQuoteBodySchema.extend({ quoteAuthority: generationQuoteAuthoritySchema });

export async function mediaEnhancementRoute() {
  const profiles = await prisma.generationModelProfile.findMany({
    where: { profileKey: "image-enhance-2x", mode: "image", status: "active", enabled: true, rolloutPercent: 100 },
    take: 2,
  });
  const profile = profiles.length === 1 ? profiles[0] : null;
  const config = jsonRecord(profile?.runnerConfig);
  const capabilities = jsonRecord(config.capabilities);
  const recipes = await prisma.generationRecipe.findMany({ where: { recipeKey: "image-enhance-2x", mode: "image", useCase: "enhance", status: "active" }, take: 2 });
  const workflow = await generationWorkflowDescriptor("realesrgan-x2plus-enhance");
  if (!profile || recipes.length !== 1 || profile.runner !== "comfyui" ||
    profile.workflowKey !== "realesrgan-x2plus-enhance" || config.workflowVersion !== workflow?.version ||
    !workflow?.capabilities.includes("enhance") || workflow.identity?.maxReferences !== 1 ||
    jsonRecord(config.publicSelection).surface !== "gallery_enhance" ||
    jsonRecord(config.enhancement).scale !== 2 || capabilities.textToImage !== false || capabilities.initImage !== true ||
    profile.maxCount !== 1 || JSON.stringify(profile.allowedOrientations) !== '["original"]') return null;
  return { profile, recipe: recipes[0], workflow };
}

export async function mediaEnhancementAvailable(entitlements: Record<string, unknown>) {
  const route = await mediaEnhancementRoute();
  return Boolean(route && (!route.profile.requiredEntitlement || entitlements[route.profile.requiredEntitlement]));
}

async function enhancementPlan(userId: string, sourceMediaId: string) {
  const source = await loadMediaEnhancementSource(userId, sourceMediaId);
  const route = await mediaEnhancementRoute();
  if (!route) throw Errors.conflict("Image enhancement is unavailable");
  const entitlements = await entitlementMap(userId);
  if (route.profile.requiredEntitlement && !entitlements[route.profile.requiredEntitlement]) {
    throw Errors.paymentRequired("Image enhancement requires an entitlement");
  }
  const pricing = await resolveGenerationPricingAuthority("image");
  const costDreamcoins = generationCostFromAuthority(pricing, 1, route.profile.costMultiplier);
  const routeFingerprint = createHash("sha256").update(JSON.stringify({
    action: "media_enhance", ...source.pin, characterId: source.asset.characterId, sourceJobId: source.asset.sourceJobId,
    profileId: route.profile.profileKey, profileVersion: route.profile.version,
    workflowKey: route.workflow.workflowKey, workflowVersion: route.workflow.version,
    recipeId: route.recipe.recipeKey, recipeVersion: route.recipe.version,
  })).digest("hex");
  const authority = { profileId: route.profile.profileKey, profileVersion: route.profile.version, routeFingerprint,
    pricingFingerprint: generationPricingFingerprint(pricing), outputCount: 1, costDreamcoins };
  return { ...source, ...route, pricing, authority, entitlements };
}

export async function quoteMediaEnhancement(userId: string, sourceMediaId: string) {
  const plan = await enhancementPlan(userId, sourceMediaId);
  return { quote: {
    mode: "image" as const, profileId: plan.authority.profileId, profileVersion: plan.authority.profileVersion,
    routeFingerprint: plan.authority.routeFingerprint,
    pricing: { ruleId: plan.pricing.id, ruleKey: plan.pricing.ruleKey, version: plan.pricing.version,
      effectiveFrom: plan.pricing.effectiveFrom?.toISOString() ?? null, fingerprint: plan.authority.pricingFingerprint },
    orientations: ["original"], defaultOrientation: "original", maxCount: 1,
    costs: [{ outputCount: 1, costDreamcoins: plan.authority.costDreamcoins }],
    balance: await dreamcoinBalance(userId), identityLocked: false,
  }, enhancement: { sourceMediaId, scale: 2 as const, sourceWidth: plan.pin.sourceWidth, sourceHeight: plan.pin.sourceHeight,
    width: plan.pin.sourceWidth * 2, height: plan.pin.sourceHeight * 2 } };
}

export async function createMediaEnhancement(userId: string, sourceMediaId: string,
  body: z.infer<typeof mediaEnhancementBodySchema>, idempotencyKey: string) {
  const options = { idempotencyKey, requestFingerprint: generationWriteRequestFingerprint("media.enhance.create", body, sourceMediaId) };
  const existing = await findExistingGenerationJob(userId, options);
  if (existing) { await wakeQueuedGenerationDispatch(existing); return existing; }
  const plan = await enhancementPlan(userId, sourceMediaId);
  assertQuoteStillValid(body.quoteAuthority, plan.authority);
  const { profile, recipe, workflow, asset, pin } = plan;
  const controls = {
    enhancement: pin, sourceImageAssetId: sourceMediaId, width: pin.sourceWidth * 2, height: pin.sourceHeight * 2,
    orientation: "original", workflowKey: workflow.workflowKey, workflowVersion: workflow.version, workflowIdentity: workflow.identity,
    generationProfileKey: profile.profileKey, generationProfileVersion: profile.version,
    generationQuoteAuthority: { schemaVersion: "generation-quote-authority-v1", ...plan.authority,
      pricing: { ruleId: plan.pricing.id, ruleKey: plan.pricing.ruleKey, version: plan.pricing.version,
        effectiveFrom: plan.pricing.effectiveFrom?.toISOString() ?? null, fingerprint: plan.authority.pricingFingerprint } },
  };
  return acceptGenerationJobForUser({
    userId,
    identity: options,
    prepare: async (tx) => {
      await lockCharacterMediaAssetAuthorities(tx, [sourceMediaId]);
      const lockedSource = await assertMediaEnhancementSource({ userId, characterId: asset.characterId, controls }, tx);
      if (lockedSource.asset.sourceJobId !== asset.sourceJobId) throw Errors.conflict("Source image provenance changed after the quote");
      // Historical identity/Release/recipe evidence belongs to the source. It is
      // preserved here, not reinterpreted as references for a new character render.
      const sourceGeneration = asset.sourceJob ? {
        jobId: asset.sourceJob.id, profileId: asset.sourceJob.profileId, profileVersion: asset.sourceJob.profileVersion,
        recipeId: asset.sourceJob.recipeId, recipeVersion: asset.sourceJob.recipeVersion,
        visualProfileId: asset.sourceJob.visualProfileId, visualProfileVersion: asset.sourceJob.visualProfileVersion,
        referenceSetRevisionId: asset.sourceJob.referenceSetRevisionId, referenceManifest: asset.sourceJob.referenceManifest,
        legacyReleaseAuthority: jsonRecord(asset.sourceJob.controls).legacyReleaseAuthority ?? null,
        sourceType: asset.sourceJob.sourceType, sourceMeta: asset.sourceJob.sourceMeta,
      } : null;
      return { entitlements: plan.entitlements, data: {
        characterId: asset.characterId, mode: "image", prompt: recipe.body,
        controls: toInputJson(controls), presetIds: [], model: workflow.workflowKey,
        profileId: profile.profileKey, profileVersion: profile.version, recipeId: recipe.recipeKey, recipeVersion: recipe.version,
        orientation: "original", outputCount: 1, costDreamcoins: plan.authority.costDreamcoins,
        provider: profile.runner, sourceType: "media_enhance", sourceId: `${userId}:${idempotencyKey}`,
        sourceMeta: toInputJson({ ...pin, sourceJobId: asset.sourceJobId, sourceGeneration }),
        momentSpec: { schemaVersion: "media-enhancement-v1", requestFingerprint: options.requestFingerprint },
      } };
    },
  });
}
