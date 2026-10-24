import { describe, expect, it } from "vitest";
import {
  createHistoricalJob, createHistoricalProfile, expectHistoricalCutoverRejected,
  historicalCutoverSql, historicalProfiles, withHistoricalImageCatalog,
} from "./historical-image-cutover-fixtures";

const sql = await historicalCutoverSql(new URL("../../../db/sql/2026-09-30-qwen21-int8-text-encoder.sql", import.meta.url));

describe("Qwen-Image INT8 encoder publication", () => {
  it("refuses to change pins while a legacy unpinned Qwen job is queued", async () => withHistoricalImageCatalog(async (client) => {
    await createHistoricalProfile(client, {
      id: "historical-redqw21-before-int8", profileKey: "historical-redqw21", label: "Historical BF16 encoder route",
      pipelineModel: "redqw21", workflowKey: "redqw21", version: 7,
      runnerConfig: { workflowVersion: 1, textEncoderPath: "/models/qwen3vl_8b_bf16.safetensors" },
    });
    await createHistoricalJob(client, {
      id: "test-qwen21-int8-pending", userId: "seed-dev-user", mode: "image", status: "queued",
      controls: { workflowKey: "redqw21", workflowVersion: 1 }, presetIds: [],
    });
    await expectHistoricalCutoverRejected(client, sql, "Pending Qwen-Image jobs must finish");
  }));

  it("preserves image-model, price and historical pins while publishing each encoder route once", async () => withHistoricalImageCatalog(async (client) => {
    const routes = [
      ["redqw21", "redqw21", 2],
      ["qwen-image-edit-img2img", "redqw21-image-edit", 4],
      ["qwen-image-edit-multi-reference", "redqw21-multi-reference", 5],
      ["qwen-image-edit-multi-identity", "redqw21-multi-identity", 4],
    ] as const;
    const prefix = "test-qwen21-int8-";
    const retired = [];
    for (const [workflowKey, pipelineModel, workflowVersion] of routes) {
      retired.push(await createHistoricalProfile(client, {
        id: `${prefix}${workflowKey}-old`, profileKey: `${prefix}${workflowKey}`, label: "Controlled Qwen route",
        mode: "image", runner: "comfyui", pipelineModel, workflowKey, version: 7, status: "active",
        sourceModelPath: "/models/diffusion.safetensors", convertedModelPath: null,
        runnerConfig: { workflowVersion: workflowVersion - 1, textEncoderPath: "/models/qwen3vl_8b_bf16.safetensors",
          diffusionModelPath: "/models/diffusion.safetensors", publicSelection: { surface: "generator_image_edit" },
          capabilities: { referenceImages: true } },
        allowedOrientations: ["4:5"], costMultiplier: 1.75, maxCount: 2, rolloutPercent: 50,
        steps: 13, sampler: "euler", scheduler: "simple", cfgScale: 1.5,
      }));
    }
    await client.query(sql);
    const after = await historicalProfiles(client);
    for (const [index, [, pipelineModel, workflowVersion]] of routes.entries()) {
      const old = retired[index];
      const published = after.find((profile) => profile.profileKey === old.profileKey && profile.status === "active");
      expect(published).toMatchObject({ version: 8, pipelineModel, sourceModelPath: old.sourceModelPath,
        steps: 13, cfgScale: 1.5, costMultiplier: 1.75, maxCount: 2, rolloutPercent: 50,
        runnerConfig: expect.objectContaining({ workflowVersion, textEncoderDevice: "cpu", textEncoderPrecision: "int8_convrot",
          textEncoderPath: "/Users/kk/ComfyUI-Shared/models/text_encoders/qwen3vl_8b_int8_convrot.safetensors",
          textEncoderSha256: "8bfd0f6e12abf2d2d697ecc888e5e90b0d6741d6708f05799f53afa560452e8f",
          diffusionModelPath: "/models/diffusion.safetensors", publicSelection: { surface: "generator_image_edit" },
          capabilities: { referenceImages: true } }),
      });
      expect(after.find((profile) => profile.id === old.id)).toMatchObject({
        status: "archived", version: 7, pipelineModel: old.pipelineModel, runnerConfig: old.runnerConfig,
        sourceModelPath: old.sourceModelPath, steps: old.steps, cfgScale: old.cfgScale, createdAt: old.createdAt,
      });
    }
    await client.query(sql);
    expect(await historicalProfiles(client)).toEqual(after);
  }));
});
