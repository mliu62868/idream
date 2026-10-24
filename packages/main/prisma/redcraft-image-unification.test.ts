import { readFile } from "node:fs/promises";
import pg from "pg";
import { describe, expect, it } from "vitest";

const sql = (await readFile(new URL("../../../db/sql/2026-10-23-unify-redcraft-image-model.sql", import.meta.url), "utf8"))
  .replace(/^BEGIN;$/m, "").replace(/^COMMIT;$/m, "");
const defaultKey = "profile_image_default_v1";
const legacyAuditKey = "test-redcraft-unification-legacy-batch";
const routes = [
  [defaultKey, "redcraft-qw21t", 3, 7],
  ["character-image-single-identity-redcraft", "redqw21-image-edit", 5, 7],
  ["chat-image-edit", "redqw21-image-edit", 5, 5],
  ["character-image-variation", "redqw21-multi-reference", 7, 7],
  ["character-image-multi-identity", "redqw21-multi-identity", 6, 6],
] as const;
const retainedKeys = routes.map(([key]) => key);
type RunnerConfig = Record<string, unknown> & {
  workflowPath: string;
  diffusionModelPath: string;
  capabilities: Record<string, boolean>;
  publicSelection?: Record<string, unknown>;
};
type Profile = Record<string, unknown> & {
  id: string;
  profileKey: string;
  pipelineModel: string;
  workflowKey: string;
  runnerConfig: RunnerConfig;
  sourceModelPath: string;
  convertedModelPath: string | null;
  version: number;
  status: string;
  maxCount: number;
};

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

async function profiles(client: pg.Client): Promise<Profile[]> {
  return (await client.query<Profile>("SELECT * FROM generation_model_profiles ORDER BY id")).rows;
}

function active(rows: Profile[], key: string): Profile {
  const matching = rows.filter((row) => row.profileKey === key && row.status === "active");
  expect(matching).toHaveLength(1);
  return matching[0];
}

async function patchProfile(client: pg.Client, id: string, patch: Partial<Profile>) {
  // Field names come only from this fixture, while every value is parameterized.
  const assignments = Object.keys(patch).map((key) => `"${key}" = patch."${key}"`).join(", ");
  await client.query(`UPDATE generation_model_profiles profile SET ${assignments}
    FROM jsonb_populate_record(NULL::generation_model_profiles, $2::jsonb) patch WHERE profile.id = $1`, [id, JSON.stringify(patch)]);
}

async function insertProfile(client: pg.Client, row: Profile) {
  await client.query("INSERT INTO generation_model_profiles SELECT (jsonb_populate_record(NULL::generation_model_profiles,$1::jsonb)).*", [JSON.stringify(row)]);
}

async function history(client: pg.Client) {
  return (await client.query(`SELECT jsonb_build_object(
    'jobs',(SELECT coalesce(jsonb_agg(to_jsonb(job) ORDER BY id),'[]'::jsonb) FROM generation_jobs job),
    'assets',(SELECT coalesce(jsonb_agg(to_jsonb(asset) ORDER BY id),'[]'::jsonb) FROM media_assets asset),
    'ledger',(SELECT coalesce(jsonb_agg(to_jsonb(entry) ORDER BY id),'[]'::jsonb) FROM dreamcoin_ledger entry)
  ) AS snapshot`)).rows[0].snapshot;
}

async function expectRejected(client: pg.Client, message: string) {
  const before = await profiles(client);
  const beforeHistory = await history(client);
  await client.query("SAVEPOINT rejected_cutover");
  await expect(client.query(sql)).rejects.toThrow(message);
  await client.query("ROLLBACK TO SAVEPOINT rejected_cutover");
  expect(await profiles(client)).toEqual(before);
  expect(await history(client)).toEqual(beforeHistory);
}

