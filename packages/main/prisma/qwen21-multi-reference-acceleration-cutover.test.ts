import type pg from "pg";
import { describe, expect, it } from "vitest";
import {
  createHistoricalJob, createHistoricalProfile, expectHistoricalCutoverRejected,
  historicalCutoverSql, historicalProfiles, withHistoricalImageCatalog,
} from "./historical-image-cutover-fixtures";

const sql = await historicalCutoverSql(new URL("../../../db/sql/2026-10-03-qwen21-multi-reference-acceleration.sql", import.meta.url));
const encoderPath = "/Users/kk/ComfyUI-Shared/models/text_encoders/qwen3vl_8b_int8_convrot.safetensors";
const encoderSha = "8bfd0f6e12abf2d2d697ecc888e5e90b0d6741d6708f05799f53afa560452e8f";
const loraSha = "0c98591700346f9777051d4e6fa29aa94519abec0d85b1f1f672a2a3db8c94b3";
const prefix = "test-qwen21-multi-turbo-";
const routes = [
  ["qwen-image-edit-multi-reference", "redqw21-multi-reference", 6],
  ["qwen-image-edit-multi-identity", "redqw21-multi-identity", 5],
] as const;

async function createPreviousProfile(client: pg.Client, index: number, overrides = {}) {
  const [workflowKey, pipelineModel, workflowVersion] = routes[index];
  return createHistoricalProfile(client, {
    id: `${prefix}${workflowKey}-old`, profileKey: `${prefix}${workflowKey}`, label: "Controlled multi-reference cutover",
    mode: "image", runner: "comfyui", pipelineModel, workflowKey, version: 8, status: "active",
    sourceModelPath: "/models/source.safetensors", convertedModelPath: "/models/bf16.safetensors", modelFormat: "safetensors",
    runnerConfig: { workflowVersion, civitaiVersionId: 3370753, textEncoderPath: encoderPath,
      textEncoderSha256: encoderSha, textEncoderDevice: "cpu", vaeTemporalPadding: "torch_cat",
      publicSelection: { surface: "generator_image_edit" }, capabilities: { referenceImages: true, lora: false }, ...overrides },
    defaultWidth: 832, defaultHeight: 1216, allowedOrientations: ["4:5", "16:9"],
    steps: 16, sampler: "euler", scheduler: "simple", cfgScale: 2,
    costMultiplier: 1.75, maxCount: 2, concurrencyLimit: 1, rolloutPercent: 50,
  });
}

