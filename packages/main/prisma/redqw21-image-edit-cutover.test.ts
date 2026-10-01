import { readFile } from "node:fs/promises";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";

describe("REDQW21 V2 image-edit cutover", () => {
  it("publishes a new profile, preserves the retired version and is idempotent", async () => {
    const profileKey = "test-redqw21-retirement";
    const retired = await prisma.generationModelProfile.create({ data: {
      id: `${profileKey}-old`, profileKey, label: "Edit (Qwen-Edit)",
      mode: "image", runner: "comfyui", pipelineModel: "qwen-image-edit",
      workflowKey: "qwen-image-edit-img2img", version: 7, status: "active",
      sourceModelPath: "/models/Qwen-Rapid-AIO-NSFW-v19.safetensors",
      runnerConfig: { workflowVersion: 2, publicSelection: { surface: "generator_image_edit" }, capabilities: { initImage: true } },
      allowedOrientations: ["4:5"], costMultiplier: 1.75, maxCount: 2,
      steps: 4, sampler: "sa_solver", scheduler: "beta", cfgScale: 1,
    } });
    const sql = await readFile(new URL("../../../db/sql/2026-09-30-redqw21-v2-image-edit-retire-rapid-aio.sql", import.meta.url), "utf8");
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    try {
      await client.query(sql);
      const published = await prisma.generationModelProfile.findFirstOrThrow({ where: { profileKey, status: "active" } });
      expect(published).toMatchObject({
        version: 8, pipelineModel: "redqw21-image-edit", steps: 10, sampler: "euler", scheduler: "simple",
        costMultiplier: 1.75, maxCount: 2, allowedOrientations: ["4:5"],
        runnerConfig: expect.objectContaining({ workflowVersion: 3, civitaiVersionId: 3370753, civitaiFileId: 3258921,
          publicSelection: { surface: "generator_image_edit" }, capabilities: { initImage: true } }),
      });
      const historical = await prisma.generationModelProfile.findUniqueOrThrow({ where: { id: retired.id } });
      expect(historical).toMatchObject({
        status: "archived", pipelineModel: retired.pipelineModel, workflowKey: retired.workflowKey,
        sourceModelPath: retired.sourceModelPath, version: retired.version,
        runnerConfig: retired.runnerConfig, steps: retired.steps, createdAt: retired.createdAt,
      });
      await client.query(sql);
      expect(await prisma.generationModelProfile.count({ where: { profileKey } })).toBe(2);
      expect(await prisma.generationModelProfile.findFirstOrThrow({ where: { profileKey, status: "active" } })).toEqual(published);
    } finally {
      await client.end();
      await prisma.generationModelProfile.deleteMany({ where: { profileKey } });
    }
  });
});
