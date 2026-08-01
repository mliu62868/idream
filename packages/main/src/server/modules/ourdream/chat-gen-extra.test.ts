import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { MAIN_TO_CHAT_EVENTS } from "@idream/shared/contracts";
import { resolveLocalBlobPath } from "@idream/shared/storage/local-blob";
import { jobQueue } from "@/server/jobs/queue";
import { prisma } from "@/server/lib/db";
import { dispatchV1 } from "@/server/modules/ourdream/service";
import { providers } from "@/server/providers";
import {
  AGE_GATE_COOKIE_HEADER,
  api,
  createCharacter,
  createMedia,
  createUser,
  expectError,
  expectOk,
  grantCoins,
  publishCharacterForPublicAudience,
  purgeTestData,
  runQueuedGenerationJobs,
} from "@/server/test/helpers";

// SPEC: remaining chat/generation/media behaviors (BackendFeatureSpec §5.4/5.5/5.8)
// — message regenerate/delete, session list/archive, video generation (Deluxe),
// signed media download, generation retry, and the billing portal.

const P = "zt-cgx-";
const SYS = `${P}sys`;
const CHAR = `${P}char`;
const PINNED_RETRY_JOB_AUTHORITY = {
  model: "redcraft-krea2-redmix3-txt2img",
  profileId: "profile_image_default_v1",
  profileVersion: 1,
  orientation: "1:1",
  outputCount: 1,
  provider: "comfyui",
} as const;

beforeAll(async () => {
  await purgeTestData(P);
  await createUser({ id: SYS });
  await createCharacter({ id: CHAR, creatorId: SYS, visibility: "public", status: "approved" });
  await publishCharacterForPublicAudience({
    characterId: CHAR,
    ownerId: SYS,
  });
});

afterAll(async () => {
  await purgeTestData(P);
  await prisma.$disconnect();
});

describe("video generation (Deluxe)", () => {
  it("runs a video job for an entitled user and charges 100 dreamcoins per output", async () => {
    const userId = `${P}video`;
    await createUser({ id: userId });
    await grantCoins(userId, 300, "seed");
    await prisma.entitlement.create({
      data: { userId, key: "video_generation", value: true, source: "test" },
    });
    await prisma.featureFlag.update({
      where: { key: "video_gen" },
      data: { enabled: true, rolloutPercent: 100 },
    });
    const previousVideoProfile =
      await prisma.generationModelProfile.findUniqueOrThrow({
        where: { id: "seed-profile-video-beta-v1" },
        select: { rolloutPercent: true },
      });
    await prisma.generationModelProfile.update({
      where: { id: "seed-profile-video-beta-v1" },
      data: { rolloutPercent: 100 },
    });

    try {
      const gen = await api("POST", "generation/jobs", {
        userId,
        ageGate: true,
        body: { mode: "video", characterId: CHAR, outputCount: 1 },
      });
      expectOk(gen, 202);
      expect(gen.data.job.status).toBe("queued");
      const queued = await jobQueue.getByDedupeKey(
        "ai.video.generate",
        `generation:${gen.data.job.id}`,
      );
      expect(queued?.payload).toMatchObject({
        kind: "video",
        model: "ltx23-gtanimation-i2v",
        controls: {
          sourceImageAssetId: expect.any(String),
          workflowKey: "ltx23-gtanimation-i2v",
          workflowVersion: 1,
        },
        referenceImages: [
          expect.objectContaining({
            assetId: expect.any(String),
            role: "source_image",
          }),
        ],
      });
      await runQueuedGenerationJobs(8, [
        "ai.video.generate",
        "app.ai.finalize",
      ]);
      const poll = await api("GET", `generation/jobs/${gen.data.job.id}`, {
        userId,
        ageGate: true,
      });
      expectOk(poll);
      expect(poll.data.job.status).toBe("completed");
      expect((poll.data.assets as Array<{ type: string }>)[0].type).toBe("video");
      const asset = await prisma.mediaAsset.findFirstOrThrow({
        where: { sourceJobId: gen.data.job.id },
      });
      expect(asset.contentType).toBe("video/mp4");
      expect(asset.storageKey).toBeTruthy();
      const body = await readFile(resolveLocalBlobPath(asset.storageKey ?? ""));
      expect(body.subarray(4, 12).toString("ascii")).toBe("ftypisom");

      const balance = await prisma.dreamcoinLedger.aggregate({
        where: { userId },
        _sum: { delta: true },
      });
      expect(balance._sum.delta).toBe(200); // 300 - 100
    } finally {
      await prisma.featureFlag.update({
        where: { key: "video_gen" },
        data: { enabled: false, rolloutPercent: 0 },
      });
      await prisma.generationModelProfile.update({
        where: { id: "seed-profile-video-beta-v1" },
        data: previousVideoProfile,
      });
    }
  });
});

