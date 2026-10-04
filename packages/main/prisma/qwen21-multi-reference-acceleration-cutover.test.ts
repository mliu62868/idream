import { readFile } from "node:fs/promises";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";

const sqlUrl = new URL("../../../db/sql/2026-10-03-qwen21-multi-reference-acceleration.sql", import.meta.url);
const encoderPath = "/Users/kk/ComfyUI-Shared/models/text_encoders/qwen3vl_8b_int8_convrot.safetensors";
const encoderSha = "8bfd0f6e12abf2d2d697ecc888e5e90b0d6741d6708f05799f53afa560452e8f";
const loraSha = "0c98591700346f9777051d4e6fa29aa94519abec0d85b1f1f672a2a3db8c94b3";
const prefix = "test-qwen21-multi-turbo-";
const routes = [
  ["qwen-image-edit-multi-reference", "redqw21-multi-reference", 6],
  ["qwen-image-edit-multi-identity", "redqw21-multi-identity", 5],
] as const;

async function createPreviousProfile(index: number, overrides = {}) {
  const [workflowKey, pipelineModel, workflowVersion] = routes[index];
  return prisma.generationModelProfile.create({ data: {
    id: `${prefix}${workflowKey}-old`, profileKey: `${prefix}${workflowKey}`, label: "Controlled multi-reference cutover",
    mode: "image", runner: "comfyui", pipelineModel, workflowKey, version: 8, status: "active",
    sourceModelPath: "/models/source.safetensors", convertedModelPath: "/models/bf16.safetensors", modelFormat: "safetensors",
    runnerConfig: { workflowVersion, civitaiVersionId: 3370753, textEncoderPath: encoderPath,
      textEncoderSha256: encoderSha, textEncoderDevice: "cpu", vaeTemporalPadding: "torch_cat",
      publicSelection: { surface: "generator_image_edit" }, capabilities: { referenceImages: true, lora: false }, ...overrides },
    defaultWidth: 832, defaultHeight: 1216, allowedOrientations: ["4:5", "16:9"],
    steps: 16, sampler: "euler", scheduler: "simple", cfgScale: 2,
    costMultiplier: 1.75, maxCount: 2, concurrencyLimit: 1, rolloutPercent: 50,
  } });
}

describe("Qwen 2.1 multi-reference acceleration publication", () => {
  it.each([
    { model: "redqw21-multi-reference" },
    { profileId: "character-image-multi-identity" },
    { profileId: "seed-profile-character-image-variation-v1" },
    { controls: { workflowKey: "qwen-image-edit-multi-identity" } },
  ])("refuses publication while a multi-reference job is queued (%j)", async (pin) => {
    const job = await prisma.generationJob.create({ data: {
      id: `${prefix}pending`, userId: "seed-dev-user", mode: "image", status: "queued", controls: {}, presetIds: [], ...pin,
    } });
    const before = await prisma.generationModelProfile.findMany({ orderBy: { id: "asc" } });
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    try {
      await expect(client.query(await readFile(sqlUrl, "utf8"))).rejects.toThrow("Pending multi-reference jobs must finish");
      await client.query("ROLLBACK");
      expect(await prisma.generationModelProfile.findMany({ orderBy: { id: "asc" } })).toEqual(before);
    } finally {
      await client.query("ROLLBACK");
      await client.end();
      await prisma.generationJob.delete({ where: { id: job.id } });
    }
  });

  it("publishes both six-step routes while retaining reference, size, price and historical pins", async () => {
    const previous = [await createPreviousProfile(0), await createPreviousProfile(1)];
    const untouched = await prisma.generationModelProfile.findMany({
      where: { workflowKey: { in: ["redqw21", "qwen-image-edit-img2img"] } }, orderBy: { id: "asc" },
    });
    const pinnedJob = await prisma.generationJob.create({ data: {
      id: `${prefix}historical`, userId: "seed-dev-user", mode: "image", status: "completed",
      profileId: previous[0].id, profileVersion: previous[0].version,
      controls: { workflowKey: routes[0][0], workflowVersion: routes[0][2] }, presetIds: [],
    } });
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    try {
      const sql = await readFile(sqlUrl, "utf8");
      await client.query(sql);
      for (const [index, [workflowKey, pipelineModel, workflowVersion]] of routes.entries()) {
        const old = previous[index];
        const published = await prisma.generationModelProfile.findFirstOrThrow({ where: { profileKey: old.profileKey, status: "active" } });
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
        expect(await prisma.generationModelProfile.findUniqueOrThrow({ where: { id: old.id } })).toMatchObject({
          status: "archived", version: 8, runnerConfig: old.runnerConfig, steps: 16, cfgScale: 2,
          publishedAt: old.publishedAt, createdAt: old.createdAt,
        });
      }
      expect(await prisma.generationJob.findUniqueOrThrow({ where: { id: pinnedJob.id } })).toEqual(pinnedJob);
      const published = await prisma.generationModelProfile.findMany({ orderBy: { id: "asc" } });
      await client.query(sql);
      for (const name of ["2026-10-01-qwen21-mac-acceleration", "2026-09-30-qwen21-int8-text-encoder", "2026-09-30-redqw21-v2-image-edit-retire-rapid-aio"]) {
        await client.query(await readFile(new URL(`../../../db/sql/${name}.sql`, import.meta.url), "utf8"));
      }
      expect(await prisma.generationModelProfile.findMany({ orderBy: { id: "asc" } })).toEqual(published);
      expect(await prisma.generationModelProfile.findMany({
        where: { workflowKey: { in: ["redqw21", "qwen-image-edit-img2img"] } }, orderBy: { id: "asc" },
      })).toEqual(untouched);
    } finally {
      await client.query("ROLLBACK");
      await client.end();
      await prisma.generationJob.delete({ where: { id: pinnedJob.id } });
      await prisma.generationModelProfile.deleteMany({ where: { profileKey: { startsWith: prefix } } });
    }
  });

  it.each([{ workflowVersion: 4 }, { civitaiVersionId: 3353689 }, { textEncoderSha256: "wrong-weight" }])("rejects unverified prior configurations (%j)", async (overrides) => {
    await createPreviousProfile(0, overrides);
    const before = await prisma.generationModelProfile.findMany({ orderBy: { id: "asc" } });
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    try {
      await expect(client.query(await readFile(sqlUrl, "utf8"))).rejects.toThrow("Publish verified REDQW21 V2");
      await client.query("ROLLBACK");
      expect(await prisma.generationModelProfile.findMany({ orderBy: { id: "asc" } })).toEqual(before);
    } finally {
      await client.query("ROLLBACK");
      await client.end();
      await prisma.generationModelProfile.deleteMany({ where: { profileKey: { startsWith: prefix } } });
    }
  });

  it("retains a later authoritative publication", async () => {
    await createPreviousProfile(1, { workflowVersion: 20 });
    const before = await prisma.generationModelProfile.findMany({ orderBy: { id: "asc" } });
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    try {
      await client.query(await readFile(sqlUrl, "utf8"));
      expect(await prisma.generationModelProfile.findMany({ orderBy: { id: "asc" } })).toEqual(before);
    } finally {
      await client.end();
      await prisma.generationModelProfile.deleteMany({ where: { profileKey: { startsWith: prefix } } });
    }
  });
});
