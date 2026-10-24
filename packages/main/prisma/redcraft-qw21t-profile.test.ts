import type pg from "pg";
import { describe, expect, it } from "vitest";
import { selectGenerationProfile } from "@/server/modules/ourdream/generation-profile-selection";
import {
  createHistoricalJob, createHistoricalProfile, expectHistoricalCutoverRejected,
  historicalCutoverSql, historicalProfiles as profiles, withHistoricalImageCatalog,
} from "./historical-image-cutover-fixtures";

const profileKey = "image-redcraft-qw21t";
const defaultKey = "profile_image_default_v1";
const sql = await historicalCutoverSql(new URL("../../../db/sql/2026-10-21-redcraft-default-image-profile.sql", import.meta.url));
const modelRoot = "/Users/kk/ComfyUI-Shared/models";
const workflowRoot = "/Users/kk/code/idream/packages/gen/workflows";
// Release-era inputs are explicit: current seed intentionally no longer offers
// this optional profile or the REDQW21 premium/default routes.
const releasedConfig = {
  apiModelId: "redcraft-qw21t", baseModel: "Qwen-Image 2.1",
  civitaiModelId: 958009, civitaiVersionId: 3407259, civitaiFileId: 3299030,
  diffusionModelPath: `${modelRoot}/diffusion_models/fineview_qw21_turbo_fixed_int8.safetensors`,
  diffusionModelSha256: "712b44d2a79b30ed1aa11f19fc4e2cd0f1f46a43dc3bde5d6fe2a07e36b68f0f",
  textEncoderPath: `${modelRoot}/text_encoders/qwen3vl_8b_int8_convrot.safetensors`,
  textEncoderSha256: "8bfd0f6e12abf2d2d697ecc888e5e90b0d6741d6708f05799f53afa560452e8f",
  textEncoderRepository: "Comfy-Org/Qwen-Image-2.1",
  textEncoderRevision: "cb504a4090723e43f17ad01cec0359490e2de613",
  textEncoderPrecision: "int8_convrot", textEncoderDevice: "mps", conditioningPasses: 1,
  vaePath: `${modelRoot}/vae/texture_fix_vae_for_qwen_image_2.1_bf16.safetensors`,
  vaeSha256: "36f56608b02077a50a08ea3dbcdb88351298ceba49948f41f9f87186378e6908",
  vaeTemporalPadding: "torch_cat", workflowVersion: 3,
  workflowPath: `${workflowRoot}/redcraft-qw21t.json`, precisionPolicy: "int8_exact_bf16_resident_mps",
  publicSelection: { surface: "generator_image_edit", explicitOnly: true },
  capabilities: { textToImage: true, stableSeed: true, referenceImages: true, initImage: true, lora: false },
};
const previousDefaultConfig = {
  apiModelId: "redqw21", baseModel: "Qwen-Image 2.1", civitaiModelId: 452459, civitaiVersionId: 3353689,
  diffusionModelPath: `${modelRoot}/diffusion_models/redqw21_bf16.safetensors`,
  diffusionModelSha256: "9830a9925759a4b69ea1346133d08917ec2390b8495ea7f0eb613f37e7c46647",
  textEncoderPath: releasedConfig.textEncoderPath, textEncoderSha256: releasedConfig.textEncoderSha256,
  textEncoderRepository: releasedConfig.textEncoderRepository, textEncoderRevision: releasedConfig.textEncoderRevision,
  textEncoderPrecision: "int8_convrot", textEncoderDevice: "cpu", vaeTemporalPadding: "torch_cat",
  vaePath: `${modelRoot}/vae/qwen_image_2.1_vae_bf16.safetensors`,
  workflowPath: `${workflowRoot}/redqw21.json`, workflowVersion: 3, precisionPolicy: "bf16_resident_mps",
  capabilities: { textToImage: true, stableSeed: true, referenceImages: true, initImage: false, lora: false },
};

