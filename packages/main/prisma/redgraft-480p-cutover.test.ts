import { readFile } from "node:fs/promises";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";

const key = "profile_video_redgraft_ltx25_v1";
const prefix = "test-redgraft-480p-";
const sqlUrl = new URL("../../../db/sql/2026-10-05-redgraft-480p.sql", import.meta.url);
const oldOptions = { version: "redgraft-video-options-v1", seconds: [3, 5], orientations: ["2:3", "1:1"], qualities: ["preview", "standard"] };
const nextOptions = { ...oldOptions, version: "redgraft-video-options-v2", orientations: ["7:12", "2:3", "1:1"] };
const oldConfig = { workflowVersion: 4, capabilities: { textToImage: false, stableSeed: true, referenceImages: false,
  initImage: true, imageToVideo: true, audio: true, fps: 24, maxDurationSeconds: 5 } };
let originals: Awaited<ReturnType<typeof prisma.generationModelProfile.findMany>>;
const profiles = () => prisma.generationModelProfile.findMany({ where: { profileKey: key }, orderBy: { version: "asc" } });

beforeEach(async () => {
  originals = await profiles();
  const original = originals.find((profile) => profile.status === "active");
  if (!original) throw new Error("Expected the seeded RedGraft profile");
  await prisma.generationModelProfile.deleteMany({ where: { profileKey: key } });
  // Historical fixtures retain their original execution contract independently
  // of whichever default the current seed installs.
  const old = JSON.parse(JSON.stringify({ ...original, id: `${prefix}default`, version: 6,
    status: "active", enabled: true, archivedAt: null, runnerConfig: oldConfig,
    defaultWidth: 768, defaultHeight: 1152, allowedOrientations: ["2:3"],
    costMultiplier: 1.75, dryRunSummary: { status: "passed", source: "historical-proof", wallTimeSeconds: 616.334 } }));
  await prisma.generationModelProfile.create({ data: old });
  await prisma.generationModelProfile.create({ data: { ...old, id: `${prefix}options`, version: 7,
    status: "draft", enabled: false, publishedAt: null, allowedOrientations: ["2:3", "1:1"],
    runnerConfig: { ...oldConfig, videoOptions: oldOptions } } });
});

afterEach(async () => {
  await prisma.generationAttempt.deleteMany({ where: { id: { startsWith: prefix } } });
  await prisma.generationJob.deleteMany({ where: { id: { startsWith: prefix } } });
  await prisma.generationModelProfile.deleteMany({ where: { profileKey: key } });
  await prisma.generationModelProfile.createMany({ data: JSON.parse(JSON.stringify(originals)) });
});

async function runSql(url = sqlUrl) {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try { await client.query(await readFile(url, "utf8")); }
  finally { await client.end(); }
}

async function publishOptions() {
  await prisma.generationModelProfile.update({ where: { id: `${prefix}default` }, data: { status: "archived", archivedAt: new Date() } });
  await prisma.generationModelProfile.update({ where: { id: `${prefix}options` }, data: { status: "active", enabled: true, publishedAt: new Date() } });
}

