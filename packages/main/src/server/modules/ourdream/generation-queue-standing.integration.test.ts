import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/server/lib/db";
import { createUser } from "@/server/test/helpers";
import { estimateGenerationQueueSeconds, GENERATION_MIN_DURATION_SAMPLES, readGenerationQueueStandings, resetGenerationDurationCache, secondsPerOutputFromSamples } from "./generation-queue-standing";

const userId = `queue-standing-user-${randomUUID()}`;
const jobIds: string[] = [];
const base = Date.now() - 3_600_000;

async function request(input: { mode: "image" | "video"; status?: string; attemptStatus?: string; provider?: string; sourceType?: string; outputCount?: number; offsetMs: number; startedAt?: Date | null; finishedAt?: Date | null }) {
  const id = `queue-standing-${randomUUID()}`;
  jobIds.push(id);
  const createdAt = new Date(base + input.offsetMs);
  await prisma.generationJob.create({ data: { id, userId, mode: input.mode, controls: {}, presetIds: [], outputCount: input.outputCount ?? 1, status: input.status ?? "queued", provider: input.provider ?? "mock", sourceType: input.sourceType ?? "generator" } });
  await prisma.generationAttempt.create({ data: { requestId: id, attemptNo: 1, provider: input.provider ?? "mock", status: input.attemptStatus ?? "queued", createdAt, startedAt: input.startedAt ?? null, finishedAt: input.finishedAt ?? null } });
  return id;
}

async function standing(id: string) {
  return (await readGenerationQueueStandings([id])).get(id);
}

describe("generation queue standing", () => {
  beforeEach(() => resetGenerationDurationCache());
  afterAll(async () => {
    await prisma.generationAttempt.deleteMany({ where: { requestId: { in: jobIds } } });
    await prisma.generationJob.deleteMany({ where: { id: { in: jobIds } } });
    await prisma.user.deleteMany({ where: { id: userId } });
  });

  it("counts what is really ahead on the shared device, which differs by modality", async () => {
    await createUser({ id: userId });
    // Other suites may leave active rows in this database, so assert relative to a
    // request older than everything created here.
    const oldest = await request({ mode: "image", offsetMs: 0 });
    const baseline = (await standing(oldest))!.queueAhead;

    await request({ mode: "video", offsetMs: 1_000 });
    await request({ mode: "image", offsetMs: 2_000 });
    const image = await request({ mode: "image", offsetMs: 3_000 });
    const video = await request({ mode: "video", offsetMs: 4_000 });
    // Newer than both, but holding the device, so it is ahead of both.
    await request({ mode: "video", attemptStatus: "running", status: "queued", startedAt: new Date(), offsetMs: 5_000 });
    // Sequence scene waiting on an earlier scene: nowhere near the device yet.
    const deferred = await request({ mode: "video", sourceType: "video_sequence_scene", offsetMs: 1_500 });
    // The recolor route runs on the CPU and never takes the device lease.
    const recolor = await request({ mode: "image", provider: "local-image", offsetMs: 1_600 });

    // An image passes queued videos: oldest + older image + the running video.
    await expect(standing(image)).resolves.toMatchObject({ queueAhead: baseline + 3 });
    // A video waits behind all of it: the three above, its older video, the older image.
    await expect(standing(video)).resolves.toMatchObject({ queueAhead: baseline + 5 });
    await expect(standing(deferred)).resolves.toBeUndefined();
    await expect(standing(recolor)).resolves.toBeUndefined();
  });

  it("gives no standing to anything no longer waiting", async () => {
    const started = await request({ mode: "image", attemptStatus: "running", startedAt: new Date(), offsetMs: 6_000 });
    const finished = await request({ mode: "image", status: "completed", attemptStatus: "succeeded", startedAt: new Date(base), finishedAt: new Date(base + 1_000), offsetMs: 7_000 });
    await expect(readGenerationQueueStandings([started, finished])).resolves.toEqual(new Map());
  });

  it("issues no query at all when nothing is waiting, since these routes are polled", async () => {
    const raw = vi.spyOn(prisma, "$queryRaw");
    await expect(readGenerationQueueStandings([])).resolves.toEqual(new Map());
    expect(raw).not.toHaveBeenCalled();
    raw.mockRestore();
  });

  it("derives the estimate from recent real render times per output, and caches it", async () => {
    const finishedAt = new Date();
    const render = (seconds: number) => ({ startedAt: new Date(finishedAt.getTime() - seconds * 1000), finishedAt });
    // Newest samples win the window, so these decide the median whatever else is here.
    const now = Date.now() - base;
    await Promise.all(Array.from({ length: 100 }, (_, index) => request({ mode: "image", status: "completed", attemptStatus: "succeeded", outputCount: 2, offsetMs: now + index, ...render(120) })));
    await Promise.all(Array.from({ length: 100 }, (_, index) => request({ mode: "video", status: "completed", attemptStatus: "succeeded", offsetMs: now + index, ...render(300) })));

    const waiting = await request({ mode: "image", offsetMs: 8_000, outputCount: 2 });
    const { queueAhead, queueEtaSeconds } = (await standing(waiting))!;
    expect(queueAhead).toBeGreaterThan(0);
    // 60s per image output: own two outputs alone are 120s.
    expect(queueEtaSeconds).toBeGreaterThanOrEqual(120 + 60);

    const raw = vi.spyOn(prisma, "$queryRaw");
    await standing(waiting);
    expect(raw).toHaveBeenCalledTimes(1);
    raw.mockRestore();
  });
});

describe("generation queue estimate", () => {
  const known = { image: 60, video: 300 };
  const input = { mode: "video" as const, outputCount: 1, aheadImageOutputs: 2, aheadVideoOutputs: 1, capped: false, secondsPerOutput: known };

  it("sums the work ahead and this request's own render", () => {
    expect(estimateGenerationQueueSeconds(input)).toBe(2 * 60 + 300 + 300);
  });

  it("shows nothing rather than guess", () => {
    expect(estimateGenerationQueueSeconds({ ...input, secondsPerOutput: { image: 60 } })).toBeNull();
    // Own route known, but the video ahead of this image is not.
    expect(estimateGenerationQueueSeconds({ ...input, mode: "image", secondsPerOutput: { image: 60 } })).toBeNull();
    // A capped count is only a lower bound.
    expect(estimateGenerationQueueSeconds({ ...input, capped: true })).toBeNull();
  });

  it("does not need figures for a modality that is not ahead", () => {
    expect(estimateGenerationQueueSeconds({ ...input, mode: "image", aheadVideoOutputs: 0, secondsPerOutput: { image: 60 } })).toBe(2 * 60 + 60);
  });

  it("refuses a figure drawn from too few runs", () => {
    expect(secondsPerOutputFromSamples([
      { mode: "image", samples: GENERATION_MIN_DURATION_SAMPLES - 1, seconds: 60 },
      { mode: "video", samples: GENERATION_MIN_DURATION_SAMPLES, seconds: 300 },
    ])).toEqual({ video: 300 });
  });
});
