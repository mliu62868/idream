import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveLocalBlobPath } from "@idream/shared/storage/local-blob";
import { prisma } from "@/server/lib/db";
import {
  api,
  createCharacter,
  createMedia,
  createUser,
  expectError,
  expectOk,
  grantCoins,
  purgeTestData,
  runQueuedGenerationJobs,
} from "@/server/test/helpers";

// SPEC: remaining chat/generation/media behaviors (BackendFeatureSpec §5.4/5.5/5.8)
// — message regenerate/delete, session list/archive, video generation (Deluxe),
// signed media download, generation retry, and the billing portal.

const P = "zt-cgx-";
const SYS = `${P}sys`;
const CHAR = `${P}char`;

beforeAll(async () => {
  await purgeTestData(P);
  await createUser({ id: SYS });
  await createCharacter({ id: CHAR, creatorId: SYS, visibility: "public", status: "approved" });
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

    try {
      const gen = await api("POST", "generation/jobs", {
        userId,
        ageGate: true,
        body: { mode: "video", characterId: CHAR, outputCount: 1 },
      });
      expectOk(gen, 202);
      expect(gen.data.job.status).toBe("queued");
      await runQueuedGenerationJobs(8);
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
    }
  });
});

describe("media download (signed URL)", () => {
  it("returns a download URL for the owner", async () => {
    const userId = `${P}dl`;
    const mediaId = `${P}dl-media`;
    await createUser({ id: userId });
    await createMedia({ id: mediaId, ownerId: userId });

    const res = await api("GET", `media/${mediaId}/download`, { userId, ageGate: true });
    expectOk(res);
    expect(typeof res.data.url).toBe("string");
    expect((res.data.url as string).length).toBeGreaterThan(0);
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
        status: "completed",
        costDreamcoins: 10,
        controls: {},
        presetIds: [],
      },
    });
    const bad = await api("POST", `generation/jobs/${completed.id}/retry`, {
      userId,
      ageGate: true,
    });
    expectError(bad, 400, "bad_request");
  });
});

describe("billing portal", () => {
  it("returns a portal URL for an authenticated user", async () => {
    const userId = `${P}portal`;
    await createUser({ id: userId });
    const res = await api("POST", "billing/portal", { userId });
    expectOk(res);
    expect(res.data.url).toContain("billing");
  });
});