async function oldFixture(client: pg.Client) {
  const seeded = await profiles(client);
  const canonical = active(seeded, defaultKey);
  const modelRoot = canonical.runnerConfig.diffusionModelPath.replace(/\/diffusion_models\/[^/]+$/, "");
  const workflowDirectory = canonical.runnerConfig.workflowPath.replace(/[^/]+$/, "");
  // Reconstruct the released 2026-10-21 state from its actual pins. The expected
  // post-cutover configurations come independently from today's canonical seed.
  const encoder = {
    textEncoderPath: `${modelRoot}/text_encoders/qwen3vl_8b_int8_convrot.safetensors`,
    textEncoderSha256: "8bfd0f6e12abf2d2d697ecc888e5e90b0d6741d6708f05799f53afa560452e8f",
    textEncoderRepository: "Comfy-Org/Qwen-Image-2.1",
    textEncoderRevision: "cb504a4090723e43f17ad01cec0359490e2de613",
    textEncoderPrecision: "int8_convrot",
    textEncoderDevice: "mps",
  };
  const edit = {
    ...encoder,
    baseModel: "Qwen-Image 2.1", civitaiModelId: 452459, civitaiVersionId: 3370753, civitaiFileId: 3258921,
    sourceModelSha256: "0efb5aeb2b372025042e320c2e35c66ec6681ef54ad5de88a652ab19cc63ad92",
    diffusionModelPath: `${modelRoot}/diffusion_models/redqw21_unlocked_v2_bf16.safetensors`,
    vaePath: `${modelRoot}/vae/qwen_image_2.1_vae_bf16.safetensors`,
    vaeTemporalPadding: "torch_cat", precisionPolicy: "bf16_resident_mps", conditioningPasses: 1,
    turboLora: {
      path: `${modelRoot}/loras/Qwen-Image-2.1-viggle-turbo-v0.3-6step-lora-r128.safetensors`,
      rank: 128, alpha: 128, strength: 1, unmerged: true,
      sha256: "0c98591700346f9777051d4e6fa29aa94519abec0d85b1f1f672a2a3db8c94b3",
      revision: "009a44a895ef85f7e643c80fdca9543795248867",
      repository: "Viggle/Qwen-Image-2.1-viggle-turbo",
    },
  };
  for (const [key, pipelineModel, workflowVersion, version] of routes) {
    const current = active(seeded, key);
    if (key === defaultKey) {
      await patchProfile(client, current.id, { version, maxCount: 1 });
      continue;
    }
    const { capabilities, publicSelection, templateIntent } = current.runnerConfig;
    await patchProfile(client, current.id, {
      version, pipelineModel, steps: 6, sampler: "euler", scheduler: "viggle_turbo", cfgScale: 1,
      sourceModelPath: `${modelRoot}/diffusion_models/redqw21_unlocked_v2_fp8.safetensors`,
      convertedModelPath: edit.diffusionModelPath,
      runnerConfig: {
        ...edit, apiModelId: pipelineModel, workflowVersion, workflowPath: current.runnerConfig.workflowPath,
        capabilities: { ...capabilities, lora: true },
        ...(publicSelection ? { publicSelection } : {}), ...(templateIntent ? { templateIntent } : {}),
      },
    });
  }
  const plainConfig: RunnerConfig = {
    ...encoder, textEncoderDevice: "cpu", baseModel: "Qwen-Image 2.1", apiModelId: "redqw21",
    civitaiModelId: 452459, civitaiVersionId: 3353689,
    diffusionModelPath: `${modelRoot}/diffusion_models/redqw21_bf16.safetensors`,
    diffusionModelSha256: "9830a9925759a4b69ea1346133d08917ec2390b8495ea7f0eb613f37e7c46647",
    vaePath: `${modelRoot}/vae/qwen_image_2.1_vae_bf16.safetensors`,
    vaeTemporalPadding: "torch_cat", precisionPolicy: "bf16_resident_mps",
    workflowPath: `${workflowDirectory}redqw21.json`, workflowVersion: 3,
    capabilities: { lora: false, initImage: false, stableSeed: true, textToImage: true, referenceImages: true },
  };
  for (const [profileKey, version] of [["profile_image_premium_v1", 4], [legacyAuditKey, 1]] as const) {
    await insertProfile(client, {
      ...canonical, id: `test-redcraft-unification-${profileKey}`, profileKey, version,
      pipelineModel: "redqw21", workflowKey: "redqw21", runnerConfig: plainConfig,
      sourceModelPath: plainConfig.diffusionModelPath, convertedModelPath: null,
      defaultWidth: 512, defaultHeight: 512, steps: 10, sampler: "euler", scheduler: "simple", maxCount: 4,
      costMultiplier: profileKey === "profile_image_premium_v1" ? 1.5 : 1,
      requiredEntitlement: profileKey === "profile_image_premium_v1" ? "premium_models" : legacyAuditKey,
    });
  }
  await insertProfile(client, {
    ...canonical, id: "test-redcraft-unification-optional", profileKey: "image-redcraft-qw21t", version: 3,
    maxCount: 1, costMultiplier: 1.5, allowedOrientations: ["4:5"],
    runnerConfig: { ...canonical.runnerConfig, publicSelection: { surface: "generator_image_edit", explicitOnly: true } },
  });
  return seeded;
}