describe("media download (signed URL)", () => {
  it("returns a download URL for the owner", async () => {
    const userId = `${P}dl`;
    const mediaId = `${P}dl-media`;
    await createUser({ id: userId });
    await createMedia({ id: mediaId, ownerId: userId });
    await prisma.mediaAsset.update({
      where: { id: mediaId },
      data: { storageKey: `${P}downloads/owner.webp` },
    });

    const res = await api("GET", `media/${mediaId}/download`, { userId, ageGate: true });
    expectOk(res);
    expect(typeof res.data.url).toBe("string");
    expect((res.data.url as string).length).toBeGreaterThan(0);
  });

  it("rejects a display URL without authoritative private blob storage", async () => {
    const userId = `${P}dl-missing-storage`;
    const mediaId = `${P}dl-missing-storage-media`;
    await createUser({ id: userId });
    await createMedia({ id: mediaId, ownerId: userId, storageKey: null });
    await prisma.mediaAsset.update({
      where: { id: mediaId },
      data: {
        metadata: {
          providerKey: `${P}generic-provider-key-is-not-blob-authority`,
        },
      },
    });

    const response = await api("GET", `media/${mediaId}/download`, {
      userId,
      ageGate: true,
    });

    expectError(response, 503, "unavailable");
    expect(response.error?.message).toBe(
      "Media storage authority is incomplete",
    );
    const content = await dispatchV1(
      new Request(`http://localhost/api/v1/media/${mediaId}/content`, {
        headers: {
          "x-idream-user-id": userId,
          cookie: AGE_GATE_COOKIE_HEADER,
        },
      }),
      ["media", mediaId, "content"],
    );
    expect(content.status).toBe(503);
  });

  it("serves an absolute remote media authority without treating providerKey as storage", async () => {
    const userId = `${P}dl-remote`;
    const mediaId = `${P}dl-remote-media`;
    const remoteUrl =
      "https://cdn.example.test/idream/remote-authority.webp";
    await createUser({ id: userId });
    await createMedia({
      id: mediaId,
      ownerId: userId,
      storageKey: null,
    });
    await prisma.mediaAsset.update({
      where: { id: mediaId },
      data: {
        url: remoteUrl,
        metadata: {
          providerKey: `${P}remote-provider-projection-only`,
        },
      },
    });

    const download = await api("GET", `media/${mediaId}/download`, {
      userId,
      ageGate: true,
    });
    expectOk(download);
    expect(download.data.url).toBe(remoteUrl);

    const content = await dispatchV1(
      new Request(`http://localhost/api/v1/media/${mediaId}/content`, {
        headers: {
          "x-idream-user-id": userId,
          cookie: AGE_GATE_COOKIE_HEADER,
        },
      }),
      ["media", mediaId, "content"],
    );
    expect(content.status).toBe(302);
    expect(content.headers.get("location")).toBe(remoteUrl);
  });

  it("fails closed when the private blob signer is unavailable", async () => {
    const userId = `${P}dl-sign-failure`;
    const mediaId = `${P}dl-sign-failure-media`;
    await createUser({ id: userId });
    await createMedia({ id: mediaId, ownerId: userId });
    await prisma.mediaAsset.update({
      where: { id: mediaId },
      data: { storageKey: `${P}downloads/sign-failure.webp` },
    });
    const previousBlobProvider = process.env.BLOB_PROVIDER;
    process.env.BLOB_PROVIDER = "s3";
    const signer = vi.spyOn(providers.blob, "signGetUrl").mockResolvedValueOnce({
      ok: false,
      error: {
        code: "sign_failed",
        message: "signer unavailable",
        retryable: true,
      },
    });

    try {
      const response = await api("GET", `media/${mediaId}/download`, {
        userId,
        ageGate: true,
      });

      expectError(response, 503, "unavailable");
      expect(response.error?.message).toBe(
        "Media download is temporarily unavailable",
      );
      expect(response.headers.get("cache-control")).toBe(
        "private, no-store, max-age=0",
      );
      expect(signer).toHaveBeenCalledOnce();
    } finally {
      signer.mockRestore();
      if (previousBlobProvider === undefined) {
        delete process.env.BLOB_PROVIDER;
      } else {
        process.env.BLOB_PROVIDER = previousBlobProvider;
      }
    }
  });
});