describe("Qwen 2.1 multi-reference acceleration publication", () => {
  it.each([
    { model: "redqw21-multi-reference" },
    { profileId: "character-image-multi-identity" },
    { profileId: "seed-profile-character-image-variation-v1" },
    { controls: { workflowKey: "qwen-image-edit-multi-identity" } },
  ])("refuses publication while a multi-reference job is queued (%j)", async (pin) => withHistoricalImageCatalog(async (client) => {
    for (const [index, key, id] of [
      [0, "character-image-variation", "seed-profile-character-image-variation-v1"],
      [1, "character-image-multi-identity", "test-historical-multi-identity"],
    ] as const) {
      const previous = await createPreviousProfile(client, index);
      await client.query('UPDATE generation_model_profiles SET id = $1, "profileKey" = $2 WHERE id = $3', [id, key, previous.id]);
    }
    await createHistoricalJob(client, {
      id: `${prefix}pending`, userId: "seed-dev-user", mode: "image", status: "queued", controls: {}, presetIds: [], ...pin,
    });
    await expectHistoricalCutoverRejected(client, sql, "Pending multi-reference jobs must finish");
  }));

  it("publishes both six-step routes while retaining reference, size, price and historical pins", async () => withHistoricalImageCatalog(async (client) => {
    const previous = [await createPreviousProfile(client, 0), await createPreviousProfile(client, 1)];
    for (const [workflowKey, pipelineModel, workflowVersion] of [
      ["redqw21", "redqw21", 3], ["qwen-image-edit-img2img", "redqw21-image-edit", 5],
    ] as const) {
      const singleEdit = workflowKey === "qwen-image-edit-img2img";
      await createHistoricalProfile(client, {
        id: `untouched-${workflowKey}`, profileKey: `untouched-${workflowKey}`, label: "Previously accelerated route",
        pipelineModel, workflowKey, steps: singleEdit ? 6 : 10, cfgScale: 1, sampler: "euler",
        scheduler: singleEdit ? "viggle_turbo" : "simple",
        runnerConfig: { workflowVersion, civitaiVersionId: singleEdit ? 3370753 : 3353689,
          textEncoderPath: encoderPath, textEncoderSha256: encoderSha, textEncoderDevice: singleEdit ? "mps" : "cpu",
          vaeTemporalPadding: "torch_cat", capabilities: { lora: singleEdit },
          ...(singleEdit ? { conditioningPasses: 1,
            turboLora: { sha256: loraSha, rank: 128, alpha: 128, strength: 1, unmerged: true } } : {}),
        },
      });
    }
    const untouched = (await historicalProfiles(client)).filter((profile) => profile.id.startsWith("untouched-"));
    const pinnedJob = await createHistoricalJob(client, {
      id: `${prefix}historical`, userId: "seed-dev-user", mode: "image", status: "completed",
      profileId: previous[0].id, profileVersion: previous[0].version,
      controls: { workflowKey: routes[0][0], workflowVersion: routes[0][2] }, presetIds: [],
    });
    await client.query(sql);
    const after = await historicalProfiles(client);
    for (const [index, [workflowKey, pipelineModel, workflowVersion]] of routes.entries()) {
      const old = previous[index];
      const published = after.find((profile) => profile.profileKey === old.profileKey && profile.status === "active");
      expect(published).toMatchObject({ version: 9, pipelineModel, workflowKey,
        sourceModelPath: old.sourceModelPath, convertedModelPath: old.convertedModelPath,
        steps: 6, cfgScale: 1, sampler: "euler", scheduler: "viggle_turbo",
        defaultWidth: 832, defaultHeight: 1216, allowedOrientations: ["4:5", "16:9"],
        costMultiplier: 1.75, maxCount: 2, concurrencyLimit: 1, rolloutPercent: 50,
        runnerConfig: expect.objectContaining({ workflowVersion: workflowVersion + 1,
          textEncoderPath: encoderPath, textEncoderSha256: encoderSha,
          textEncoderDevice: "mps", vaeTemporalPadding: "torch_cat", conditioningPasses: 1,
          publicSelection: { surface: "generator_image_edit" }, capabilities: { referenceImages: true, lora: true },
          turboLora: expect.objectContaining({ sha256: loraSha, rank: 128, alpha: 128, strength: 1, unmerged: true }),
        }),
      });
      expect(after.find((profile) => profile.id === old.id)).toMatchObject({
        status: "archived", version: 8, runnerConfig: old.runnerConfig, steps: 16, cfgScale: 2,
        publishedAt: old.publishedAt, createdAt: old.createdAt,
      });
    }
    expect((await client.query("SELECT * FROM generation_jobs WHERE id = $1", [pinnedJob.id])).rows[0]).toEqual(pinnedJob);
    await client.query(sql);
    for (const name of ["2026-10-01-qwen21-mac-acceleration", "2026-09-30-qwen21-int8-text-encoder", "2026-09-30-redqw21-v2-image-edit-retire-rapid-aio"]) {
      await client.query(await historicalCutoverSql(new URL(`../../../db/sql/${name}.sql`, import.meta.url)));
    }
    expect(await historicalProfiles(client)).toEqual(after);
    expect((await historicalProfiles(client)).filter((profile) => profile.id.startsWith("untouched-"))).toEqual(untouched);
  }));

  it.each([{ workflowVersion: 4 }, { civitaiVersionId: 3353689 }, { textEncoderSha256: "wrong-weight" }])("rejects unverified prior configurations (%j)", async (overrides) => withHistoricalImageCatalog(async (client) => {
    await createPreviousProfile(client, 0, overrides);
    await expectHistoricalCutoverRejected(client, sql, "Publish verified REDQW21 V2");
  }));

  it("retains a later authoritative publication", async () => withHistoricalImageCatalog(async (client) => {
    await createPreviousProfile(client, 1, { workflowVersion: 20 });
    const before = await historicalProfiles(client);
    await client.query(sql);
    expect(await historicalProfiles(client)).toEqual(before);
  }));
});