async function insertJob(client: pg.Client, pin: Record<string, unknown>, status = "queued") {
  await client.query(`INSERT INTO generation_jobs
    (id,"userId",mode,status,model,"profileId","profileVersion",controls,"presetIds","updatedAt","costDreamcoins")
    VALUES ('test-redcraft-unification-job','seed-dev-user','image',$1,$2,$3,$4,$5::jsonb,'[]'::jsonb,CURRENT_TIMESTAMP,12)`,
  [status, pin.model ?? null, pin.profileId ?? null, pin.profileVersion ?? null, JSON.stringify(pin.controls ?? {})]);
}

describe("one RedCraft checkpoint publication", () => {
  it("accepts the canonical unified seed without writing any profile or history", async () => withTransaction(async (client) => {
    const before = await profiles(client);
    const beforeHistory = await history(client);
    await client.query(sql);
    expect(await profiles(client)).toEqual(before);
    expect(await history(client)).toEqual(beforeHistory);
  }));

  it("publishes all semantic routes, preserves policy/history, archives old entries and replays exactly", async () => withTransaction(async (client) => {
    const seeded = await oldFixture(client);
    const oldVariation = active(await profiles(client), "character-image-variation");
    await patchProfile(client, oldVariation.id, {
      costMultiplier: 2.25, requiredEntitlement: "private-workflow", maxCount: 2, rolloutPercent: 42,
      defaultWidth: 768, defaultHeight: 960, allowedOrientations: ["4:5"],
    });
    await insertProfile(client, {
      ...oldVariation, id: "test-redcraft-unification-archived", version: 1, status: "archived",
      archivedAt: new Date("2026-09-01T00:00:00.000Z"),
      pipelineModel: "historical-model", runnerConfig: { ...oldVariation.runnerConfig, workflowVersion: 1 },
    });
    const old = await profiles(client);
    const oldDefault = active(old, defaultKey);
    await insertJob(client, { model: "redqw21-multi-reference", profileId: oldVariation.id, profileVersion: oldVariation.version,
      controls: { workflowKey: oldVariation.workflowKey, workflowVersion: 7 } }, "completed");
    await client.query(`INSERT INTO media_assets (id,"ownerId","sourceJobId",type,url,metadata)
      VALUES ('test-redcraft-unification-asset','seed-dev-user','test-redcraft-unification-job','image','/private/historical.png',
        '{"model":"redqw21-multi-reference","workflowVersion":7}'::jsonb)`);
    await client.query(`INSERT INTO dreamcoin_ledger (id,"userId",delta,"balanceAfter",reason,"sourceId")
      VALUES ('test-redcraft-unification-ledger','seed-dev-user',-12,88,'generation_spend','test-redcraft-unification-job')`);
    const beforeHistory = await history(client);
    await client.query(sql);
    const after = await profiles(client);
    for (const [key] of routes) {
      const previous = active(old, key);
      const current = active(after, key);
      const expected = active(seeded, key);
      expect(current).toMatchObject({
        version: previous.version + 1, pipelineModel: expected.pipelineModel, workflowKey: expected.workflowKey,
        runnerConfig: expected.runnerConfig, sourceModelPath: expected.sourceModelPath, convertedModelPath: null,
        steps: 6, sampler: "er_sde", scheduler: "simple", cfgScale: 1,
      });
      for (const field of ["costMultiplier", "requiredEntitlement", "concurrencyLimit", "enabled", "rolloutPercent", "defaultWidth", "defaultHeight", "allowedOrientations"]) {
        expect(current[field], `${key}.${field}`).toEqual(previous[field]);
      }
      expect(current.maxCount).toBe(key === defaultKey ? 4 : previous.maxCount);
      expect(after.find((row) => row.id === previous.id)).toEqual({
        ...previous, status: "archived", archivedAt: expect.any(Date), updatedAt: expect.any(Date),
      });
    }
    expect(active(after, defaultKey).runnerConfig).toEqual(oldDefault.runnerConfig);
    for (const key of ["profile_image_premium_v1", "image-redcraft-qw21t", legacyAuditKey]) {
      const previous = active(old, key);
      expect(after.find((row) => row.id === previous.id)).toEqual({
        ...previous, status: "archived", archivedAt: expect.any(Date), updatedAt: expect.any(Date),
      });
      expect(after.some((row) => row.profileKey === key && row.status === "active")).toBe(false);
    }
    const changedIds = new Set(old.filter((row) => row.status === "active" && (retainedKeys.some((key) => row.profileKey === key)
      || ["profile_image_premium_v1", "image-redcraft-qw21t", legacyAuditKey].includes(row.profileKey))).map((row) => row.id));
    expect(after.filter((row) => old.some((previous) => previous.id === row.id) && !changedIds.has(row.id)))
      .toEqual(old.filter((row) => !changedIds.has(row.id)));
    expect(await history(client)).toEqual(beforeHistory);
    await client.query(sql);
    expect(await profiles(client)).toEqual(after);
    expect(await history(client)).toEqual(beforeHistory);
  }));

  it.each([
    ["queued", { model: "redqw21-image-edit" }],
    ["moderating_input", { model: "redcraft-qw21t" }],
    ["running", { controls: { workflowKey: "qwen-image-edit-multi-identity" } }],
    ["moderating_output", { profileId: "character-image-variation" }],
    ["queued", { profileId: "seed-profile-chat-image-edit-v1" }],
    ["queued", { profileId: "profile_image_premium_v1" }],
    ["queued", { profileId: "test-redcraft-unification-optional" }],
    ["queued", { profileId: legacyAuditKey }],
  ])("rejects %s work for every legacy/current pin shape (%j)", async (status, pin) => withTransaction(async (client) => {
    await oldFixture(client);
    await insertJob(client, pin, status);
    await expectRejected(client, "Pending affected image jobs must finish");
  }));

  it("allows unrelated pending enhancement work", async () => withTransaction(async (client) => {
    await oldFixture(client);
    await insertJob(client, { model: "realesrgan-x2plus-enhance", profileId: "image-enhance-2x",
      controls: { workflowKey: "realesrgan-x2plus-enhance" } });
    const beforeHistory = await history(client);
    await client.query(sql);
    expect(active(await profiles(client), defaultKey).maxCount).toBe(4);
    expect(await history(client)).toEqual(beforeHistory);
  }));

  it("inherits deployment and model directories while rejecting inconsistent paths", async () => withTransaction(async (client) => {
    await oldFixture(client);
    const before = await profiles(client);
    const canonical = active(before, defaultKey);
    const oldWorkflowRoot = canonical.runnerConfig.workflowPath.replace(/[^/]+$/, "");
    const oldModelRoot = canonical.runnerConfig.diffusionModelPath.replace(/\/diffusion_models\/[^/]+$/, "");
    for (const profile of before.filter((row) => retainedKeys.some((key) => key === row.profileKey)
      || ["profile_image_premium_v1", "image-redcraft-qw21t", legacyAuditKey].includes(row.profileKey))) {
      const relocated = JSON.parse(JSON.stringify(profile)
        .replaceAll(oldWorkflowRoot, "/srv/idream deployment/packages/gen/workflows/")
        .replaceAll(oldModelRoot, "/srv/shared models"));
      await patchProfile(client, profile.id, {
        runnerConfig: relocated.runnerConfig, sourceModelPath: relocated.sourceModelPath, convertedModelPath: relocated.convertedModelPath,
      });
    }
    await client.query(sql);
    const published = await profiles(client);
    for (const key of retainedKeys) {
      const current = active(published, key);
      expect(current.runnerConfig.workflowPath).toBe(`/srv/idream deployment/packages/gen/workflows/${current.workflowKey}.json`);
      expect(current.sourceModelPath).toBe("/srv/shared models/diffusion_models/fineview_qw21_turbo_fixed_int8.safetensors");
      expect(current.runnerConfig.textEncoderPath).toBe("/srv/shared models/text_encoders/qwen3vl_8b_int8_convrot.safetensors");
      expect(current.runnerConfig.vaePath).toBe("/srv/shared models/vae/texture_fix_vae_for_qwen_image_2.1_bf16.safetensors");
    }
    await client.query(sql);
    expect(await profiles(client)).toEqual(published);
    const edit = active(published, "chat-image-edit");
    await patchProfile(client, edit.id, { runnerConfig: { ...edit.runnerConfig, workflowPath: "/srv/other/packages/gen/workflows/qwen-image-edit-img2img.json" } });
    await expectRejected(client, "differs from the released configuration");
  }));

  it.each([
    ["model digest", { diffusionModelSha256: "wrong-model" }],
    ["workflow pin", { workflowVersion: 999 }],
    ["encoder device", { textEncoderDevice: "cpu" }],
    ["unexpected adapter", { turboLora: { path: "/unexpected.safetensors" } }],
  ])("rejects drift in an already unified %s", async (_name, drift) => withTransaction(async (client) => {
    const profile = active(await profiles(client), "chat-image-edit");
    await patchProfile(client, profile.id, { runnerConfig: { ...profile.runnerConfig, ...drift } });
    await expectRejected(client, "differs from the released configuration");
  }));

  it("rolls back every earlier publication when a legacy recipe conflicts", async () => withTransaction(async (client) => {
    await oldFixture(client);
    const profile = active(await profiles(client), "character-image-multi-identity");
    await patchProfile(client, profile.id, { runnerConfig: { ...profile.runnerConfig, sourceModelSha256: "unexpected-source" } });
    await expectRejected(client, "differs from the released configuration");
  }));

  it("rejects mismatched retired entries rather than silently archiving them", async () => withTransaction(async (client) => {
    await oldFixture(client);
    const profile = active(await profiles(client), "profile_image_premium_v1");
    await patchProfile(client, profile.id, { pipelineModel: "unexpected-model" });
    await expectRejected(client, "Retired image profile profile_image_premium_v1 differs");
  }));

  it("rejects ambiguous active authorities", async () => withTransaction(async (client) => {
    await oldFixture(client);
    const profile = active(await profiles(client), "chat-image-edit");
    await insertProfile(client, { ...profile, id: "test-redcraft-unification-conflict", version: profile.version + 1 });
    await expectRejected(client, "Expected exactly one active image profile for chat-image-edit");
  }));

  it.each([
    ["workflow path", { workflowPath: "packages/gen/workflows/redcraft-qw21t.json" }],
    ["workflow path", { workflowPath: "/srv/../packages/gen/workflows/redcraft-qw21t.json" }],
    ["model root", { diffusionModelPath: "/srv/../diffusion_models/fineview_qw21_turbo_fixed_int8.safetensors" }],
  ])("rejects invalid default %s", async (kind, patch) => withTransaction(async (client) => {
    const profile = active(await profiles(client), defaultKey);
    await patchProfile(client, profile.id, { runnerConfig: { ...profile.runnerConfig, ...patch } });
    await expectRejected(client, `invalid ${kind}`);
  }));
});