describe("generation retry", () => {
  it("creates a derived new job for a failed job and rejects retrying a completed one", async () => {
    const userId = `${P}retry`;
    await createUser({ id: userId });
    await grantCoins(userId, 100, "seed");
    const failed = await prisma.generationJob.create({
      data: {
        id: `${P}job-failed`,
        userId,
        mode: "image",
        ...PINNED_RETRY_JOB_AUTHORITY,
        status: "failed",
        costDreamcoins: 5,
        controls: {},
        presetIds: [],
        errorCode: "internal",
      },
    });
    const retry = await api("POST", `generation/jobs/${failed.id}/retry`, {
      userId,
      ageGate: true,
      headers: { "idempotency-key": `${P}retry-failed-key` },
    });
    expectOk(retry, 202);
    expect(retry.data.job.status).toBe("queued");
    expect(retry.data.job.id).not.toBe(failed.id);
    expect(retry.data.job.derivedFromJobId).toBe(failed.id);
    const original = await prisma.generationJob.findUnique({ where: { id: failed.id } });
    expect(original?.status).toBe("failed");
    await runQueuedGenerationJobs(8);

    const completed = await prisma.generationJob.create({
      data: {
        id: `${P}job-completed`,
        userId,
        mode: "image",
        ...PINNED_RETRY_JOB_AUTHORITY,
        status: "completed",
        costDreamcoins: 10,
        controls: {},
        presetIds: [],
      },
    });
    const bad = await api("POST", `generation/jobs/${completed.id}/retry`, {
      userId,
      ageGate: true,
      headers: { "idempotency-key": `${P}retry-completed-key` },
    });
    expectError(bad, 400, "bad_request");
  });

  it("requires an Idempotency-Key before reserving retry authority", async () => {
    const userId = `${P}retry-missing-key`;
    const failedJobId = `${P}retry-missing-key-job`;
    await createUser({ id: userId });
    await prisma.generationJob.create({
      data: {
        id: failedJobId,
        userId,
        mode: "image",
        ...PINNED_RETRY_JOB_AUTHORITY,
        status: "failed",
        costDreamcoins: 5,
        controls: {},
        presetIds: [],
        errorCode: "provider_timeout",
      },
    });

    const response = await api(
      "POST",
      `generation/jobs/${failedJobId}/retry`,
      {
        userId,
        ageGate: true,
      },
    );

    expectError(response, 400, "bad_request");
    expect(response.error?.message).toBe(
      "Idempotency-Key header is required for generation retry",
    );
    await expect(
      prisma.generationJob.count({
        where: { derivedFromJobId: failedJobId },
      }),
    ).resolves.toBe(0);
  });

  it("replays concurrent retries with one key as one charged derived job", async () => {
    const userId = `${P}retry-same-key`;
    const failedJobId = `${P}retry-same-key-job`;
    const retryKey = `${P}retry-same-key-intent`;
    await createUser({ id: userId });
    await grantCoins(userId, 100, "seed");
    await prisma.generationJob.create({
      data: {
        id: failedJobId,
        userId,
        mode: "image",
        ...PINNED_RETRY_JOB_AUTHORITY,
        status: "failed",
        costDreamcoins: 5,
        controls: {},
        presetIds: [],
        errorCode: "provider_timeout",
      },
    });

    const [first, replay] = await Promise.all([
      api("POST", `generation/jobs/${failedJobId}/retry`, {
        userId,
        ageGate: true,
        headers: { "idempotency-key": retryKey },
      }),
      api("POST", `generation/jobs/${failedJobId}/retry`, {
        userId,
        ageGate: true,
        headers: { "idempotency-key": retryKey },
      }),
    ]);

    expectOk(first, 202);
    expectOk(replay, 202);
    expect(first.data.job.id).toBe(replay.data.job.id);
    const derivedJobs = await prisma.generationJob.findMany({
      where: { derivedFromJobId: failedJobId },
    });
    expect(derivedJobs).toHaveLength(1);
    expect(derivedJobs[0]).toMatchObject({
      id: first.data.job.id,
      idempotencyKey: retryKey,
      status: "queued",
    });
    const spendEntries = await prisma.dreamcoinLedger.findMany({
      where: {
        userId,
        reason: "generation_spend",
        sourceId: derivedJobs[0]!.id,
      },
    });
    expect(spendEntries).toHaveLength(1);
    expect(spendEntries[0]?.delta).toBe(-derivedJobs[0]!.costDreamcoins);
  });

  it("serializes distinct retry intents at three jobs and rejects the fourth", async () => {
    const userId = `${P}retry-limit`;
    const failedJobId = `${P}retry-limit-job`;
    await createUser({ id: userId });
    await grantCoins(userId, 1_000, "seed");
    await prisma.generationJob.create({
      data: {
        id: failedJobId,
        userId,
        mode: "image",
        ...PINNED_RETRY_JOB_AUTHORITY,
        status: "failed",
        costDreamcoins: 5,
        controls: {},
        presetIds: [],
        errorCode: "provider_timeout",
      },
    });

    const accepted = await Promise.all(
      [1, 2, 3].map((attempt) =>
        api("POST", `generation/jobs/${failedJobId}/retry`, {
          userId,
          ageGate: true,
          headers: {
            "idempotency-key": `${P}retry-limit-intent-${attempt}`,
          },
        }),
      ),
    );
    for (const response of accepted) expectOk(response, 202);
    expect(new Set(accepted.map((response) => response.data.job.id)).size).toBe(
      3,
    );

    const rejected = await api(
      "POST",
      `generation/jobs/${failedJobId}/retry`,
      {
        userId,
        ageGate: true,
        headers: {
          "idempotency-key": `${P}retry-limit-intent-4`,
        },
      },
    );

    expectError(rejected, 429, "rate_limited");
    expect(rejected.error?.details).toMatchObject({ retries: 3, max: 3 });
    await expect(
      prisma.generationJob.count({
        where: { derivedFromJobId: failedJobId },
      }),
    ).resolves.toBe(3);
    await expect(
      prisma.dreamcoinLedger.count({
        where: {
          userId,
          reason: "generation_spend",
          sourceId: { in: accepted.map((response) => response.data.job.id) },
        },
      }),
    ).resolves.toBe(3);
  });
});

