import { describe, expect, it } from "vitest";
import {
  createHistoricalJob, createHistoricalProfile, expectHistoricalCutoverRejected,
  historicalCutoverSql, historicalProfiles, withHistoricalImageCatalog,
} from "./historical-image-cutover-fixtures";

const sql = await historicalCutoverSql(new URL("../../../db/sql/2026-10-01-qwen21-mac-acceleration.sql", import.meta.url));
const encoderPath = "/Users/kk/ComfyUI-Shared/models/text_encoders/qwen3vl_8b_int8_convrot.safetensors";
const encoderSha = "8bfd0f6e12abf2d2d697ecc888e5e90b0d6741d6708f05799f53afa560452e8f";
const loraSha = "0c98591700346f9777051d4e6fa29aa94519abec0d85b1f1f672a2a3db8c94b3";

describe("Qwen 2.1 Mac acceleration publication", () => {
  it.each([{ model: "redqw21-image-edit" }, { profileId: "chat-image-edit" }])("refuses to replace pins while a legacy edit is queued (%j)", async (pin) => withHistoricalImageCatalog(async (client) => {
    await createHistoricalProfile(client, {
      id: "test-historical-chat-image-edit", profileKey: "chat-image-edit", label: "Historical single edit",
      pipelineModel: "redqw21-image-edit", workflowKey: "qwen-image-edit-img2img",
      runnerConfig: { workflowVersion: 4 },
    });
    await createHistoricalJob(client, {
      id: "test-qwen21-mac-pending", userId: "seed-dev-user", mode: "image", status: "queued",
      ...pin, controls: {}, presetIds: [],
    });
    await expectHistoricalCutoverRejected(client, sql, "Pending Qwen-Image jobs must finish");
  }));

  it("publishes six-step single edits, preserves multi-reference controls and history, and prevents historical downgrades", async () => withHistoricalImageCatalog(async (client) => {
    const routes = [
      ["redqw21", "redqw21", 2, 10, 1],
      ["qwen-image-edit-img2img", "redqw21-image-edit", 4, 10, 1],
      ["qwen-image-edit-multi-reference", "redqw21-multi-reference", 5, 16, 2],
      ["qwen-image-edit-multi-identity", "redqw21-multi-identity", 4, 16, 2],
    ] as const;
    const prefix = "test-qwen21-mac-";
    const previous = [];
    for (const [workflowKey, pipelineModel, workflowVersion, steps, cfgScale] of routes) {
      previous.push(await createHistoricalProfile(client, {
        id: `${prefix}${workflowKey}-old`, profileKey: `${prefix}${workflowKey}`, label: "Controlled Mac cutover",
        mode: "image", runner: "comfyui", pipelineModel, workflowKey, version: 7, status: "active",
        sourceModelPath: "/models/source.safetensors", convertedModelPath: "/models/bf16.safetensors",
        runnerConfig: { workflowVersion, civitaiVersionId: workflowKey === "redqw21" ? 3353689 : 3370753,
          textEncoderPath: encoderPath, textEncoderSha256: encoderSha, textEncoderDevice: "cpu",
          publicSelection: { surface: "generator_image_edit" }, capabilities: { referenceImages: true, lora: false } },
        allowedOrientations: ["4:5"], costMultiplier: 1.75, maxCount: 2, rolloutPercent: 50,
        steps, sampler: "euler", scheduler: "simple", cfgScale,
      }));
    }
    const pinnedJob = await createHistoricalJob(client, {
      id: `${prefix}historical-job`, userId: "seed-dev-user", mode: "image", status: "completed",
      profileId: previous[1].id, profileVersion: 7, controls: { workflowKey: routes[1][0], workflowVersion: 4 }, presetIds: [],
    });
    await client.query(sql);
    const after = await historicalProfiles(client);
    for (const [index, [workflowKey, pipelineModel, workflowVersion, steps, cfgScale]] of routes.entries()) {
      const old = previous[index];
      const single = workflowKey === "qwen-image-edit-img2img";
      const published = after.find((profile) => profile.profileKey === old.profileKey && profile.status === "active");
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
      if (single) expect(published?.runnerConfig).toMatchObject({ conditioningPasses: 1,
        turboLora: expect.objectContaining({ sha256: loraSha, rank: 128, alpha: 128, strength: 1, unmerged: true }),
      });
      expect(after.find((profile) => profile.id === old.id)).toMatchObject({
        status: "archived", version: 7, runnerConfig: old.runnerConfig, steps: old.steps, createdAt: old.createdAt,
      });
    }
    expect((await client.query("SELECT * FROM generation_jobs WHERE id = $1", [pinnedJob.id])).rows[0]).toEqual(pinnedJob);
    await client.query(sql);
    await client.query(await historicalCutoverSql(new URL("../../../db/sql/2026-09-30-qwen21-int8-text-encoder.sql", import.meta.url)));
    await client.query(await historicalCutoverSql(new URL("../../../db/sql/2026-09-30-redqw21-v2-image-edit-retire-rapid-aio.sql", import.meta.url)));
    expect(await historicalProfiles(client)).toEqual(after);
  }));
});
