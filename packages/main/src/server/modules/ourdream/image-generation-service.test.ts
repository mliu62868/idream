import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Prisma } from "@prisma/client";
import type { AiFinalizePayload } from "@/server/ai/schemas";
import { drainLocalAiPipeline, reconcileStaleGenerationJobs } from "@/server/ai/local-pipeline";
import { jobQueue } from "@/server/jobs/queue";
import { prisma } from "@/server/lib/db";
import {
  api,
  createCharacter,
  createUser,
  dreamcoinBalance,
  expectError,
  expectOk,
  grantCoins,
  purgeTestData,
  runQueuedGenerationJobs,
} from "@/server/test/helpers";

const P = "zt-imgsvc-";
const SYS = `${P}sys`;
const CHAR = `${P}char`;

function asInputJson(value: AiFinalizePayload): Prisma.InputJsonValue {
  return value as unknown as Prisma.InputJsonValue;
}

beforeAll(async () => {
  await purgeTestData(P);
  await createUser({ id: SYS });
  await createCharacter({ id: CHAR, creatorId: SYS, visibility: "public", status: "approved" });
});

afterAll(async () => {
  await purgeTestData(P);
  await prisma.$disconnect();
});

describe("image generation service contract", () => {
  it("creates an active visual profile from the character preview anchor on draft submit", async () => {
    const userId = `${P}create-identity-user`;
    await createUser({ id: userId });

    const draftResponse = await api("POST", "character-drafts", {
      userId,
      ageGate: true,
      body: {
        gender: "female",
        style: "realistic",
        name: "Lyra Sol",
      },
    });
    expectOk(draftResponse);
    const draftId = draftResponse.data.draft.id as string;

    const patchResponse = await api("PATCH", `character-drafts/${draftId}`, {
      userId,
      ageGate: true,
      body: {
        appearance: { face: { eyes: "hazel" }, hair: { color: "auburn", style: "long waves" } },
        body: { build: "athletic" },
        advancedDetails: { signature: { freckles: true } },
      },
    });
    expectOk(patchResponse);

    const previewResponse = await api("POST", `character-drafts/${draftId}/preview`, {
      userId,
      ageGate: true,
    });
    expectOk(previewResponse);
    await runQueuedGenerationJobs(4);

    const submitResponse = await api("POST", `character-drafts/${draftId}/submit`, {
      userId,
      ageGate: true,
      body: {
        visibility: "private",
        description: "A grounded companion with auburn waves and hazel eyes.",
        age: 25,
      },
    });
    expectOk(submitResponse);
    const characterId = submitResponse.data.character.id as string;
    const character = await prisma.character.findUniqueOrThrow({ where: { id: characterId } });
    const visualProfile = await prisma.characterVisualProfile.findFirstOrThrow({
      where: { characterId, status: "active" },
    });

    expect(visualProfile.version).toBe(1);
    expect(visualProfile.createdFrom).toBe("create_preview");
    expect(visualProfile.identityPrompt).toContain("Lyra Sol");
    expect(visualProfile.identityPrompt).toContain("hazel");
    expect(visualProfile.anchorAssetIds).toEqual([character.imageAssetId]);
    expect(character.imageAssetId).toBeTruthy();
  });

  it("uses the selected preview candidate as the visual identity anchor", async () => {
    const userId = `${P}selected-preview-user`;
    await createUser({ id: userId });

    const draftResponse = await api("POST", "character-drafts", {
      userId,
      ageGate: true,
      body: {
        gender: "female",
        style: "realistic",
        name: "Mara Lune",
      },
    });
    expectOk(draftResponse);
    const draftId = draftResponse.data.draft.id as string;
    await api("PATCH", `character-drafts/${draftId}`, {
      userId,
      ageGate: true,
      body: {
        appearance: { face: { eyes: "blue" }, hair: { color: "black" } },
        body: { build: "soft athletic" },
        advancedDetails: { signature: "silver necklace" },
      },
    });

    const firstAssetId = `${P}selected-preview-asset-1`;
    const secondAssetId = `${P}selected-preview-asset-2`;
    await prisma.mediaAsset.createMany({
      data: [
        {
          id: firstAssetId,
          ownerId: userId,
          type: "image",
          url: "/images/ourdream/card-sarah-mercer.webp",
          thumbnailUrl: "/images/ourdream/card-sarah-mercer.webp",
          visibility: "private",
          safetyStatus: "passed",
          metadata: {},
        },
        {
          id: secondAssetId,
          ownerId: userId,
          type: "image",
          url: "/images/ourdream/card-sophie.webp",
          thumbnailUrl: "/images/ourdream/card-sophie.webp",
          visibility: "private",
          safetyStatus: "passed",
          metadata: {},
        },
      ],
    });
    const firstPreview = await prisma.characterPreviewJob.create({
      data: {
        draftId,
        status: "completed",
        provider: "mock",
        resultAssetId: firstAssetId,
        completedAt: new Date(Date.now() - 5_000),
      },
    });
    await prisma.characterPreviewJob.create({
      data: {
        draftId,
        status: "completed",
        provider: "mock",
        resultAssetId: secondAssetId,
        completedAt: new Date(),
      },
    });

    const selected = await api("POST", `character-drafts/${draftId}/preview-anchor`, {
      userId,
      ageGate: true,
      body: { previewJobId: firstPreview.id },
    });
    expectOk(selected);

    const submitResponse = await api("POST", `character-drafts/${draftId}/submit`, {
      userId,
      ageGate: true,
      body: {
        visibility: "private",
        description: "A grounded companion with blue eyes and a silver necklace.",
        age: 26,
      },
    });
    expectOk(submitResponse);
    const characterId = submitResponse.data.character.id as string;
    const character = await prisma.character.findUniqueOrThrow({ where: { id: characterId } });
    const visualProfile = await prisma.characterVisualProfile.findFirstOrThrow({
      where: { characterId, status: "active" },
    });

    expect(character.imageAssetId).toBe(firstAssetId);
    expect(visualProfile.anchorAssetIds).toEqual([firstAssetId]);
  });

  it("dedupes POST by Idempotency-Key and does not double reserve", async () => {
    const userId = `${P}idem-user`;
    await createUser({ id: userId });
    await grantCoins(userId, 100, "seed");

    const first = await api("POST", "generation/jobs", {
      userId,
      ageGate: true,
      headers: { "Idempotency-Key": `${P}idem-key` },
      body: { mode: "image", characterId: CHAR, outputCount: 1 },
    });
    const second = await api("POST", "generation/jobs", {
      userId,
      ageGate: true,
      headers: { "Idempotency-Key": `${P}idem-key` },
      body: { mode: "image", characterId: CHAR, outputCount: 1 },
    });

    expectOk(first, 202);
    expectOk(second, 202);
    expect(second.data.job.id).toBe(first.data.job.id);
    expect(await prisma.generationJob.count({ where: { userId } })).toBe(1);
    expect(await dreamcoinBalance(userId)).toBe(95);
    await runQueuedGenerationJobs(8);
  });

  it("enforces the per-user active job limit before reserve", async () => {
    const userId = `${P}limit-user`;
    await createUser({ id: userId });
    await grantCoins(userId, 100, "seed");
    const previous = process.env.MAX_INFLIGHT_JOBS_PER_USER;
    process.env.MAX_INFLIGHT_JOBS_PER_USER = "1";
    try {
      const first = await api("POST", "generation/jobs", {
        userId,
        ageGate: true,
        body: { mode: "image", characterId: CHAR, outputCount: 1 },
      });
      expectOk(first, 202);

      const second = await api("POST", "generation/jobs", {
        userId,
        ageGate: true,
        body: { mode: "image", characterId: CHAR, outputCount: 1 },
      });
      expectError(second, 429, "rate_limited");
      expect(await prisma.generationJob.count({ where: { userId } })).toBe(1);
      expect(await dreamcoinBalance(userId)).toBe(95);
      await runQueuedGenerationJobs(8);
    } finally {
      if (previous === undefined) delete process.env.MAX_INFLIGHT_JOBS_PER_USER;
      else process.env.MAX_INFLIGHT_JOBS_PER_USER = previous;
    }
  });

  it("reconciles stale non-terminal jobs to failed and refunds idempotently", async () => {
    const userId = `${P}stale-user`;
    await createUser({ id: userId });
    await grantCoins(userId, 100, "seed");

    const gen = await api("POST", "generation/jobs", {
      userId,
      ageGate: true,
      body: { mode: "image", characterId: CHAR, outputCount: 1 },
    });
    expectOk(gen, 202);
    const jobId = gen.data.job.id as string;
    await prisma.generationJob.update({
      where: { id: jobId },
      data: { updatedAt: new Date("2026-01-01T00:00:00.000Z") },
    });

    const reconciled = await reconcileStaleGenerationJobs({
      now: new Date("2026-01-01T00:20:00.000Z"),
      timeoutMs: 60_000,
    });
    expect(reconciled.enqueued).toBeGreaterThanOrEqual(1);
    await runQueuedGenerationJobs(4);
    await runQueuedGenerationJobs(4);

    const poll = await api("GET", `generation/jobs/${jobId}`, { userId, ageGate: true });
    expectOk(poll);
    expect(poll.data.job.status).toBe("failed");
    expect(poll.data.job.errorCode).toBe("stale_timeout");
    expect(await dreamcoinBalance(userId)).toBe(100);
  });

  it("removes pending generate work when a job is finalized as failed", async () => {
    const userId = `${P}failed-cleanup-user`;
    await createUser({ id: userId });
    await grantCoins(userId, 100, "seed");

    const gen = await api("POST", "generation/jobs", {
      userId,
      ageGate: true,
      body: { mode: "image", characterId: CHAR, outputCount: 1 },
    });
    expectOk(gen, 202);
    const jobId = gen.data.job.id as string;
    expect(await jobQueue.getByDedupeKey("ai.image.generate", `generation:${jobId}`)).not.toBeNull();

    await jobQueue.enqueue({
      queue: "app.ai.finalize",
      payload: asInputJson({
        version: 1,
        kind: "generation.failed",
        requestId: `${P}failed-cleanup`,
        generationJobId: jobId,
        mode: "image",
        error: {
          code: "worker_interrupted",
          message: "Worker interrupted",
          retryable: false,
        },
      }),
      dedupeKey: `generation-finalize:${jobId}:failed`,
    });

    await drainLocalAiPipeline({
      queues: ["app.ai.finalize"],
      limit: 2,
      workerId: `${P}failed-cleanup-finalizer`,
    });

    const poll = await api("GET", `generation/jobs/${jobId}`, { userId, ageGate: true });
    expectOk(poll);
    expect(poll.data.job.status).toBe("failed");
    expect(await dreamcoinBalance(userId)).toBe(100);
    expect(await jobQueue.getByDedupeKey("ai.image.generate", `generation:${jobId}`)).toBeNull();
    const attempt = await prisma.generationAttempt.findFirstOrThrow({ where: { requestId: jobId } });
    expect(attempt).toMatchObject({ status: "failed", terminalSequence: expect.any(Number) });
    expect(await prisma.generationAttemptEvent.findMany({
      where: { attemptId: attempt.id, terminalScope: "terminal" },
    })).toEqual([
      expect.objectContaining({ outcome: "failed", eventType: "generation.attempt.failed.v1" }),
    ]);
  });

  it("returns a same-origin download URL for local private storage", async () => {
    const userId = `${P}ttl-user`;
    const mediaId = `${P}media-ttl`;
    await createUser({ id: userId });
    await prisma.mediaAsset.create({
      data: {
        id: mediaId,
        ownerId: userId,
        type: "image",
        url: "/images/ourdream/card-sarah-mercer.webp",
        thumbnailUrl: "/images/ourdream/card-sarah-mercer.webp",
        storageKey: `${P}private/image.webp`,
        contentType: "image/webp",
        visibility: "private",
        safetyStatus: "passed",
        metadata: {},
      },
    });

    const download = await api("GET", `media/${mediaId}/download`, { userId, ageGate: true });
    expectOk(download);
    const token = Buffer.from(mediaId, "utf8").toString("base64url");
    expect(download.data.url).toBe(`/user-content/${token}/content.webp?download=1`);
  });

  it("summarizes partial success refunds in the job cost response", async () => {
    const userId = `${P}partial-user`;
    await createUser({ id: userId });
    await grantCoins(userId, 100, "seed");

    const gen = await api("POST", "generation/jobs", {
      userId,
      ageGate: true,
      body: { mode: "image", characterId: CHAR, outputCount: 2 },
    });
    expectOk(gen, 202);
    const jobId = gen.data.job.id as string;
    await jobQueue.removeByDedupePrefix(`generation:${jobId}`, ["ai.image.generate"]);
    await jobQueue.enqueue({
      queue: "app.ai.finalize",
      payload: asInputJson({
        version: 1,
        kind: "generation.completed",
        requestId: `${P}partial-request`,
        generationJobId: jobId,
        mode: "image",
        assets: [
          {
            key: `${P}partial/${jobId}/0.webp`,
            contentType: "image/webp",
            width: 1024,
            height: 1280,
          },
        ],
        usage: { gpuSeconds: 1.2, model: "mock-image" },
      }),
      dedupeKey: `generation-finalize:${jobId}:completed`,
    });

    await runQueuedGenerationJobs(4);
    const poll = await api("GET", `generation/jobs/${jobId}`, { userId, ageGate: true });
    expectOk(poll);
    expect(poll.data.job.status).toBe("completed");
    expect(poll.data.cost).toMatchObject({
      charged: 10,
      refunded: 5,
      finalCharge: 5,
      assetCount: 1,
      requestedCount: 2,
      missingOutputs: 1,
    });
    expect(await dreamcoinBalance(userId)).toBe(95);
  });

  it("persists dimension-level quality evidence without inventing identity scores", async () => {
    const userId = `${P}quality-user`;
    await createUser({ id: userId });
    await grantCoins(userId, 100, "seed");
    const gen = await api("POST", "generation/jobs", {
      userId,
      ageGate: true,
      body: { mode: "image", characterId: CHAR, outputCount: 1 },
    });
    expectOk(gen, 202);
    const jobId = gen.data.job.id as string;
    await jobQueue.removeByDedupePrefix(`generation:${jobId}`, ["ai.image.generate"]);

    await jobQueue.enqueue({
      queue: "app.ai.finalize",
      payload: asInputJson({
        version: 1,
        kind: "generation.completed",
        requestId: `${P}quality-request`,
        generationJobId: jobId,
        mode: "image",
        assets: [
          {
            key: `${P}quality/${jobId}/0.webp`,
            contentType: "image/webp",
            width: 1024,
            height: 1280,
            quality: {
              schemaVersion: "1",
              evaluatorVersion: "sanity-v1",
              artifact: { status: "passed" },
              faceCount: { status: "unscored", reason: "evaluator_unavailable" },
              identity: { status: "unscored", reason: "evaluator_unavailable" },
              intent: { status: "unscored", reason: "evaluator_unavailable" },
            },
          },
        ],
        usage: { gpuSeconds: 1.2, model: "mock-image" },
      }),
      dedupeKey: `generation-finalize:${jobId}:completed`,
    });
    await drainLocalAiPipeline({ queues: ["app.ai.finalize"], limit: 2 });

    const poll = await api("GET", `generation/jobs/${jobId}`, { userId, ageGate: true });
    expectOk(poll);
    expect(poll.data.assets[0].quality).toMatchObject({
      artifact: { status: "passed" },
      identity: { status: "unscored", reason: "evaluator_unavailable" },
    });
    expect(poll.data.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "image_quality_scored" }),
      ]),
    );
  });

  it("folds selected built-in and public community presets into the generation prompt", async () => {
    const userId = `${P}preset-user`;
    await createUser({ id: userId });
    await grantCoins(userId, 100, "seed");
    const modePreset = await prisma.generationPreset.create({
      data: {
        scope: "built_in",
        type: "mode",
        label: "Realistic",
        controls: { style: "realistic", rendering: "cinematic realism" },
        visibility: "public",
        status: "active",
      },
    });
    const preset = await prisma.generationPreset.create({
      data: {
        scope: "built_in",
        type: "background",
        label: "Bedroom",
        controls: { background: "bedroom", lighting: "soft" },
        visibility: "public",
        status: "active",
      },
    });
    const communityPreset = await prisma.generationPreset.create({
      data: {
        scope: "community",
        type: "outfit",
        label: "Evening Glam",
        controls: { outfit: "evening glam", accessories: "silver jewelry" },
        visibility: "public",
        status: "active",
      },
    });

    const gen = await api("POST", "generation/jobs", {
      userId,
      ageGate: true,
      body: {
        mode: "image",
        characterId: CHAR,
        outputCount: 1,
        controls: {
          modePresetId: modePreset.id,
          backgroundPresetId: preset.id,
          outfitPresetId: communityPreset.id,
        },
      },
    });
    expectOk(gen, 202);
    const job = await prisma.generationJob.findUniqueOrThrow({
      where: { id: gen.data.job.id as string },
    });
    expect(job.prompt).toContain("realistic");
    expect(job.prompt).toContain("cinematic realism");
    expect(job.prompt).toContain("bedroom");
    expect(job.prompt).toContain("soft");
    expect(job.prompt).toContain("evening glam");
    expect(job.prompt).toContain("silver jewelry");
    await runQueuedGenerationJobs(4);
  });

  it("ignores preset ids that are not built-in or owned by the user", async () => {
    const owner = `${P}preset-owner`;
    const intruder = `${P}preset-intruder`;
    await createUser({ id: owner });
    await createUser({ id: intruder });
    await grantCoins(intruder, 100, "seed");
    const privatePreset = await prisma.generationPreset.create({
      data: {
        ownerId: owner,
        scope: "user",
        type: "outfit",
        label: "Secret",
        controls: { outfit: "secret-couture" },
        visibility: "private",
        status: "active",
      },
    });

    const gen = await api("POST", "generation/jobs", {
      userId: intruder,
      ageGate: true,
      body: {
        mode: "image",
        characterId: CHAR,
        outputCount: 1,
        controls: { outfitPresetId: privatePreset.id },
      },
    });
    expectOk(gen, 202);
    const job = await prisma.generationJob.findUniqueOrThrow({
      where: { id: gen.data.job.id as string },
    });
    expect(job.prompt).not.toContain("secret-couture");
    await runQueuedGenerationJobs(4);
  });

  it("locks character image jobs to the active visual profile and records identity metadata", async () => {
    const userId = `${P}identity-user`;
    const characterId = `${P}identity-char`;
    const modelKey = `${P}reference-capable-model`;
    await createUser({ id: userId });
    await createCharacter({
      id: characterId,
      creatorId: userId,
      name: "Iris Vale",
      description: "A calm companion with silver hair and amber eyes.",
      visibility: "private",
      status: "approved",
    });
    await prisma.generationModelProfile.create({
      data: {
        id: `${P}reference-capable-profile`,
        profileKey: modelKey,
        label: "Reference-capable identity model",
        mode: "image",
        runner: "pipeline",
        pipelineModel: "mock-image",
        runnerConfig: {
          capabilities: {
            textToImage: true,
            stableSeed: true,
            referenceImages: true,
            initImage: true,
            lora: false,
          },
        },
        allowedOrientations: ["4:5"],
        defaultWidth: 768,
        defaultHeight: 1024,
        version: 1,
        status: "active",
      },
    });
    await prisma.mediaAsset.createMany({
      data: [
        {
          id: `${P}anchor-1`,
          ownerId: userId,
          characterId,
          type: "image",
          url: "/user-content/test-anchor/content.webp",
          thumbnailUrl: "/user-content/test-anchor/content.webp",
          storageKey: `${P}identity/anchor-1.webp`,
          contentType: "image/webp",
          width: 1024,
          height: 1280,
          visibility: "private",
          safetyStatus: "passed",
          metadata: {},
        },
        {
          id: `${P}ref-1`,
          ownerId: userId,
          characterId,
          type: "image",
          url: "/user-content/test-ref/content.webp",
          thumbnailUrl: "/user-content/test-ref/content.webp",
          storageKey: `${P}identity/ref-1.webp`,
          contentType: "image/webp",
          width: 1024,
          height: 1280,
          visibility: "private",
          safetyStatus: "passed",
          metadata: {},
        },
      ],
    });
    await prisma.characterVisualProfile.create({
      data: {
        id: `${P}cvp-1`,
        characterId,
        version: 3,
        status: "active",
        style: "realistic",
        identityPrompt: "Iris Vale, adult woman, silver bob haircut, amber eyes, heart-shaped face",
        negativeIdentityPrompt: "black hair, blue eyes, different face",
        faceTraits: { eyes: "amber", face: "heart-shaped" },
        hairTraits: { color: "silver", cut: "bob" },
        bodyTraits: {},
        signatureTraits: {},
        styleTraits: { style: "realistic" },
        anchorAssetIds: [`${P}anchor-1`],
        referenceAssetIds: [`${P}ref-1`],
        defaultSeed: `${P}identity-seed`,
        adapterRefs: {},
        createdFrom: "test",
      },
    });
    await grantCoins(userId, 100, "seed");

    const gen = await api("POST", "generation/jobs", {
      userId,
      ageGate: true,
      body: {
        mode: "image",
        characterId,
        model: modelKey,
        outputCount: 1,
        consistencyMode: "strict",
      },
    });
    expectOk(gen, 202);
    const job = await prisma.generationJob.findUniqueOrThrow({
      where: { id: gen.data.job.id as string },
    });
    expect(job.visualProfileId).toBe(`${P}cvp-1`);
    expect(job.visualProfileVersion).toBe(3);
    expect(job.consistencyMode).toBe("strict");
    expect(job.seed).toBe(`${P}identity-seed`);
    expect(job.referenceAssetIds).toEqual([`${P}anchor-1`, `${P}ref-1`]);
    expect(job.prompt).toContain("Locked identity");
    expect(job.prompt).toContain("silver bob haircut");
    expect(job.prompt).toContain("Identity consistency: strict");
    expect(job.negativePrompt).toContain("different face");
    expect(job.negativePrompt).toContain("black hair");
    expect(job.controls).toMatchObject({
      consistencyMode: "strict",
      visualIdentity: {
        visualProfileId: `${P}cvp-1`,
        visualProfileVersion: 3,
        consistencyMode: "strict",
        seed: `${P}identity-seed`,
      },
    });
    const queued = await jobQueue.getByDedupeKey("ai.image.generate", `generation:${job.id}`);
    const queuedPayload = queued?.payload as { referenceImages?: unknown[] } | undefined;
    expect(queuedPayload?.referenceImages).toEqual([
      expect.objectContaining({
        assetId: `${P}anchor-1`,
        role: "identity_anchor",
        storageKey: `${P}identity/anchor-1.webp`,
        weight: 1.25,
      }),
      expect.objectContaining({
        assetId: `${P}ref-1`,
        role: "identity_reference",
        storageKey: `${P}identity/ref-1.webp`,
        weight: 0.95,
      }),
    ]);
    await runQueuedGenerationJobs(4);
  });

  it("falls back to text identity and stable seed when the selected model cannot consume reference images", async () => {
    const userId = `${P}text-identity-user`;
    const characterId = `${P}text-identity-char`;
    const modelKey = `${P}text-only-model`;
    await createUser({ id: userId });
    await createCharacter({
      id: characterId,
      creatorId: userId,
      name: "Selene Ward",
      description: "A composed companion with ash-blonde waves and gray eyes.",
      visibility: "private",
      status: "approved",
    });
    await prisma.generationModelProfile.create({
      data: {
        id: `${P}text-only-profile`,
        profileKey: modelKey,
        label: "Text-only identity model",
        mode: "image",
        runner: "pipeline",
        pipelineModel: "mock-image",
        runnerConfig: {
          capabilities: {
            textToImage: true,
            stableSeed: true,
            referenceImages: false,
            initImage: false,
            lora: false,
          },
        },
        allowedOrientations: ["4:5"],
        defaultWidth: 768,
        defaultHeight: 1024,
        version: 1,
        status: "active",
      },
    });
    await prisma.mediaAsset.createMany({
      data: [
        {
          id: `${P}text-anchor`,
          ownerId: userId,
          characterId,
          type: "image",
          url: "/user-content/text-identity/anchor.webp",
          thumbnailUrl: "/user-content/text-identity/anchor.webp",
          storageKey: `${P}text-identity/anchor.webp`,
          contentType: "image/webp",
          width: 1024,
          height: 1280,
          visibility: "private",
          safetyStatus: "passed",
          metadata: {},
        },
        {
          id: `${P}text-ref`,
          ownerId: userId,
          characterId,
          type: "image",
          url: "/user-content/text-identity/ref.webp",
          thumbnailUrl: "/user-content/text-identity/ref.webp",
          storageKey: `${P}text-identity/ref.webp`,
          contentType: "image/webp",
          width: 1024,
          height: 1280,
          visibility: "private",
          safetyStatus: "passed",
          metadata: {},
        },
      ],
    });
    await prisma.characterVisualProfile.create({
      data: {
        id: `${P}text-cvp`,
        characterId,
        version: 1,
        status: "active",
        style: "realistic",
        identityPrompt: "Selene Ward, adult woman, ash-blonde waves, gray eyes, straight nose",
        negativeIdentityPrompt: "brown eyes, short black hair, different face",
        faceTraits: { eyes: "gray", nose: "straight" },
        hairTraits: { color: "ash-blonde", texture: "waves" },
        bodyTraits: {},
        signatureTraits: {},
        styleTraits: { style: "realistic" },
        anchorAssetIds: [`${P}text-anchor`],
        referenceAssetIds: [`${P}text-ref`],
        defaultSeed: `${P}text-seed`,
        adapterRefs: {},
        createdFrom: "test",
      },
    });
    await grantCoins(userId, 100, "seed");

    const gen = await api("POST", "generation/jobs", {
      userId,
      ageGate: true,
      body: {
        mode: "image",
        characterId,
        model: modelKey,
        outputCount: 1,
        consistencyMode: "strict",
      },
    });
    expectOk(gen, 202);
    const job = await prisma.generationJob.findUniqueOrThrow({
      where: { id: gen.data.job.id as string },
    });
    expect(job.seed).toBe(`${P}text-seed`);
    expect(job.referenceAssetIds).toEqual([`${P}text-anchor`, `${P}text-ref`]);
    expect(job.prompt).toContain("Locked identity");
    expect(job.prompt).toContain("ash-blonde waves");
    const queued = await jobQueue.getByDedupeKey("ai.image.generate", `generation:${job.id}`);
    const queuedPayload = queued?.payload as
      | { controls?: Record<string, unknown>; referenceImages?: unknown[]; seed?: string }
      | undefined;
    expect(queuedPayload?.referenceImages).toBeUndefined();
    expect(queuedPayload?.seed).toBe(`${P}text-seed`);
    expect(queuedPayload?.controls).toMatchObject({
      model: modelKey,
      modelCapabilities: {
        textToImage: true,
        stableSeed: true,
        referenceImages: false,
        initImage: false,
        lora: false,
      },
    });
    await runQueuedGenerationJobs(4);
  });

  it("keeps chat image scene prompts separate from the character visual identity", async () => {
    const userId = `${P}chat-identity-user`;
    const characterId = `${P}chat-identity-char`;
    await createUser({ id: userId });
    await createCharacter({
      id: characterId,
      creatorId: userId,
      name: "Mira Dawn",
      description: "A warm companion with copper curls.",
      visibility: "private",
      status: "approved",
    });
    await prisma.characterVisualProfile.create({
      data: {
        id: `${P}chat-cvp`,
        characterId,
        version: 1,
        status: "active",
        style: "realistic",
        identityPrompt: "Mira Dawn, adult woman, copper curly hair, green eyes, soft freckles",
        negativeIdentityPrompt: "straight black hair, different face",
        faceTraits: { eyes: "green", freckles: true },
        hairTraits: { color: "copper", texture: "curly" },
        bodyTraits: {},
        signatureTraits: { freckles: true },
        styleTraits: { style: "realistic" },
        anchorAssetIds: [],
        referenceAssetIds: [],
        defaultSeed: `${P}chat-seed`,
        adapterRefs: {},
        createdFrom: "test",
      },
    });
    await grantCoins(userId, 100, "seed");

    const job = await import("@/server/modules/ourdream/service").then((mod) =>
      mod.createChatImageGenerationJob({
        version: 1,
        kind: "chat.image.requested",
        requestId: `${P}chat-req`,
        attachmentId: `${P}attachment`,
        sessionId: `${P}session`,
        messageId: `${P}message`,
        userId,
        characterId,
        promptHint: "sitting beside a rain-streaked window, soft evening light",
        conversationContext: "The user asked for a quiet photo from the current scene.",
        controls: { orientation: "4:5", outputCount: 1 },
      }),
    );

    const stored = await prisma.generationJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(stored.sourceType).toBe("chat_image");
    expect(stored.visualProfileId).toBe(`${P}chat-cvp`);
    expect(stored.prompt).toContain("Locked identity");
    expect(stored.prompt).toContain("copper curly hair");
    expect(stored.prompt).toContain("rain-streaked window");
    expect(stored.prompt).not.toContain("Recent chat context");
    expect(stored.controls).toMatchObject({
      consistencyMode: "balanced",
      visualIdentity: {
        visualProfileId: `${P}chat-cvp`,
        visualProfileVersion: 1,
      },
    });
    await runQueuedGenerationJobs(4);
  });

  it("promotes owned generated media to the character image and bootstraps identity", async () => {
    const userId = `${P}promote-user`;
    const characterId = `${P}promote-char`;
    const mediaId = `${P}promote-media`;
    await createUser({ id: userId });
    await createCharacter({
      id: characterId,
      creatorId: userId,
      name: "Nora Vale",
      description: "A thoughtful companion with dark curls.",
      visibility: "private",
      status: "approved",
    });
    await prisma.mediaAsset.create({
      data: {
        id: mediaId,
        ownerId: userId,
        type: "image",
        url: "/images/ourdream/card-sarah-mercer.webp",
        thumbnailUrl: "/images/ourdream/card-sarah-mercer.webp",
        visibility: "private",
        safetyStatus: "passed",
        metadata: {},
      },
    });

    const promoted = await api("POST", `media/${mediaId}/use-as-character-image`, {
      userId,
      ageGate: true,
      body: { characterId },
    });
    expectOk(promoted);

    const character = await prisma.character.findUniqueOrThrow({ where: { id: characterId } });
    const visualProfile = await prisma.characterVisualProfile.findFirstOrThrow({
      where: { characterId, status: "active" },
    });
    const media = await prisma.mediaAsset.findUniqueOrThrow({ where: { id: mediaId } });
    expect(character.imageAssetId).toBe(mediaId);
    expect(visualProfile.anchorAssetIds).toEqual([mediaId]);
    expect(media.characterId).toBe(characterId);
    expect(media.metadata).toMatchObject({
      quality: {
        selectedAsCharacterImage: true,
        visualProfileId: visualProfile.id,
        visualProfileVersion: visualProfile.version,
      },
    });
  });

  it("keeps one active identity verdict while preserving superseded feedback events", async () => {
    const userId = `${P}feedback-user`;
    const characterId = `${P}feedback-char`;
    const jobId = `${P}feedback-job`;
    const mediaId = `${P}feedback-media`;
    await createUser({ id: userId });
    await createCharacter({
      id: characterId,
      creatorId: userId,
      visibility: "private",
      status: "approved",
    });
    await prisma.generationJob.create({
      data: {
        id: jobId,
        userId,
        characterId,
        mode: "image",
        controls: {},
        presetIds: [],
        outputCount: 1,
        status: "completed",
      },
    });
    await prisma.mediaAsset.create({
      data: {
        id: mediaId,
        ownerId: userId,
        characterId,
        sourceJobId: jobId,
        type: "image",
        url: "/images/ourdream/card-sarah-mercer.webp",
        visibility: "private",
        safetyStatus: "passed",
        metadata: {},
      },
    });

    const first = await api("POST", `media/${mediaId}/feedback`, {
      userId,
      ageGate: true,
      body: { feedbackType: "identity_match", sourceSurface: "chat" },
    });
    expectOk(first);
    expect(first.data.feedback).toMatchObject({
      dimension: "identity",
      value: "match",
      revision: 1,
    });
    expect(first.data.referenceCandidate).toMatchObject({
      mediaAssetId: mediaId,
      status: "candidate",
      proposedRole: "identity_reference",
      source: "user_feedback",
    });

    const duplicate = await api("POST", `media/${mediaId}/feedback`, {
      userId,
      ageGate: true,
      body: { feedbackType: "identity_match", sourceSurface: "chat" },
    });
    expectOk(duplicate);
    expect(duplicate.data.feedback).toEqual(first.data.feedback);

    const replaced = await api("POST", `media/${mediaId}/feedback`, {
      userId,
      ageGate: true,
      body: { feedbackType: "identity_mismatch", sourceSurface: "chat" },
    });
    expectOk(replaced);
    expect(replaced.data.feedback).toMatchObject({
      id: first.data.feedback.id,
      dimension: "identity",
      value: "mismatch",
      revision: 2,
    });
    expect(replaced.data.referenceCandidate).toMatchObject({
      id: first.data.referenceCandidate.id,
      status: "rejected",
    });

    const detail = await api("GET", `generation/jobs/${jobId}`, {
      userId,
      ageGate: true,
    });
    expectOk(detail);
    const feedbackEvents = (detail.data.events as Array<{ type: string; metadata: Record<string, unknown> }>).filter(
      (event) => event.type === "user_feedback",
    );
    expect(feedbackEvents).toHaveLength(2);
    expect(feedbackEvents[1]?.metadata).toMatchObject({
      feedbackDimension: "identity",
      feedbackValue: "mismatch",
      supersedesEventId: first.data.eventId,
    });
    const feedbackRows = await prisma.generationFeedback.findMany({
      where: { actorId: userId, mediaAssetId: mediaId, dimension: "identity" },
      orderBy: { revision: "asc" },
    });
    expect(feedbackRows).toHaveLength(2);
    expect(feedbackRows.map((row) => ({ value: row.value, active: row.active }))).toEqual([
      { value: "match", active: false },
      { value: "mismatch", active: true },
    ]);
    expect(feedbackRows[1]?.supersedesId).toBe(feedbackRows[0]?.id);
  });

  it("promotes owned media into the active identity anchor set", async () => {
    const userId = `${P}promote-existing-user`;
    const characterId = `${P}promote-existing-char`;
    const mediaId = `${P}promote-existing-media`;
    const oldAnchorId = `${P}promote-existing-anchor`;
    await createUser({ id: userId });
    await createCharacter({
      id: characterId,
      creatorId: userId,
      name: "Nia Vale",
      description: "A companion with green eyes.",
      visibility: "private",
      status: "approved",
    });
    await prisma.characterVisualProfile.create({
      data: {
        id: `${P}promote-existing-cvp-v1`,
        characterId,
        version: 1,
        status: "active",
        style: "realistic",
        identityPrompt: "Nia Vale, adult woman, green eyes",
        negativeIdentityPrompt: "different face",
        faceTraits: { eyes: "green" },
        hairTraits: {},
        bodyTraits: {},
        signatureTraits: {},
        styleTraits: { style: "realistic" },
        anchorAssetIds: [oldAnchorId],
        referenceAssetIds: [mediaId],
        defaultSeed: `${P}promote-existing-seed`,
        adapterRefs: {},
        createdFrom: "test",
      },
    });
    await prisma.mediaAsset.create({
      data: {
        id: mediaId,
        ownerId: userId,
        type: "image",
        url: "/images/ourdream/card-sarah-mercer.webp",
        thumbnailUrl: "/images/ourdream/card-sarah-mercer.webp",
        visibility: "private",
        safetyStatus: "passed",
        metadata: {},
      },
    });

    const promoted = await api("POST", `media/${mediaId}/use-as-character-image`, {
      userId,
      ageGate: true,
      body: { characterId },
    });
    expectOk(promoted);

    const oldProfile = await prisma.characterVisualProfile.findUniqueOrThrow({
      where: { id: `${P}promote-existing-cvp-v1` },
    });
    const activeProfile = await prisma.characterVisualProfile.findFirstOrThrow({
      where: { characterId, status: "active" },
    });
    expect(oldProfile.status).toBe("active");
    expect(activeProfile.version).toBe(1);
    expect(activeProfile.anchorAssetIds).toEqual([mediaId, oldAnchorId]);
    expect(activeProfile.referenceAssetIds).toEqual([]);
  });

  it("adds generated media through a reference revision without changing identity version", async () => {
    const userId = `${P}reference-user`;
    const characterId = `${P}reference-char`;
    const mediaId = `${P}reference-media`;
    await createUser({ id: userId });
    await createCharacter({
      id: characterId,
      creatorId: userId,
      name: "Sera Night",
      description: "A companion with violet eyes.",
      visibility: "private",
      status: "approved",
    });
    await prisma.characterVisualProfile.create({
      data: {
        id: `${P}reference-cvp-v1`,
        characterId,
        version: 1,
        status: "active",
        style: "realistic",
        identityPrompt: "Sera Night, adult woman, violet eyes, sleek black hair",
        negativeIdentityPrompt: "different face",
        faceTraits: { eyes: "violet" },
        hairTraits: { color: "black" },
        bodyTraits: {},
        signatureTraits: {},
        styleTraits: { style: "realistic" },
        anchorAssetIds: [`${P}reference-anchor`],
        referenceAssetIds: [],
        defaultSeed: `${P}reference-seed`,
        adapterRefs: {},
        createdFrom: "test",
      },
    });
    await prisma.mediaAsset.create({
      data: {
        id: mediaId,
        ownerId: userId,
        characterId,
        type: "image",
        url: "/images/ourdream/card-sarah-mercer.webp",
        thumbnailUrl: "/images/ourdream/card-sarah-mercer.webp",
        visibility: "private",
        safetyStatus: "passed",
        metadata: {},
      },
    });

    const added = await api("POST", `media/${mediaId}/add-to-identity`, {
      userId,
      ageGate: true,
    });
    expectOk(added);

    const oldProfile = await prisma.characterVisualProfile.findUniqueOrThrow({
      where: { id: `${P}reference-cvp-v1` },
    });
    const activeProfile = await prisma.characterVisualProfile.findFirstOrThrow({
      where: { characterId, status: "active" },
    });
    const media = await prisma.mediaAsset.findUniqueOrThrow({ where: { id: mediaId } });
    expect(oldProfile.status).toBe("active");
    expect(activeProfile.version).toBe(1);
    expect(activeProfile.referenceAssetIds).toEqual([mediaId]);
    expect(activeProfile.anchorAssetIds).toEqual([`${P}reference-anchor`]);
    expect(media.metadata).toMatchObject({
      quality: {
        addedToReferences: true,
        visualProfileId: activeProfile.id,
        visualProfileVersion: 1,
      },
    });
  });

  it("pins an immutable reference-set manifest on every character generation job", async () => {
    const userId = `${P}manifest-user`;
    const characterId = `${P}manifest-char`;
    const anchorId = `${P}manifest-anchor`;
    const referenceId = `${P}manifest-reference`;
    await createUser({ id: userId });
    await createCharacter({
      id: characterId,
      creatorId: userId,
      name: "Iris Vale",
      description: "A companion with silver hair and amber eyes.",
      visibility: "private",
      status: "approved",
    });
    await prisma.characterVisualProfile.create({
      data: {
        id: `${P}manifest-cvp-v1`,
        characterId,
        version: 1,
        status: "active",
        style: "realistic",
        identityPrompt: "Iris Vale, adult woman, silver hair, amber eyes",
        negativeIdentityPrompt: "different face",
        faceTraits: { eyes: "amber" },
        hairTraits: { color: "silver" },
        bodyTraits: {},
        signatureTraits: {},
        styleTraits: { style: "realistic" },
        anchorAssetIds: [anchorId],
        referenceAssetIds: [],
        defaultSeed: `${P}manifest-seed`,
        adapterRefs: {},
        createdFrom: "test",
      },
    });
    await prisma.mediaAsset.createMany({
      data: [anchorId, referenceId].map((id) => ({
        id,
        ownerId: userId,
        characterId,
        type: "image",
        url: "/images/ourdream/card-sarah-mercer.webp",
        visibility: "private",
        safetyStatus: "passed",
        metadata: {},
      })),
    });

    const promoted = await api("POST", `media/${referenceId}/add-to-identity`, {
      userId,
      ageGate: true,
    });
    expectOk(promoted);
    expect(promoted.data.referenceSetRevision).toMatchObject({
      revision: 1,
      status: "active",
      references: [
        { mediaAssetId: anchorId, role: "primary_face" },
        { mediaAssetId: referenceId, role: "identity_reference" },
      ],
    });

    await grantCoins(userId, 100, "seed");
    const defaultProfile = await prisma.generationModelProfile.findFirstOrThrow({
      where: { mode: "image", status: "active", enabled: true },
      orderBy: { version: "desc" },
    });
    await prisma.generationModelProfile.update({
      where: { id: defaultProfile.id },
      data: {
        runnerConfig: {
          ...(defaultProfile.runnerConfig as Record<string, unknown>),
          capabilities: {
            textToImage: true,
            stableSeed: true,
            referenceImages: true,
            initImage: true,
            lora: false,
          },
        },
      },
    });
    const created = await api("POST", "generation/jobs", {
      userId,
      ageGate: true,
      body: { mode: "image", characterId, outputCount: 1 },
    });
    expectOk(created, 202);
    expect(created.data.job).toMatchObject({
      referenceSetRevisionId: promoted.data.referenceSetRevision.id,
      referenceManifest: [
        { mediaAssetId: anchorId, role: "primary_face" },
        { mediaAssetId: referenceId, role: "identity_reference" },
      ],
    });
    const queued = await jobQueue.getByDedupeKey(
      "ai.image.generate",
      `generation:${created.data.job.id}`,
    );
    expect(queued?.payload).toMatchObject({
      referenceImages: [
        {
          assetId: anchorId,
          role: "identity_anchor",
          weight: 1,
          selectionReason: "primary_identity_anchor",
        },
        {
          assetId: referenceId,
          role: "identity_reference",
          weight: 0.75,
          selectionReason: "user_promoted_identity_reference",
        },
      ],
    });
    await prisma.generationModelProfile.update({
      where: { id: defaultProfile.id },
      data: { runnerConfig: defaultProfile.runnerConfig as Prisma.InputJsonValue },
    });
  });

  it("stores a versioned MomentSpec snapshot instead of relying on prompt text alone", async () => {
    const userId = `${P}moment-user`;
    const characterId = `${P}moment-char`;
    await createUser({ id: userId });
    await createCharacter({
      id: characterId,
      creatorId: userId,
      name: "Nora Vale",
      description: "An adult companion with a calm presence.",
      visibility: "private",
      status: "approved",
    });
    await grantCoins(userId, 100, "seed");

    const rawInput = "Reading by the rainy window, glancing up with a warm smile";
    const created = await api("POST", "generation/jobs", {
      userId,
      ageGate: true,
      body: {
        mode: "image",
        characterId,
        prompt: rawInput,
        outputCount: 1,
      },
    });

    expectOk(created, 202);
    expect(created.data.job.momentSpec).toMatchObject({
      schemaVersion: "1",
      parserVersion: "moment-direct-v1",
      rawInput,
      scene: rawInput,
      confidence: 1,
      continuitySources: ["user_prompt"],
    });
  });

  it("creates reusable character Looks and snapshots the selected Look on a job", async () => {
    const userId = `${P}look-user`;
    const characterId = `${P}look-char`;
    await createUser({ id: userId });
    await createCharacter({
      id: characterId,
      creatorId: userId,
      name: "Mina Hart",
      description: "An adult companion with dark curls.",
      visibility: "private",
      status: "approved",
    });

    const saved = await api("POST", `characters/${characterId}/looks`, {
      userId,
      ageGate: true,
      body: {
        label: "Rainy day",
        appearanceDelta: {
          outfit: "cream trench coat",
          hair: "dark curls pinned loosely",
          accessories: ["amber umbrella"],
        },
      },
    });
    expectOk(saved, 201);
    expect(saved.data.look).toMatchObject({
      characterId,
      label: "Rainy day",
      status: "active",
      appearanceDelta: { outfit: "cream trench coat" },
    });
    const rejectedIdentityChange = await api("POST", `characters/${characterId}/looks`, {
      userId,
      ageGate: true,
      body: { label: "Different face", appearanceDelta: { face: "change facial structure" } },
    });
    expectError(rejectedIdentityChange, 400, "bad_request");

    const listed = await api("GET", `characters/${characterId}/looks`, {
      userId,
      ageGate: true,
    });
    expectOk(listed);
    expect(listed.data.items).toHaveLength(1);

    const lookMediaId = `${P}look-media`;
    await prisma.mediaAsset.create({
      data: {
        id: lookMediaId,
        ownerId: userId,
        characterId,
        type: "image",
        url: "/images/ourdream/card-sarah-mercer.webp",
        visibility: "private",
        safetyStatus: "passed",
        metadata: {},
      },
    });
    const savedFromMedia = await api("POST", `media/${lookMediaId}/save-as-look`, {
      userId,
      ageGate: true,
      body: {
        label: "Evening dress",
        appearanceDelta: { outfit: "midnight blue evening dress" },
      },
    });
    expectOk(savedFromMedia, 201);
    expect(savedFromMedia.data.look).toMatchObject({
      characterId,
      referenceAssetId: lookMediaId,
      label: "Evening dress",
    });

    await grantCoins(userId, 100, "seed");
    const generated = await api("POST", "generation/jobs", {
      userId,
      ageGate: true,
      body: {
        mode: "image",
        characterId,
        controls: { lookId: saved.data.look.id },
        outputCount: 1,
      },
    });
    expectOk(generated, 202);
    expect(generated.data.job).toMatchObject({
      lookId: saved.data.look.id,
      lookSnapshot: {
        label: "Rainy day",
        appearanceDelta: { outfit: "cream trench coat" },
      },
    });
    expect(generated.data.job.prompt).toContain("cream trench coat");

    const identityReferenceId = `${P}look-identity-reference`;
    await prisma.mediaAsset.create({
      data: {
        id: identityReferenceId,
        ownerId: userId,
        characterId,
        type: "image",
        url: "/images/ourdream/card-sophie.webp",
        visibility: "private",
        safetyStatus: "passed",
        metadata: {},
      },
    });
    const identityUpdate = await api("POST", `media/${identityReferenceId}/add-to-identity`, {
      userId,
      ageGate: true,
      body: { characterId },
    });
    expectOk(identityUpdate);
    const rebasedList = await api("GET", `characters/${characterId}/looks`, {
      userId,
      ageGate: true,
    });
    expectOk(rebasedList);
    expect(rebasedList.data.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: "Rainy day",
          visualProfileId: identityUpdate.data.visualProfile.id,
          id: saved.data.look.id,
          rebasedFromLookId: null,
          status: "active",
        }),
      ]),
    );
  });

  it("creates a more-like-this variation through the standard character identity pipeline", async () => {
    const userId = `${P}variation-user`;
    const characterId = `${P}variation-char`;
    const mediaId = `${P}variation-media`;
    await createUser({ id: userId });
    await createCharacter({
      id: characterId,
      creatorId: userId,
      name: "Vera Lune",
      description: "A companion with pearl-white hair.",
      visibility: "private",
      status: "approved",
    });
    await prisma.characterVisualProfile.create({
      data: {
        id: `${P}variation-cvp`,
        characterId,
        version: 1,
        status: "active",
        style: "realistic",
        identityPrompt: "Vera Lune, adult woman, pearl-white hair, grey eyes",
        negativeIdentityPrompt: "different face",
        faceTraits: { eyes: "grey" },
        hairTraits: { color: "pearl-white" },
        bodyTraits: {},
        signatureTraits: {},
        styleTraits: { style: "realistic" },
        anchorAssetIds: [],
        referenceAssetIds: [],
        defaultSeed: `${P}variation-seed`,
        adapterRefs: {},
        createdFrom: "test",
      },
    });
    await prisma.mediaAsset.create({
      data: {
        id: mediaId,
        ownerId: userId,
        characterId,
        type: "image",
        url: "/images/ourdream/card-sarah-mercer.webp",
        thumbnailUrl: "/images/ourdream/card-sarah-mercer.webp",
        storageKey: `${P}variation/source.webp`,
        contentType: "image/webp",
        width: 1024,
        height: 1280,
        prompt: "Requested scene: sitting in a lantern-lit library. clean composition",
        visibility: "private",
        safetyStatus: "passed",
        metadata: {},
      },
    });
    await grantCoins(userId, 100, "seed");

    const variation = await api("POST", `media/${mediaId}/variation`, {
      userId,
      ageGate: true,
      body: { outputCount: 1, consistencyMode: "creative" },
    });
    expectOk(variation, 202);

    const job = await prisma.generationJob.findUniqueOrThrow({
      where: { id: variation.data.job.id as string },
    });
    expect(job.sourceType).toBe("media_variation");
    expect(job.sourceMeta).toMatchObject({ sourceMediaId: mediaId });
    expect(job.characterId).toBe(characterId);
    expect(job.visualProfileId).toBe(`${P}variation-cvp`);
    expect(job.consistencyMode).toBe("creative");
    expect(job.prompt).toContain("Locked identity");
    expect(job.prompt).toContain("pearl-white hair");
    expect(job.prompt).toContain("lantern-lit library");
    const queued = await jobQueue.getByDedupeKey("ai.image.generate", `generation:${job.id}`);
    const queuedPayload = queued?.payload as { controls?: Record<string, unknown>; referenceImages?: unknown[] } | undefined;
    expect(queuedPayload?.controls).toMatchObject({
      sourceImageAssetId: mediaId,
      modelCapabilities: {
        referenceImages: false,
        initImage: true,
      },
    });
    expect(queuedPayload?.referenceImages).toEqual([
      expect.objectContaining({
        assetId: mediaId,
        role: "source_image",
        storageKey: `${P}variation/source.webp`,
        weight: 0.7,
      }),
    ]);
    await runQueuedGenerationJobs(4);
  });
});
