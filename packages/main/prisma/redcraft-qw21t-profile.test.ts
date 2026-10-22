import { readFile } from "node:fs/promises";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";
import { selectGenerationProfile } from "@/server/modules/ourdream/generation-profile-selection";

const profileKey = "image-redcraft-qw21t";
const defaultKey = "profile_image_default_v1";
const sql = (await readFile(new URL("../../../db/sql/2026-10-21-redcraft-default-image-profile.sql", import.meta.url), "utf8"))
  .replace(/^BEGIN;$/m, "").replace(/^COMMIT;$/m, "");

async function withTransaction(run: (client: pg.Client) => Promise<void>) {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await client.query("BEGIN");
    await run(client);
  } finally {
    await client.query("ROLLBACK");
    await client.end();
  }
}

async function profiles(client: pg.Client) {
  return (await client.query("SELECT * FROM generation_model_profiles ORDER BY id")).rows;
}

async function expectRejected(client: pg.Client, message: string) {
  const before = await profiles(client);
  await client.query("SAVEPOINT rejected_cutover");
  await expect(client.query(sql)).rejects.toThrow(message);
  await client.query("ROLLBACK TO SAVEPOINT rejected_cutover");
  expect(await profiles(client)).toEqual(before);
}

describe("RedCraft / FineView default image publication", () => {
  it("routes text, single identity and source-only edits to six steps without losing multi-reference authority", async () => {
    const expected = {
      profileKey: defaultKey, pipelineModel: "redcraft-qw21t", workflowKey: "redcraft-qw21t",
      steps: 6, sampler: "er_sde", scheduler: "simple", cfgScale: 1,
      costMultiplier: 1, requiredEntitlement: null,
      runnerConfig: expect.objectContaining({ workflowVersion: 3, publicSelection: { surface: "generator_image_edit" } }),
    };
    const single = [{ assetId: "adult-face-a", role: "identity_anchor" as const }];
    const empty = { pinnedReferences: [], sourceImageAssetId: null, lookReferenceAssetId: null };
    await expect(selectGenerationProfile({ mode: "image", catalogScope: "public_text_to_image", referenceRequirements: empty, accessibleEntitlements: {} })).resolves.toMatchObject(expected);
    await expect(selectGenerationProfile({ mode: "image", catalogScope: "public_character_image", referenceRequirements: { ...empty, pinnedReferences: single }, accessibleEntitlements: {} })).resolves.toMatchObject(expected);
    await expect(selectGenerationProfile({ mode: "image", catalogScope: "public_image_edit", referenceRequirements: { ...empty, sourceImageAssetId: "source" }, accessibleEntitlements: {} })).resolves.toMatchObject(expected);
    await expect(selectGenerationProfile({ mode: "image", referenceRequirements: { ...empty, pinnedReferences: [...single, { assetId: "adult-face-b", role: "identity_reference" }] }, accessibleEntitlements: {} })).resolves.toMatchObject({ workflowKey: "qwen-image-edit-multi-identity" });
    await expect(selectGenerationProfile({ mode: "image", referenceRequirements: { ...empty, pinnedReferences: single, sourceImageAssetId: "source" }, accessibleEntitlements: {} })).resolves.toMatchObject({ workflowKey: "qwen-image-edit-multi-reference" });
    await expect(selectGenerationProfile({ mode: "image", requested: "chat-image-edit", referenceRequirements: { ...empty, sourceImageAssetId: "source" } })).resolves.toMatchObject({ profileKey: "chat-image-edit", pipelineModel: "redqw21-image-edit" });
  });

  it("publishes fresh optional profiles, matches seed pins, and replays without any writes", async () => withTransaction(async (client) => {
    const before = await profiles(client);
    const seeded = before.find((p) => p.profileKey === profileKey);
    await client.query('DELETE FROM generation_model_profiles WHERE "profileKey" = $1', [profileKey]);
    await client.query(sql);
    const after = await profiles(client);
    expect(after.find((p) => p.profileKey === profileKey)).toMatchObject({
      version: 3, steps: 6, sampler: "er_sde", scheduler: "simple", runnerConfig: seeded.runnerConfig,
    });
    expect(after.filter((p) => p.profileKey !== profileKey)).toEqual(before.filter((p) => p.profileKey !== profileKey));
    await client.query(sql);
    expect(await profiles(client)).toEqual(after);
    await client.query('UPDATE generation_model_profiles SET "pipelineModel" = \'unexpected\' WHERE "profileKey" = $1', [profileKey]);
    await expectRejected(client, "differs from the exact released configuration");
  }));

  it("archives eight-step and prior default recipes, preserves billing/history, and refuses pending or conflicting cutovers", async () => {
    const job = await prisma.generationJob.create({ data: {
      id: "test-redcraft-pinned-job", userId: "seed-dev-user", mode: "image", status: "queued",
      profileId: profileKey, profileVersion: 2, controls: { workflowKey: "redcraft-qw21t", workflowVersion: 2 }, presetIds: [],
    } });
    try {
      await withTransaction(async (client) => {
        await client.query(`UPDATE generation_model_profiles SET id = 'test-redcraft-v2', version = 2, steps = 8,
          "runnerConfig" = jsonb_set("runnerConfig", '{workflowVersion}', '2') WHERE "profileKey" = $1`, [profileKey]);
        await client.query(`UPDATE generation_model_profiles SET version = 6,
          "pipelineModel" = 'redqw21', "workflowKey" = 'redqw21', steps = 10, sampler = 'euler',
          "runnerConfig" = (SELECT "runnerConfig" FROM generation_model_profiles WHERE "profileKey" = 'profile_image_premium_v1' AND status = 'active')
          WHERE "profileKey" = $1`, [defaultKey]);
        const old = await profiles(client);
        await expectRejected(client, "Pending RedCraft jobs must finish");
        await client.query("UPDATE generation_jobs SET status = 'completed' WHERE id = $1", [job.id]);
        const historicalJob = (await client.query("SELECT * FROM generation_jobs WHERE id = $1", [job.id])).rows[0];
        await client.query('UPDATE generation_model_profiles SET "costMultiplier" = 2 WHERE "profileKey" = $1', [profileKey]);
        await expectRejected(client, "differs from the exact released configuration");
        await client.query('UPDATE generation_model_profiles SET "costMultiplier" = 1.5 WHERE "profileKey" = $1', [profileKey]);
        await client.query(sql);
        const after = await profiles(client);
        for (const key of [profileKey, defaultKey]) {
          const previous = old.find((p) => p.profileKey === key);
          expect(after.find((p) => p.id === previous.id)).toEqual({ ...previous, status: "archived", archivedAt: expect.any(Date), updatedAt: expect.any(Date) });
        }
        const current = after.find((p) => p.profileKey === defaultKey && p.status === "active");
        const previous = old.find((p) => p.profileKey === defaultKey);
        expect(current).toMatchObject({ version: 7, steps: 6, pipelineModel: "redcraft-qw21t", costMultiplier: previous.costMultiplier, allowedOrientations: previous.allowedOrientations, maxCount: previous.maxCount, requiredEntitlement: previous.requiredEntitlement });
        expect((await client.query("SELECT * FROM generation_jobs WHERE id = $1", [job.id])).rows[0]).toEqual(historicalJob);
        expect(after.filter((p) => ![profileKey, defaultKey].includes(p.profileKey))).toEqual(old.filter((p) => ![profileKey, defaultKey].includes(p.profileKey)));
        await client.query(sql);
        expect(await profiles(client)).toEqual(after);
      });
    } finally {
      await prisma.generationJob.delete({ where: { id: job.id } });
    }
  });
});
