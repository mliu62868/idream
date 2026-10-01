import { readFile } from "node:fs/promises";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";

describe("Qwen-Image INT8 encoder publication", () => {
  it("refuses to change pins while a legacy unpinned Qwen job is queued", async () => {
    const job = await prisma.generationJob.create({ data: {
      id: "test-qwen21-int8-pending", userId: "seed-dev-user", mode: "image", status: "queued",
      controls: { workflowKey: "redqw21", workflowVersion: 1 }, presetIds: [],
    } });
    const profiles = await prisma.generationModelProfile.findMany({ orderBy: { id: "asc" } });
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    try {
      const sql = await readFile(new URL("../../../db/sql/2026-09-30-qwen21-int8-text-encoder.sql", import.meta.url), "utf8");
      await expect(client.query(sql)).rejects.toThrow("Pending Qwen-Image jobs must finish");
      await client.query("ROLLBACK");
      expect(await prisma.generationModelProfile.findMany({ orderBy: { id: "asc" } })).toEqual(profiles);
    } finally {
      await client.query("ROLLBACK");
      await client.end();
      await prisma.generationJob.delete({ where: { id: job.id } });
    }
  });

  it("preserves image-model, price and historical pins while publishing each encoder route once", async () => {
    const routes = [
      ["redqw21", "redqw21", 2],
      ["qwen-image-edit-img2img", "redqw21-image-edit", 4],
      ["qwen-image-edit-multi-reference", "redqw21-multi-reference", 5],
      ["qwen-image-edit-multi-identity", "redqw21-multi-identity", 4],
    ] as const;
    const prefix = "test-qwen21-int8-";
    const retired = [];
    for (const [workflowKey, pipelineModel, workflowVersion] of routes) {
      retired.push(await prisma.generationModelProfile.create({ data: {
        id: `${prefix}${workflowKey}-old`, profileKey: `${prefix}${workflowKey}`, label: "Controlled Qwen route",
        mode: "image", runner: "comfyui", pipelineModel, workflowKey, version: 7, status: "active",
        sourceModelPath: "/models/diffusion.safetensors", convertedModelPath: null,
        runnerConfig: { workflowVersion: workflowVersion - 1, textEncoderPath: "/models/qwen3vl_8b_bf16.safetensors",
          diffusionModelPath: "/models/diffusion.safetensors", publicSelection: { surface: "generator_image_edit" },
          capabilities: { referenceImages: true } },
        allowedOrientations: ["4:5"], costMultiplier: 1.75, maxCount: 2, rolloutPercent: 50,
        steps: 13, sampler: "euler", scheduler: "simple", cfgScale: 1.5,
      } }));
    }
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    try {
      const sql = await readFile(new URL("../../../db/sql/2026-09-30-qwen21-int8-text-encoder.sql", import.meta.url), "utf8");
      await client.query(sql);
      for (const [index, [, pipelineModel, workflowVersion]] of routes.entries()) {
        const old = retired[index];
        const published = await prisma.generationModelProfile.findFirstOrThrow({ where: { profileKey: old.profileKey, status: "active" } });
        expect(published).toMatchObject({ version: 8, pipelineModel, sourceModelPath: old.sourceModelPath,
          steps: 13, cfgScale: 1.5, costMultiplier: 1.75, maxCount: 2, rolloutPercent: 50,
          runnerConfig: expect.objectContaining({ workflowVersion, textEncoderDevice: "cpu", textEncoderPrecision: "int8_convrot",
            textEncoderPath: "/Users/kk/ComfyUI-Shared/models/text_encoders/qwen3vl_8b_int8_convrot.safetensors",
            textEncoderSha256: "8bfd0f6e12abf2d2d697ecc888e5e90b0d6741d6708f05799f53afa560452e8f",
            diffusionModelPath: "/models/diffusion.safetensors", publicSelection: { surface: "generator_image_edit" },
            capabilities: { referenceImages: true } }),
        });
        expect(await prisma.generationModelProfile.findUniqueOrThrow({ where: { id: old.id } })).toMatchObject({
          status: "archived", version: 7, pipelineModel: old.pipelineModel, runnerConfig: old.runnerConfig,
          sourceModelPath: old.sourceModelPath, steps: old.steps, cfgScale: old.cfgScale, createdAt: old.createdAt,
        });
      }
      const published = await prisma.generationModelProfile.findMany({ where: { profileKey: { startsWith: prefix } }, orderBy: { id: "asc" } });
      await client.query(sql);
      expect(await prisma.generationModelProfile.findMany({ where: { profileKey: { startsWith: prefix } }, orderBy: { id: "asc" } })).toEqual(published);
    } finally {
      await client.end();
      await prisma.generationModelProfile.deleteMany({ where: { profileKey: { startsWith: prefix } } });
    }
  });
});
