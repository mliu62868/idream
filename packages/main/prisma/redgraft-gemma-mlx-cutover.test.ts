import { readFile } from "node:fs/promises";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";

const key = "profile_video_redgraft_ltx25_v1";
const sqlUrl = new URL("../../../db/sql/2026-10-02-redgraft-gemma-mlx.sql", import.meta.url);
let originals: Awaited<ReturnType<typeof prisma.generationModelProfile.findMany>>;

beforeEach(async () => {
  originals = await prisma.generationModelProfile.findMany({ where: { profileKey: key } });
  const original = originals.find((profile) => profile.status === "active");
  if (!original) throw new Error("Expected the seeded RedGraft profile");
  await prisma.generationModelProfile.deleteMany({ where: { profileKey: key } });
  const old = JSON.parse(JSON.stringify({ ...original, id: "test-gemma-mlx-old", version: 2,
    runnerConfig: { ...JSON.parse(JSON.stringify(original.runnerConfig)), workflowVersion: 2 },
    costMultiplier: 1.75, dryRunSummary: { source: "historical-proof" } }));
  await prisma.generationModelProfile.create({ data: old });
  await prisma.generationModelProfile.create({ data: { ...old, id: "test-gemma-mlx-draft", version: 3,
    status: "draft", enabled: false, publishedAt: null, allowedOrientations: ["2:3", "1:1"],
    runnerConfig: { ...old.runnerConfig, videoOptions: { version: "redgraft-video-options-v1", seconds: [3,5], orientations: ["2:3","1:1"], qualities: ["preview","standard"] } },
  } });
});

afterEach(async () => {
  await prisma.generationJob.deleteMany({ where: { id: { startsWith: "test-gemma-mlx-" } } });
  await prisma.generationModelProfile.deleteMany({ where: { profileKey: key } });
  await prisma.generationModelProfile.createMany({ data: JSON.parse(JSON.stringify(originals)) });
});

describe("RedGraft Gemma MLX publication", () => {
  it.each([{ model: "redgraft-ltx25-fast2k-int8-convrot" }, { profileId: key }])("rejects outstanding work (%j)", async (pin) => {
    await prisma.generationJob.create({ data: { id: "test-gemma-mlx-pending", userId: "seed-dev-user",
      mode: "video", status: "queued", ...pin, controls: {}, presetIds: [], } });
    const before = await prisma.generationModelProfile.findMany({ where: { profileKey: key }, orderBy: { version: "asc" } });
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    try {
      await expect(client.query(await readFile(sqlUrl, "utf8"))).rejects.toThrow("Pending RedGraft work must finish");
      await client.query("ROLLBACK");
      expect(await prisma.generationModelProfile.findMany({ where: { profileKey: key }, orderBy: { version: "asc" } })).toEqual(before);
    } finally { await client.end(); }
  });

  it("preserves history, prices and the disabled options draft, and replays without new versions", async () => {
    const before = await prisma.generationModelProfile.findMany({ where: { profileKey: key }, orderBy: { version: "asc" } });
    const job = await prisma.generationJob.create({ data: { id: "test-gemma-mlx-history", userId: "seed-dev-user",
      mode: "video", status: "completed", profileId: before[0].id, profileVersion: 2,
      controls: { workflowKey: "redgraft-ltx25-i2v", workflowVersion: 2 }, presetIds: [], } });
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    try {
      const sql = await readFile(sqlUrl, "utf8");
      await client.query(sql);
      for (const old of before) {
        const next = await prisma.generationModelProfile.findFirstOrThrow({ where: { profileKey: key, version: old.version + 2 } });
        expect(next).toMatchObject({ status: old.status, enabled: old.enabled, costMultiplier: old.costMultiplier,
          allowedOrientations: old.allowedOrientations, steps: old.steps, cfgScale: old.cfgScale,
          runnerConfig: { ...JSON.parse(JSON.stringify(old.runnerConfig)), workflowVersion: 3 },
        });
        const archived = await prisma.generationModelProfile.findUniqueOrThrow({ where: { id: old.id } });
        expect(archived).toEqual({ ...old, status: "archived", archivedAt: expect.any(Date), updatedAt: expect.any(Date) });
      }
      expect(await prisma.generationJob.findUniqueOrThrow({ where: { id: job.id } })).toEqual(job);
      const published = await prisma.generationModelProfile.findMany({ where: { profileKey: key }, orderBy: { version: "asc" } });
      await client.query(sql);
      await client.query(await readFile(new URL("../../../db/sql/2026-10-02-redgraft-video-options-draft.sql", import.meta.url), "utf8"));
      expect(await prisma.generationModelProfile.findMany({ where: { profileKey: key }, orderBy: { version: "asc" } })).toEqual(published);
    } finally { await client.end(); }
  });

  it("imports the current disabled options draft after a fresh default publication", async () => {
    await prisma.generationModelProfile.delete({ where: { id: "test-gemma-mlx-draft" } });
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    try {
      await client.query(await readFile(sqlUrl, "utf8"));
      await client.query(await readFile(new URL("../../../db/sql/2026-10-02-redgraft-video-options-draft.sql", import.meta.url), "utf8"));
      expect(await prisma.generationModelProfile.findFirstOrThrow({ where: { profileKey: key, version: 5 } })).toMatchObject({
        status: "draft", enabled: false, allowedOrientations: ["2:3","1:1"],
        runnerConfig: { workflowVersion: 3, videoOptions: { seconds: [3,5], qualities: ["preview","standard"] } },
      });
    } finally { await client.end(); }
  });
});