describe("RedGraft 448x768 immutable publication", () => {
  it.each([{ model: "redgraft-ltx25-fast2k-int8-convrot" }, { profileId: key },
    { profileId: `${prefix}options` }, { controls: { workflowKey: "redgraft-ltx25-i2v" } }])(
    "rejects outstanding requests (%j)", async (pin) => {
      await prisma.generationJob.create({ data: { id: `${prefix}pending`, userId: "seed-dev-user",
        mode: "video", status: "queued", controls: {}, ...pin, presetIds: [] } });
      const before = await profiles();
      await expect(runSql()).rejects.toThrow("Pending RedGraft work must finish");
      expect(await profiles()).toEqual(before);
    });

  it.each(["queued", "running"])("rejects an outstanding %s attempt independently of its request", async (status) => {
    await prisma.generationAttempt.create({ data: { id: `${prefix}pending-attempt`, requestId: `${prefix}request`,
      attemptNo: 1, workflowKey: "redgraft-ltx25-i2v", workflowVersion: 4, status } });
    const before = await profiles();
    await expect(runSql()).rejects.toThrow("Pending RedGraft work must finish");
    expect(await profiles()).toEqual(before);
  });

  it.each([false, true])("preserves prices, publication state and historical pins (options active=%s)", async (optionsActive) => {
    if (optionsActive) await publishOptions();
    const before = await profiles();
    const active = before.find((profile) => profile.status === "active")!;
    const controls = { workflowKey: "redgraft-ltx25-i2v", workflowVersion: 4, width: 768, height: 1152,
      orientation: "2:3", generationProfileVersion: active.version,
      ...(optionsActive ? { videoOptionsVersion: oldOptions.version, videoQuality: "standard" } : {}) };
    const job = await prisma.generationJob.create({ data: { id: `${prefix}history`, userId: "seed-dev-user",
      mode: "video", status: "completed", profileId: active.id, profileVersion: active.version, controls, presetIds: [] } });
    const attempt = await prisma.generationAttempt.create({ data: { id: `${prefix}history-attempt`, requestId: job.id,
      attemptNo: 1, status: "completed", profileKey: key, profileVersion: active.version,
      workflowKey: "redgraft-ltx25-i2v", workflowVersion: 4 } });
    await runSql();
    for (const old of before) {
      const archived = await prisma.generationModelProfile.findUniqueOrThrow({ where: { id: old.id } });
      if (old.status === "archived") { expect(archived).toEqual(old); continue; }
      const next = await prisma.generationModelProfile.findFirstOrThrow({ where: { profileKey: key, version: old.version + 2 } });
      expect(next).toMatchObject({ status: old.status, enabled: old.enabled, costMultiplier: old.costMultiplier,
        label: old.label, defaultWidth: 448, defaultHeight: 768,
        allowedOrientations: old.version === 7 ? nextOptions.orientations : ["7:12"],
        runnerConfig: { ...oldConfig, workflowVersion: 5, ...(old.version === 7 ? { videoOptions: nextOptions } : {}) },
        dryRunSummary: { status: "configuration_cutover_requires_live_probe", previousProfileId: old.id, resolution: "448x768" } });
      expect(next.dryRunSummary).not.toHaveProperty("wallTimeSeconds");
      expect(next.publishedAt).toEqual(old.status === "active" ? expect.any(Date) : null);
      expect(archived).toEqual({ ...old, status: "archived", archivedAt: expect.any(Date), updatedAt: expect.any(Date) });
    }
    expect(await prisma.generationJob.findUniqueOrThrow({ where: { id: job.id } })).toEqual(job);
    expect(await prisma.generationAttempt.findUniqueOrThrow({ where: { id: attempt.id } })).toEqual(attempt);
    const published = await profiles();
    await runSql();
    await runSql(new URL("../../../db/sql/2026-10-02-redgraft-mpsgraph.sql", import.meta.url));
    await runSql(new URL("../../../db/sql/2026-10-02-redgraft-video-options-draft.sql", import.meta.url));
    expect(await profiles()).toEqual(published);
    expect(published.filter((profile) => profile.status === "active").map((profile) => profile.version)).toEqual([optionsActive ? 9 : 8]);
  });

  it("publishes a bare default without inventing an options draft", async () => {
    await prisma.generationModelProfile.delete({ where: { id: `${prefix}options` } });
    await runSql();
    const published = await profiles();
    expect(published.map((profile) => profile.version)).toEqual([6, 8]);
    await runSql();
    expect(await profiles()).toEqual(published);
  });

  it("rejects an occupied destination version without changing the active route", async () => {
    await prisma.generationModelProfile.update({ where: { id: `${prefix}options` }, data: { version: 9 } });
    const before = await profiles();
    await expect(runSql()).rejects.toThrow("no conflicting versions");
    expect(await profiles()).toEqual(before);
  });

  it("rolls back the first publication when the later options draft has drifted", async () => {
    await prisma.generationModelProfile.update({ where: { id: `${prefix}options` }, data: { defaultWidth: 512 } });
    const before = await profiles();
    await expect(runSql()).rejects.toThrow("execution contract drifted");
    expect(await profiles()).toEqual(before);
  });

  it("rejects execution drift during replay instead of silently accepting it", async () => {
    await runSql();
    await prisma.generationModelProfile.update({ where: { id: `${key}-480p-v9` }, data: {
      runnerConfig: { ...oldConfig, workflowVersion: 5, videoOptions: oldOptions } } });
    const before = await profiles();
    await expect(runSql()).rejects.toThrow("execution contract drifted");
    expect(await profiles()).toEqual(before);
  });

  it("does not downgrade a later workflow publication", async () => {
    await publishOptions();
    await prisma.generationModelProfile.update({ where: { id: `${prefix}options` }, data: { version: 11,
      runnerConfig: { workflowVersion: 6 } } });
    const before = await profiles();
    await runSql();
    expect(await profiles()).toEqual(before);
  });
});