describe("Character archive and generation authority", () => {
  it("blocks archive while generation is active and never revives an archived Character through create or retry", async () => {
    const userId = `${P}archive-owner`;
    const characterId = `${P}archive-character`;
    const activeJobId = `${P}archive-active-job`;
    await createUser({ id: userId });
    await createCharacter({
      id: characterId,
      creatorId: userId,
      visibility: "private",
      status: "approved",
    });
    await grantCoins(userId, 100, "seed");
    await prisma.generationJob.create({
      data: {
        id: activeJobId,
        userId,
        characterId,
        mode: "image",
        status: "queued",
        controls: {},
        presetIds: [],
        costDreamcoins: 5,
      },
    });

    const blockedArchive = await api("DELETE", `characters/${characterId}`, {
      userId,
      ageGate: true,
    });
    expectError(blockedArchive, 409, "conflict");
    expect(blockedArchive.error?.details).toMatchObject({
      characterId,
      generationJobId: activeJobId,
      generationStatus: "queued",
    });
    await expect(
      prisma.character.findUniqueOrThrow({ where: { id: characterId } }),
    ).resolves.toMatchObject({ deletedAt: null, status: "approved" });

    await prisma.generationJob.update({
      where: { id: activeJobId },
      data: { status: "failed", errorCode: "worker_failed" },
    });
    const archived = await api("DELETE", `characters/${characterId}`, {
      userId,
      ageGate: true,
    });
    expectOk(archived);
    await expect(
      prisma.character.findUniqueOrThrow({ where: { id: characterId } }),
    ).resolves.toMatchObject({
      status: "archived",
      deletedAt: expect.any(Date),
      imageAssetId: null,
    });
    await expect(
      prisma.mainOutboxEvent.findFirstOrThrow({
        where: {
          eventType: MAIN_TO_CHAT_EVENTS.characterRemoved,
          aggregateType: "character",
          aggregateId: characterId,
        },
        orderBy: { createdAt: "desc" },
      }),
    ).resolves.toMatchObject({
      eventType: MAIN_TO_CHAT_EVENTS.characterRemoved,
      aggregateType: "character",
      aggregateId: characterId,
      payload: expect.objectContaining({
        eventType: MAIN_TO_CHAT_EVENTS.characterRemoved,
        payload: { characterId },
      }),
    });

    const createAfterArchive = await api("POST", "generation/jobs", {
      userId,
      ageGate: true,
      body: {
        mode: "image",
        characterId,
        outputCount: 1,
      },
    });
    expectError(createAfterArchive, 404, "not_found");

    const retryAfterArchive = await api(
      "POST",
      `generation/jobs/${activeJobId}/retry`,
      {
        userId,
        ageGate: true,
        headers: { "idempotency-key": `${P}retry-archived-key` },
      },
    );
    expectError(retryAfterArchive, 409, "conflict");
    await expect(prisma.generationJob.count({
      where: { derivedFromJobId: activeJobId },
    })).resolves.toBe(0);
  });
});

describe("billing portal", () => {
  it("returns an upgrade URL when the authenticated user has no active subscription", async () => {
    const userId = `${P}portal`;
    await createUser({ id: userId });
    const res = await api("POST", "billing/portal", { userId });
    expectOk(res);
    expect(res.data).toMatchObject({ mode: "subscribe", url: "/upgrade", subscription: null });
  });
});
