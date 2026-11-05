import { readFile } from "node:fs/promises";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";
import { PRODUCTION_H3_VIDEO_PROFILE } from "@/server/modules/generation/production-video-profile";

const key = "profile_video_h3_v1";
const prefix = "test-h3-default-";
const sql = await readFile(new URL("../../../db/sql/2026-11-02-h3-default-video.sql", import.meta.url), "utf8");
const profiles = () => prisma.generationModelProfile.findMany({ where: { profileKey: key }, orderBy: { version: "asc" } });
let originals: Awaited<ReturnType<typeof profiles>>;

beforeEach(async () => {
  originals = await profiles();
  const original = originals.find(profile => profile.status === "active");
  if (!original) throw new Error("Expected seeded H3 profile");
  await prisma.generationModelProfile.deleteMany({ where: { profileKey: key } });
  await prisma.generationModelProfile.create({ data: JSON.parse(JSON.stringify({ ...original,
    id: `${prefix}old`, version: 5, enabled: true, costMultiplier: 1.75,
    label: "MiniMax H3 Mystic V5", workflowKey: "minimax-h3-mystic-i2v",
    pipelineModel: "minimax-h3-mystic-v5-int8-convrot",
    sourceModelPath: "diffusion_models/minimax_h3_fl2va_pruned_int8_convrot.safetensors",
    runnerConfig: { ...PRODUCTION_H3_VIDEO_PROFILE.runnerConfig, publicSelection: { explicitOnly: true } },
    dryRunSummary: { status: "passed", scope: "native_backend_only", source: "verified-mystic-v5" },
  })) });
});

afterEach(async () => {
  await prisma.generationAttempt.deleteMany({ where: { id: { startsWith: prefix } } });
  await prisma.generationJob.deleteMany({ where: { id: { startsWith: prefix } } });
  await prisma.generationModelProfile.deleteMany({ where: { profileKey: key } });
  await prisma.generationModelProfile.createMany({ data: JSON.parse(JSON.stringify(originals)) });
});

async function publish() {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try { await client.query(sql); }
  finally { await client.query("ROLLBACK"); await client.end(); }
}

describe("H3 default selection publication", () => {
  it("preserves historical manual pins, pricing and bounded probe evidence; replay is inert", async () => {
    const [old] = await profiles();
    const job = await prisma.generationJob.create({ data: { id: `${prefix}history`, userId: "seed-dev-user",
      mode: "video", status: "completed", profileId: old.id, profileVersion: 5, controls: {}, presetIds: [] } });
    const attempt = await prisma.generationAttempt.create({ data: { id: `${prefix}attempt`, requestId: job.id,
      attemptNo: 1, status: "succeeded", profileKey: key, profileVersion: 5,
      workflowKey: "minimax-h3-mystic-i2v", workflowVersion: 5 } });
    await publish();
    const [archived, current] = await profiles();
    expect(archived).toEqual({ ...old, status: "archived", archivedAt: expect.any(Date), updatedAt: expect.any(Date) });
    expect(current).toMatchObject({ ...PRODUCTION_H3_VIDEO_PROFILE, enabled: true, costMultiplier: 1.75,
      dryRunSummary: { status: "passed", scope: "native_backend_only", selectionPolicy: "default_video", previousProfileId: old.id } });
    expect(current.dryRunSummary).not.toHaveProperty("wallTimeSeconds");
    expect(await prisma.generationJob.findUniqueOrThrow({ where: { id: job.id } })).toEqual(job);
    expect(await prisma.generationAttempt.findUniqueOrThrow({ where: { id: attempt.id } })).toEqual(attempt);
    await publish();
    expect(await profiles()).toEqual([archived, current]);
  });

  it.each([{ model: "minimax-h3-redcraft-i2v" }, { profileId: key }, { model: "minimax-h3-mystic-v5-int8-convrot" }])("refuses pending jobs (%j)", async pin => {
    await prisma.generationJob.create({ data: { id: `${prefix}pending`, userId: "seed-dev-user",
      mode: "video", status: "queued", ...pin, controls: {}, presetIds: [] } });
    const before = await profiles();
    await expect(publish()).rejects.toThrow("Pending H3 work must finish");
    expect(await profiles()).toEqual(before);
  });

  it.each(["running", "unknown"])("refuses a %s attempt even when its job is terminal", async status => {
    const job = await prisma.generationJob.create({ data: { id: `${prefix}pending`, userId: "seed-dev-user",
      mode: "video", status: "completed", controls: {}, presetIds: [] } });
    await prisma.generationAttempt.create({ data: { id: `${prefix}running`, requestId: job.id,
      attemptNo: 1, status, profileKey: key, profileVersion: 5,
      workflowKey: "minimax-h3-mystic-i2v", workflowVersion: 5 } });
    await expect(publish()).rejects.toThrow("Pending H3 work must finish");
  });

  it.each([false, true])("refuses execution drift before publication/replay (replay=%s)", async replay => {
    if (replay) await publish();
    await prisma.generationModelProfile.updateMany({ where: { profileKey: key, status: "active" }, data: { allowedOrientations: ["2:3"] } });
    const before = await profiles();
    await expect(publish()).rejects.toThrow("Enabled Mystic V5 execution contract required");
    expect(await profiles()).toEqual(before);
  });
});