async function prepareHistoricalCatalog(client: pg.Client, beforePublication = false) {
  const common = {
    label: "Historical image profile", sourceModelPath: releasedConfig.diffusionModelPath,
    convertedModelPath: null, modelFormat: "safetensors", defaultWidth: 832, defaultHeight: 1024,
    steps: 6, sampler: "er_sde", scheduler: "simple", cfgScale: 1,
    maxCount: 1, concurrencyLimit: 1, enabled: true, rolloutPercent: 100,
  };
  await createHistoricalProfile(client, {
    ...common, id: "historical-default-image", profileKey: defaultKey,
    pipelineModel: beforePublication ? "redqw21" : "redcraft-qw21t",
    workflowKey: beforePublication ? "redqw21" : "redcraft-qw21t",
    version: beforePublication ? 6 : 7, costMultiplier: 1,
    allowedOrientations: ["1:1", "4:5", "3:4", "9:16", "16:9"],
    ...(beforePublication ? {
      sourceModelPath: previousDefaultConfig.diffusionModelPath, defaultWidth: 512, defaultHeight: 512,
      steps: 10, sampler: "euler", runnerConfig: previousDefaultConfig,
    } : { runnerConfig: { ...releasedConfig, publicSelection: { surface: "generator_image_edit" } } }),
  });
  await createHistoricalProfile(client, {
    ...common, id: "historical-optional-redcraft", profileKey, pipelineModel: "redcraft-qw21t", workflowKey: "redcraft-qw21t",
    version: beforePublication ? 2 : 3, steps: beforePublication ? 8 : 6, costMultiplier: 1.5,
    runnerConfig: { ...releasedConfig, workflowVersion: beforePublication ? 2 : 3 },
  });
  await createHistoricalProfile(client, {
    ...common, id: "historical-premium-image", profileKey: "profile_image_premium_v1", version: 4,
    pipelineModel: "redqw21", workflowKey: "redqw21", runnerConfig: previousDefaultConfig,
    sourceModelPath: previousDefaultConfig.diffusionModelPath, steps: 10, sampler: "euler",
    costMultiplier: 1.5, requiredEntitlement: "premium_models", maxCount: 4,
  });
}

async function expectRejected(client: pg.Client, message: string) {
  await expectHistoricalCutoverRejected(client, sql, message);
}

