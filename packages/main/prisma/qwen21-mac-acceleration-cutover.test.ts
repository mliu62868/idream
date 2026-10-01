import { readFile } from "node:fs/promises";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";

const sqlUrl = new URL("../../../db/sql/2026-10-01-qwen21-mac-acceleration.sql", import.meta.url);
const encoderPath = "/Users/kk/ComfyUI-Shared/models/text_encoders/qwen3vl_8b_int8_convrot.safetensors";
const encoderSha = "8bfd0f6e12abf2d2d697ecc888e5e90b0d6741d6708f05799f53afa560452e8f";
const loraSha = "0c98591700346f9777051d4e6fa29aa94519abec0d85b1f1f672a2a3db8c94b3";

describe("Qwen 2.1 Mac acceleration publication", () => {
  it.each([{ model: "redqw21-image-edit" }, { profileId: "chat-image-edit" }])("refuses to replace pins while a legacy edit is queued (%j)", async (pin) => {
    const job = await prisma.generationJob.create({ data: {
      id: "test-qwen21-mac-pending", userId: "seed-dev-user", mode: "image", status: "queued",
      ...pin, controls: {}, presetIds: [],
    } });
    const before = await prisma.generationModelProfile.findMany({ orderBy: { id: "asc" } });
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    try {
      await expect(client.query(await readFile(sqlUrl, "utf8"))).rejects.toThrow("Pending Qwen-Image jobs must finish");
      await client.query("ROLLBACK");
      expect(await prisma.generationModelProfile.findMany({ orderBy: { id: "asc" } })).toEqual(before);
    } finally {
      await client.query("ROLLBACK");
      await client.end();
      await prisma.generationJob.delete({ where: { id: job.id } });
    }
  });

  it("publishes six-step single edits, preserves multi-reference controls and history, and prevents historical downgrades", async () => {
    const routes = [
      ["redqw21", "redqw21", 2, 10, 1],
      ["qwen-image-edit-img2img", "redqw21-image-edit", 4, 10, 1],
      ["qwen-image-edit-multi-reference", "redqw21-multi-reference", 5, 16, 2],
      ["qwen-image-edit-multi-identity", "redqw21-multi-identity", 4, 16, 2],
    ] as const;
    const prefix = "test-qwen21-mac-";
    const previous = [];
    for (const [workflowKey, pipelineModel, workflowVersion, steps, cfgScale] of routes) {
      previous.push(await prisma.generationModelProfile.create({ data: {
        id: `${prefix}${workflowKey}-old`, profileKey: `${prefix}${workflowKey}`, label: "Controlled Mac cutover",
        mode: "image", runner: "comfyui", pipelineModel, workflowKey, version: 7, status: "active",
        sourceModelPath: "/models/source.safetensors", convertedModelPath: "/models/bf16.safetensors",
        runnerConfig: { workflowVersion, civitaiVersionId: workflowKey === "redqw21" ? 3353689 : 3370753,
          textEncoderPath: encoderPath, textEncoderSha256: encoderSha, textEncoderDevice: "cpu",
          publicSelection: { surface: "generator_image_edit" }, capabilities: { referenceImages: true, lora: false } },
        allowedOrientations: ["4:5"], costMultiplier: 1.75, maxCount: 2, rolloutPercent: 50,
        steps, sampler: "euler", scheduler: "simple", cfgScale,
      } }));
    }
    const pinnedJob = await prisma.generationJob.create({ data: {
      id: `${prefix}historical-job`, userId: "seed-dev-user", mode: "image", status: "completed",
      profileId: previous[1].id, profileVersion: 7, controls: { workflowKey: routes[1][0], workflowVersion: 4 }, presetIds: [],
    } });
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    try {
      const sql = await readFile(sqlUrl, "utf8");
      await client.query(sql);
      for (const [index, [workflowKey, pipelineModel, workflowVersion, steps, cfgScale]] of routes.entries()) {
        const old = previous[index];
        const single = workflowKey === "qwen-image-edit-img2img";
        const published = await prisma.generationModelProfile.findFirstOrThrow({ where: { profileKey: old.profileKey, status: "active" } });
        expect(published).toMatchObject({ version: 8, pipelineModel,
          sourceModelPath: old.sourceModelPath, convertedModelPath: old.convertedModelPath,
          steps: single ? 6 : steps, cfgScale, scheduler: single ? "viggle_turbo" : "simple",
          costMultiplier: 1.75, maxCount: 2, rolloutPercent: 50,
          runnerConfig: expect.objectContaining({ workflowVersion: workflowVersion + 1,
            textEncoderPath: encoderPath, textEncoderSha256: encoderSha,
            textEncoderDevice: single ? "mps" : "cpu", vaeTemporalPadding: "torch_cat",
            publicSelection: { surface: "generator_image_edit" }, capabilities: { referenceImages: true, lora: single },
          }),
        });
        if (single) expect(published.runnerConfig).toMatchObject({ conditioningPasses: 1,
          turboLora: expect.objectContaining({ sha256: loraSha, rank: 128, alpha: 128, strength: 1, unmerged: true }),
        });
        expect(await prisma.generationModelProfile.findUniqueOrThrow({ where: { id: old.id } })).toMatchObject({
          status: "archived", version: 7, runnerConfig: old.runnerConfig, steps: old.steps, createdAt: old.createdAt,
        });
      }
      expect(await prisma.generationJob.findUniqueOrThrow({ where: { id: pinnedJob.id } })).toEqual(pinnedJob);
      const published = await prisma.generationModelProfile.findMany({ where: { profileKey: { startsWith: prefix } }, orderBy: { id: "asc" } });
      await client.query(sql);
      await client.query(await readFile(new URL("../../../db/sql/2026-09-30-qwen21-int8-text-encoder.sql", import.meta.url), "utf8"));
      await client.query(await readFile(new URL("../../../db/sql/2026-09-30-redqw21-v2-image-edit-retire-rapid-aio.sql", import.meta.url), "utf8"));
      expect(await prisma.generationModelProfile.findMany({ where: { profileKey: { startsWith: prefix } }, orderBy: { id: "asc" } })).toEqual(published);
    } finally {
      await client.query("ROLLBACK");
      await client.end();
      await prisma.generationJob.delete({ where: { id: pinnedJob.id } });
      await prisma.generationModelProfile.deleteMany({ where: { profileKey: { startsWith: prefix } } });
    }
  });
});
