import { readFile } from "node:fs/promises";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";

const key = "profile_video_redgraft_ltx25_v1";
const sqlUrl = new URL("../../../db/sql/2026-10-02-redgraft-mpsgraph.sql", import.meta.url);
let originals: Awaited<ReturnType<typeof prisma.generationModelProfile.findMany>>;
const profiles = () => prisma.generationModelProfile.findMany({ where: { profileKey: key }, orderBy: { version: "asc" } });

beforeEach(async () => {
  originals = await profiles();
  const original = originals.find((profile) => profile.status === "active");
  if (!original) throw new Error("Expected the seeded RedGraft profile");
  await prisma.generationModelProfile.deleteMany({ where: { profileKey: key } });
  const old = JSON.parse(JSON.stringify({ ...original, id: "test-mpsgraph-default", version: 4,
    runnerConfig: { ...JSON.parse(JSON.stringify(original.runnerConfig)), workflowVersion: 3 },
    defaultWidth: 768, defaultHeight: 1152, allowedOrientations: ["2:3"],
    costMultiplier: 1.75, dryRunSummary: { source: "historical-proof" } }));
  delete old.runnerConfig.videoOptions;
  await prisma.generationModelProfile.create({ data: old });
  await prisma.generationModelProfile.create({ data: { ...old, id: "test-mpsgraph-options", version: 5,
    status: "draft", enabled: false, publishedAt: null, allowedOrientations: ["2:3", "1:1"],
    runnerConfig: { ...old.runnerConfig, videoOptions: { version: "redgraft-video-options-v1", seconds: [3,5], orientations: ["2:3","1:1"], qualities: ["preview","standard"] } },
  } });
});

afterEach(async () => {
  await prisma.generationJob.deleteMany({ where: { id: { startsWith: "test-mpsgraph-" } } });
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
  await prisma.generationModelProfile.update({ where: { id: "test-mpsgraph-default" }, data: { status: "archived", archivedAt: new Date() } });
  await prisma.generationModelProfile.update({ where: { id: "test-mpsgraph-options" }, data: { status: "active", enabled: true, publishedAt: new Date() } });
}

describe("RedGraft MPSGraph publication", () => {
  it.each([{ model: "redgraft-ltx25-fast2k-int8-convrot" }, { profileId: key },
    { profileId: "test-mpsgraph-options" }, { controls: { workflowKey: "redgraft-ltx25-i2v" } }])(
    "rejects outstanding work (%j)", async (pin) => {
      await prisma.generationJob.create({ data: { id: "test-mpsgraph-pending", userId: "seed-dev-user",
        mode: "video", status: "queued", controls: {}, ...pin, presetIds: [], } });
      const before = await profiles();
      await expect(runSql()).rejects.toThrow("Pending RedGraft work must finish");
      expect(await profiles()).toEqual(before);
    },
  );

  it.each([false, true])("preserves publication state, prices and immutable job pins (options active=%s)", async (optionsActive) => {
    if (optionsActive) await publishOptions();
    const before = await profiles();
    const active = before.find((profile) => profile.status === "active")!;
    const job = await prisma.generationJob.create({ data: { id: "test-mpsgraph-history", userId: "seed-dev-user",
      mode: "video", status: "completed", profileId: active.id, profileVersion: active.version,
      controls: { workflowKey: "redgraft-ltx25-i2v", workflowVersion: 3 }, presetIds: [], } });
    await runSql();
    for (const old of before) {
      const archived = await prisma.generationModelProfile.findUniqueOrThrow({ where: { id: old.id } });
      if (old.status === "archived") { expect(archived).toEqual(old); continue; }
      const next = await prisma.generationModelProfile.findFirstOrThrow({ where: { profileKey: key, version: old.version + 2 } });
      expect(next).toMatchObject({ status: old.status, enabled: old.enabled, costMultiplier: old.costMultiplier,
        allowedOrientations: old.allowedOrientations, steps: old.steps,
        runnerConfig: { ...JSON.parse(JSON.stringify(old.runnerConfig)), workflowVersion: 4 },
        dryRunSummary: { status: "configuration_cutover_requires_live_probe", previousProfileId: old.id },
      });
      expect(archived).toEqual({ ...old, status: "archived", archivedAt: expect.any(Date), updatedAt: expect.any(Date) });
    }
    expect(await prisma.generationJob.findUniqueOrThrow({ where: { id: job.id } })).toEqual(job);
    const published = await profiles();
    await runSql();
    await runSql(new URL("../../../db/sql/2026-10-02-redgraft-video-options-draft.sql", import.meta.url));
    expect(await profiles()).toEqual(published);
    expect(published.filter((profile) => profile.status === "active").map((profile) => profile.version)).toEqual([optionsActive ? 7 : 6]);
  });

  it("imports disabled v7 from a fresh default v6 without inventing historical v5", async () => {
    await prisma.generationModelProfile.delete({ where: { id: "test-mpsgraph-options" } });
    await runSql();
    const importer = new URL("../../../db/sql/2026-10-02-redgraft-video-options-draft.sql", import.meta.url);
    await runSql(importer);
    const current = await profiles();
    expect(current.map((profile) => profile.version)).toEqual([4,6,7]);
    expect(current.find((profile) => profile.version === 7)).toMatchObject({ status: "draft", enabled: false,
      runnerConfig: { workflowVersion: 4, videoOptions: { seconds: [3,5], qualities: ["preview","standard"] } } });
    await runSql(importer);
    expect(await profiles()).toEqual(current);
  });

  it("does not downgrade a later workflow publication", async () => {
    await publishOptions();
    await prisma.generationModelProfile.update({ where: { id: "test-mpsgraph-options" }, data: { version: 9,
      runnerConfig: { workflowVersion: 5 } } });
    const before = await profiles();
    await runSql();
    expect(await profiles()).toEqual(before);
  });

  it("rejects a conflicting version without archiving the active route", async () => {
    await prisma.generationModelProfile.update({ where: { id: "test-mpsgraph-options" }, data: { version: 7 } });
    const before = await profiles();
    await expect(runSql()).rejects.toThrow("no occupied v6/v7");
    expect(await profiles()).toEqual(before);
  });

  it("rolls back both publications if the options draft has drifted", async () => {
    await prisma.generationModelProfile.update({ where: { id: "test-mpsgraph-options" }, data: { defaultWidth: 512 } });
    const before = await profiles();
    await expect(runSql()).rejects.toThrow("execution contract drifted");
    expect(await profiles()).toEqual(before);
  });

  it.each([null, undefined])("rejects options import with absent workflow authority (%s)", async (workflowVersion) => {
    const original = await prisma.generationModelProfile.findUniqueOrThrow({ where: { id: "test-mpsgraph-default" } });
    const runnerConfig = JSON.parse(JSON.stringify({ ...JSON.parse(JSON.stringify(original.runnerConfig)), workflowVersion }));
    await prisma.generationModelProfile.update({ where: { id: original.id }, data: { runnerConfig } });
    const before = await profiles();
    await expect(runSql(new URL("../../../db/sql/2026-10-02-redgraft-video-options-draft.sql", import.meta.url)))
      .rejects.toThrow("Unsupported active RedGraft route");
    expect(await profiles()).toEqual(before);
  });
});