describe("RedCraft / FineView default image publication", () => {
  it("routes text, single identity and source-only edits to six steps without losing multi-reference authority", async () => {
    const expected = {
      profileKey: defaultKey, pipelineModel: "redcraft-qw21t", workflowKey: "redcraft-qw21t",
      steps: 6, sampler: "er_sde", scheduler: "simple", cfgScale: 1,
      costMultiplier: 1, requiredEntitlement: null,
      runnerConfig: expect.objectContaining({ workflowVersion: 3, publicSelection: { surface: "generator_image_edit" } }),
    };
    const single = [{ assetId: "adult-face-a", role: "identity_anchor" as const }];
    const empty = { pinnedReferences: [], sourceImageAssetId: null, lookReferenceAssetId: null };
    await expect(selectGenerationProfile({ mode: "image", catalogScope: "public_text_to_image", referenceRequirements: empty, accessibleEntitlements: {} })).resolves.toMatchObject(expected);
    await expect(selectGenerationProfile({ mode: "image", catalogScope: "public_character_image", referenceRequirements: { ...empty, pinnedReferences: single }, accessibleEntitlements: {} })).resolves.toMatchObject(expected);
    await expect(selectGenerationProfile({ mode: "image", catalogScope: "public_image_edit", referenceRequirements: { ...empty, sourceImageAssetId: "source" }, accessibleEntitlements: {} })).resolves.toMatchObject(expected);
    await expect(selectGenerationProfile({ mode: "image", referenceRequirements: { ...empty, pinnedReferences: [...single, { assetId: "adult-face-b", role: "identity_reference" }] }, accessibleEntitlements: {} })).resolves.toMatchObject({ workflowKey: "qwen-image-edit-multi-identity" });
    await expect(selectGenerationProfile({ mode: "image", referenceRequirements: { ...empty, pinnedReferences: single, sourceImageAssetId: "source" }, accessibleEntitlements: {} })).resolves.toMatchObject({ workflowKey: "qwen-image-edit-multi-reference" });
    await expect(selectGenerationProfile({ mode: "image", requested: "chat-image-edit", referenceRequirements: { ...empty, sourceImageAssetId: "source" } })).resolves.toMatchObject({ profileKey: "chat-image-edit", pipelineModel: "redcraft-image-edit" });
  });

  it("publishes fresh optional profiles, matches the historical release pins, and replays without any writes", async () => withHistoricalImageCatalog(async (client) => {
    await prepareHistoricalCatalog(client);
    const before = await profiles(client);
    await client.query('DELETE FROM generation_model_profiles WHERE "profileKey" = $1', [profileKey]);
    await client.query(sql);
    const after = await profiles(client);
    expect(after.find((p) => p.profileKey === profileKey)).toMatchObject({
      version: 3, steps: 6, sampler: "er_sde", scheduler: "simple", runnerConfig: releasedConfig,
    });
    expect(after.filter((p) => p.profileKey !== profileKey)).toEqual(before.filter((p) => p.profileKey !== profileKey));
    await client.query(sql);
    expect(await profiles(client)).toEqual(after);
    await client.query('UPDATE generation_model_profiles SET "pipelineModel" = \'unexpected\' WHERE "profileKey" = $1', [profileKey]);
    await expectRejected(client, "differs from the exact released configuration");
  }));

  it("archives eight-step and prior default recipes, preserves billing/history, and refuses pending or conflicting cutovers", async () => withHistoricalImageCatalog(async (client) => {
    await prepareHistoricalCatalog(client, true);
    const job = await createHistoricalJob(client, {
      id: "test-redcraft-pinned-job", userId: "seed-dev-user", mode: "image", status: "queued",
      profileId: profileKey, profileVersion: 2, controls: { workflowKey: "redcraft-qw21t", workflowVersion: 2 }, presetIds: [],
    });
    const old = await profiles(client);
    await expectRejected(client, "Pending RedCraft jobs must finish");
    await client.query("UPDATE generation_jobs SET status = 'completed' WHERE id = $1", [job.id]);
    const historicalJob = (await client.query("SELECT * FROM generation_jobs WHERE id = $1", [job.id])).rows[0];
    await client.query('UPDATE generation_model_profiles SET "costMultiplier" = 2 WHERE "profileKey" = $1', [profileKey]);
    await expectRejected(client, "differs from the exact released configuration");
    await client.query('UPDATE generation_model_profiles SET "costMultiplier" = 1.5 WHERE "profileKey" = $1', [profileKey]);
    await client.query(sql);
    const after = await profiles(client);
    for (const key of [profileKey, defaultKey]) {
      const previous = old.find((p) => p.profileKey === key);
      expect(after.find((p) => p.id === previous?.id)).toEqual({ ...previous, status: "archived", archivedAt: expect.any(Date), updatedAt: expect.any(Date) });
    }
    const current = after.find((p) => p.profileKey === defaultKey && p.status === "active");
    const previous = old.find((p) => p.profileKey === defaultKey);
    expect(current).toMatchObject({ version: 7, steps: 6, pipelineModel: "redcraft-qw21t", costMultiplier: previous?.costMultiplier, allowedOrientations: previous?.allowedOrientations, maxCount: previous?.maxCount, requiredEntitlement: previous?.requiredEntitlement });
    expect((await client.query("SELECT * FROM generation_jobs WHERE id = $1", [job.id])).rows[0]).toEqual(historicalJob);
    expect(after.filter((p) => ![profileKey, defaultKey].includes(p.profileKey))).toEqual(old.filter((p) => ![profileKey, defaultKey].includes(p.profileKey)));
    await client.query(sql);
    expect(await profiles(client)).toEqual(after);
  }));

  it("inherits one deployment directory while rejecting per-profile path drift", async () => withHistoricalImageCatalog(async (client) => {
    await prepareHistoricalCatalog(client);
    const deploymentPath = "/srv/idream deployment/packages/gen/workflows/redcraft-qw21t.json";
    await client.query(`UPDATE generation_model_profiles SET "runnerConfig" = jsonb_set("runnerConfig", '{workflowPath}', to_jsonb($1::text))
      WHERE "profileKey" IN ($2, $3)`, [deploymentPath, profileKey, defaultKey]);
    const before = await profiles(client);
    await client.query(sql);
    expect(await profiles(client)).toEqual(before);

    await client.query(`UPDATE generation_model_profiles SET "runnerConfig" = jsonb_set("runnerConfig", '{workflowPath}', to_jsonb($1::text))
      WHERE "profileKey" = $2`, ["/srv/other/packages/gen/workflows/redcraft-qw21t.json", profileKey]);
    await expectRejected(client, "differs from the exact released configuration");
    await client.query(`UPDATE generation_model_profiles SET "runnerConfig" = jsonb_set("runnerConfig", '{workflowPath}', to_jsonb($1::text))
      WHERE "profileKey" = $2`, [deploymentPath, profileKey]);
    for (const invalidPath of ["packages/gen/workflows/redcraft-qw21t.json", "/srv/../packages/gen/workflows/redcraft-qw21t.json", "/srv/app/packages/gen/workflows/other.json"]) {
      await client.query(`UPDATE generation_model_profiles SET "runnerConfig" = jsonb_set("runnerConfig", '{workflowPath}', to_jsonb($1::text))
        WHERE "profileKey" = $2`, [invalidPath, defaultKey]);
      await expectRejected(client, "invalid workflow path");
    }
  }));
});
