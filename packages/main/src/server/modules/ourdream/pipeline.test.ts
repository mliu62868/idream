import { deflateSync } from "node:zlib";
import type { Prisma } from "@prisma/client";
import {
  generationTerminalRecordChecksum,
  generationTerminalRecordSchema,
} from "@idream/shared/contracts";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@/server/lib/db";
import { jobQueue } from "@/server/jobs/queue";
import { retryGenerationRequest } from "@/server/ai/generation-request-lifecycle";
import {
  dispatchPendingGenerationTerminalRecords,
  ingestGenerationTerminalRecord,
} from "@/server/ai/generation-terminal-record-ingest";
import { dispatchGenerationAttemptOutbox } from "@/server/modules/generation/generation-attempt-authority";
import { reconcileUnknownGenerationRequest } from "@/server/modules/admin-v2/jobs/unknown-reconciliation";
import {
  api,
  createCharacter,
  createUser,
  dreamcoinBalance,
  expectError,
  expectOk,
  generationTestProviders,
  grantCoins,
  publishCharacterForPublicAudience,
  purgeTestData,
  runQueuedGenerationJobs,
} from "@/server/test/helpers";

const P = "zt-pipe-";
const SYS = `${P}sys`;
const CHAR = `${P}char`;
const cleanupJobDedupeKeys: string[] = [];
const cleanupModerationTargetIds: string[] = [];
let genProviders: Awaited<ReturnType<typeof generationTestProviders>>;

beforeAll(async () => {
  genProviders = await generationTestProviders();
  await purgeTestData(P);
  await createUser({ id: SYS, dataClass: "customer" });
  await createCharacter({
    id: CHAR,
    creatorId: SYS,
    visibility: "public",
    status: "approved",
    systemPrompt: "Stay warm and concise.",
  });
  await prisma.characterVisualProfile.create({
    data: {
      id: `${P}bootstrap-visual-profile`,
      characterId: CHAR,
      version: 1,
      status: "active",
      style: "realistic",
      identityPrompt: "Test Character, adult woman",
      faceTraits: {},
      hairTraits: {},
      bodyTraits: {},
      signatureTraits: {},
      styleTraits: {},
      anchorAssetIds: [],
      adapterRefs: {},
      createdFrom: "generation_bootstrap:test",
    },
  });
  await publishCharacterForPublicAudience({
    characterId: CHAR,
    ownerId: SYS,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  for (const dedupeKey of cleanupJobDedupeKeys) {
    await jobQueue.removeByDedupePrefix(dedupeKey, [
      "ai.image.generate",
      "ai.video.generate",
      "app.ai.finalize",
    ]);
  }
  await prisma.moderationEvent.deleteMany({
    where: { targetId: { in: cleanupModerationTargetIds } },
  });
  await purgeTestData(P);
  await prisma.$disconnect();
});

async function requeueAsFinalAttempt(
  queue: "ai.image.generate" | "ai.video.generate",
  jobId: string,
  payloadPatch: Record<string, unknown> = {},
) {
  const dedupeKey = `generation:${jobId}:attempt:1`;
  const queued = await jobQueue.getByDedupeKey(queue, dedupeKey);
  expect(queued).not.toBeNull();
  if (!queued) throw new Error(`Missing queued ${queue} job for ${jobId}`);

  await jobQueue.removeByDedupePrefix(dedupeKey, [queue]);
  await jobQueue.enqueue({
    queue,
    payload: {
      ...(queued.payload as Record<string, unknown>),
      ...payloadPatch,
    } as Prisma.InputJsonValue,
    dedupeKey,
    maxAttempts: 1,
  });
}

async function generationTerminalFixture(
  generationJobId: string,
  attemptId: string,
  outcome: Record<string, unknown>,
) {
  const attempt = await prisma.generationAttempt.findUniqueOrThrow({
    where: { id: attemptId },
  });
  const dispatch = await prisma.mainOutboxEvent.findFirstOrThrow({
    where: {
      aggregateType: "generation_request",
      aggregateId: generationJobId,
      payload: { path: ["attemptId"], equals: attempt.id },
    },
  });
  const queueInput = (dispatch.payload as Record<string, unknown>)
    .queueInput as Record<string, unknown>;
  const queuePayload = queueInput.payload as Record<string, unknown>;
  const terminalRecord = generationTerminalRecordSchema.parse({
    version: 1,
    attemptId: attempt.id,
    attemptNo: attempt.attemptNo,
    transportAttemptNo: 1,
    providerIdempotencyKey: `generation:${attempt.id}:provider`,
    requestId: queuePayload.requestId,
    generationJobId,
    mode: queuePayload.kind,
    provider: queuePayload.provider,
    providerInvoked: true,
    model: queuePayload.model,
    providerRequestId: `test-provider-${attempt.id}`,
    completedAt: new Date().toISOString(),
    usage: {},
    ...outcome,
  });
  return {
    terminalRecordRef: `gen/terminal-records/${attempt.id}/terminal.json`,
    terminalRecordChecksum: generationTerminalRecordChecksum(terminalRecord),
    terminalRecord,
  };
}

// SPEC: 断言「没有任何产物字节落盘」。
// INTENT: terminal record 自己也走 putPrivateIfAbsent（gen/terminal-records/…），失败路径本来
// 就会写它——早先这里 spy 的是 putPrivate，生成路径改用 putPrivateIfAbsent 后断言变成永真，
// 抓不到任何东西。按 key 前缀把两者分开，断言才重新有牙齿。
function artifactWriteKeys(spy: { mock: { calls: readonly (readonly [{ key: string }])[] } }) {
  return spy.mock.calls
    .map(([input]) => input.key)
    .filter((key) => !key.startsWith("gen/terminal-records/"));
}

describe("local AI service pipeline", () => {
  it("queues image generation and creates media through the finalize queue", async () => {
    const userId = `${P}gen-user`;
    await createUser({ id: userId });
    await grantCoins(userId, 100, "seed");

    const gen = await api("POST", "generation/jobs", {
      userId,
      ageGate: true,
      body: { mode: "image", characterId: CHAR, outputCount: 2 },
    });
    expectOk(gen, 202);
    const jobId = gen.data.job.id as string;
    cleanupJobDedupeKeys.push(
      `generation:${jobId}`,
      `generation-finalize:${jobId}:completed`,
    );
    cleanupModerationTargetIds.push(jobId);

    expect(gen.status).toBe(202);
    expect(gen.data.job.status).toBe("queued");
    expect(gen.data.assets).toHaveLength(0);

    const queuedGenerateJob = await jobQueue.getByDedupeKey("ai.image.generate", `generation:${jobId}:attempt:1`);
    expect(queuedGenerateJob?.payload).toMatchObject({
      controls: {
        profileId: "profile_image_default_v1",
        width: 512,
        height: 512,
        modelCapabilities: expect.objectContaining({
          referenceImages: false,
          initImage: false,
        }),
      },
    });
    expect((queuedGenerateJob?.payload as { controls?: unknown })?.controls).not.toHaveProperty("sdcpp");

    await runQueuedGenerationJobs(8);
    const completed = await api("GET", `generation/jobs/${jobId}`, { userId, ageGate: true });
    expectOk(completed);
    expect(completed.data.job.status).toBe("completed");
    expect(completed.data.assets).toHaveLength(2);
    await expect(prisma.generationJob.findUnique({ where: { id: jobId } })).resolves.toMatchObject({
      status: "completed",
      deliveredOutputCount: 2,
      // Gen owns provider execution, so Main observes only moderating_output
      // and completed instead of the former inline running sub-transitions.
      version: 3,
      finishedAt: expect.any(Date),
      completedAt: expect.any(Date),
    });
    await expect(prisma.generationSettlementLink.count({ where: { requestId: jobId } })).resolves.toBe(1);

    const generateJob = await jobQueue.getByDedupeKey("ai.image.generate", `generation:${jobId}:attempt:1`);
    const finalizeJob = await jobQueue.getByDedupeKey(
      "app.ai.finalize",
      `generation-finalize:${jobId}:completed`,
    );
    expect(generateJob).toBeNull();
    expect(finalizeJob).toBeNull();
    await expect(
      prisma.mainOutboxEvent.findFirst({
        where: {
          aggregateType: "generation_attempt",
          payload: { path: ["generationJobId"], equals: jobId },
        },
      }),
    ).resolves.toMatchObject({ status: "delivered" });
    expect(completed.data.job.controls).not.toHaveProperty("sdcpp");

    const asset = await prisma.mediaAsset.findFirstOrThrow({
      where: { sourceJobId: jobId },
    });
    expect(asset.metadata).toMatchObject({
      provider: "comfyui",
      contentType: "image/png",
      synthetic: false,
    });
  });

  it("fails and refunds image generation when provider output is blank", async () => {
    const userId = `${P}blank-image-user`;
    await createUser({ id: userId });
    await grantCoins(userId, 100, "seed");
    const imageGenerate = vi.spyOn(genProviders.image, "generate").mockResolvedValueOnce({
      ok: true,
      data: {
        assets: [
          {
            key: "pipeline/blank.png",
            width: 4,
            height: 4,
            contentType: "image/png",
            body: whitePng(4, 4),
          },
        ],
      },
    });
    const blobPut = vi.spyOn(genProviders.blob, "putPrivateIfAbsent");

    const gen = await api("POST", "generation/jobs", {
      userId,
      ageGate: true,
      body: { mode: "image", characterId: CHAR, outputCount: 1 },
    });
    expectOk(gen, 202);
    const jobId = gen.data.job.id as string;
    cleanupJobDedupeKeys.push(`generation:${jobId}`, `generation-finalize:${jobId}:failed`);
    cleanupModerationTargetIds.push(jobId);
    await requeueAsFinalAttempt("ai.image.generate", jobId);

    await runQueuedGenerationJobs(8);

    expect(imageGenerate).toHaveBeenCalledTimes(1);
    expect(artifactWriteKeys(blobPut)).toEqual([]);
    const poll = await api("GET", `generation/jobs/${jobId}`, { userId, ageGate: true });
    expectOk(poll);
    expect(poll.data.job.status).toBe("failed");
    expect(poll.data.job.errorCode).toBe("asset_quality_failed");
    expect(await dreamcoinBalance(userId)).toBe(100);
    expect(await prisma.mediaAsset.count({ where: { sourceJobId: jobId } })).toBe(0);
    await expect(prisma.generationJob.findUnique({ where: { id: jobId } })).resolves.toMatchObject({
      status: "failed",
      deliveredOutputCount: 0,
      finishedAt: expect.any(Date),
      completedAt: null,
    });
    await expect(prisma.generationSettlementLink.count({ where: { requestId: jobId } })).resolves.toBe(2);
  });

  it("does not persist a multi-panel image when a single continuous frame is required", async () => {
    const userId = `${P}composite-image-user`;
    await createUser({ id: userId });
    await grantCoins(userId, 100, "seed");
    vi.spyOn(genProviders.image, "generate").mockResolvedValueOnce({
      ok: true,
      data: {
        assets: [
          {
            key: "pipeline/contact-sheet.png",
            width: 80,
            height: 100,
            contentType: "image/png",
            body: contactSheetPng(),
          },
        ],
      },
    });
    const blobPut = vi.spyOn(genProviders.blob, "putPrivateIfAbsent");

    const gen = await api("POST", "generation/jobs", {
      userId,
      ageGate: true,
      body: {
        mode: "image",
        characterId: CHAR,
        outputCount: 1,
      },
    });
    expectOk(gen, 202);
    const jobId = gen.data.job.id as string;
    cleanupJobDedupeKeys.push(
      `generation:${jobId}`,
      `generation-finalize:${jobId}:failed`,
    );
    cleanupModerationTargetIds.push(jobId);
    await requeueAsFinalAttempt("ai.image.generate", jobId, {
      controls: {
        compositionRequirement: "single_subject_single_frame",
      },
    });

    await runQueuedGenerationJobs(8);

    const poll = await api("GET", `generation/jobs/${jobId}`, {
      userId,
      ageGate: true,
    });
    expectOk(poll);
    expect(poll.data.job).toMatchObject({
      status: "failed",
      errorCode: "asset_quality_failed",
    });
    expect(artifactWriteKeys(blobPut)).toEqual([]);
    expect(
      await prisma.mediaAsset.count({ where: { sourceJobId: jobId } }),
    ).toBe(0);
    await expect(
      prisma.generationJob.findUniqueOrThrow({ where: { id: jobId } }),
    ).resolves.toMatchObject({ deliveredOutputCount: 0 });
  });

  it("runs Character Preview through the formal Generation Attempt and recovers its Outbox", async () => {
    const userId = `${P}preview-throw-user`;
    await createUser({ id: userId });

    const draft = await api("POST", "character-drafts", {
      userId,
      ageGate: true,
      body: { name: "Preview Throw", gender: "female", style: "realistic" },
    });
    expectOk(draft);
    const draftId = draft.data.draft.id as string;
    const preview = await api("POST", `character-drafts/${draftId}/preview`, {
      userId,
      ageGate: true,
    });
    expectOk(preview);
    const previewJobId = preview.data.previewJob.id as string;
    const generationJob = await prisma.generationJob.findFirstOrThrow({
      where: { sourceType: "character_preview", sourceId: previewJobId },
    });
    const attempt = await prisma.generationAttempt.findFirstOrThrow({
      where: { requestId: generationJob.id },
    });
    const outboxId = `generation_initial_${generationJob.id}`;
    cleanupJobDedupeKeys.push(`generation:${generationJob.id}`);
    expect(generationJob).toMatchObject({
      userId,
      mode: "image",
      costDreamcoins: 0,
      sourceType: "character_preview",
      sourceId: previewJobId,
    });
    expect(attempt).toMatchObject({ attemptNo: 1, status: "queued" });
    await expect(
      prisma.mainOutboxEvent.findUniqueOrThrow({ where: { id: outboxId } }),
    ).resolves.toMatchObject({ status: "delivered" });

    await jobQueue.removeByDedupePrefix(
      `generation:${generationJob.id}`,
      ["ai.image.generate"],
    );
    await prisma.mainOutboxEvent.update({
      where: { id: outboxId },
      data: { status: "pending", deliveredAt: null, nextRunAt: new Date() },
    });
    await expect(
      dispatchGenerationAttemptOutbox(prisma, { outboxIds: [outboxId] }),
    ).resolves.toMatchObject({ delivered: 1, failed: 0 });

    const previewQueueJob = await jobQueue.getByDedupeKey(
      "ai.image.generate",
      `generation:${generationJob.id}:attempt:1`,
    );
    expect(previewQueueJob).toMatchObject({
      queue: "ai.image.generate",
      state: "waiting",
      payload: expect.objectContaining({
        kind: "image",
        generationJobId: generationJob.id,
        attemptId: attempt.id,
        attemptNo: 1,
        userId,
        model: expect.not.stringContaining("mock"),
      }),
    });

    await runQueuedGenerationJobs(4);

    const status = await api("GET", `character-drafts/${draftId}/preview`, {
      userId,
      ageGate: true,
    });
    expectOk(status);
    expect(status.data.previewJob).toMatchObject({
      status: "completed",
      resultAssetId: expect.any(String),
    });
    expect(status.data.asset).toMatchObject({
      id: status.data.previewJob.resultAssetId,
    });
    await expect(
      prisma.mediaAsset.findUniqueOrThrow({
        where: { id: status.data.previewJob.resultAssetId as string },
      }),
    ).resolves.toMatchObject({ sourceJobId: generationJob.id });
  });

  it("polls the exact Preview Job while overlapping previews are active", async () => {
    const userId = `${P}preview-exact-poll-user`;
    await createUser({ id: userId });
    const draft = await api("POST", "character-drafts", {
      userId,
      ageGate: true,
      body: { name: "Preview Poll", gender: "female", style: "realistic" },
    });
    expectOk(draft);
    const draftId = draft.data.draft.id as string;
    const first = await api("POST", `character-drafts/${draftId}/preview`, {
      userId,
      ageGate: true,
    });
    const second = await api("POST", `character-drafts/${draftId}/preview`, {
      userId,
      ageGate: true,
    });
    expectOk(first);
    expectOk(second);
    const firstId = first.data.previewJob.id as string;
    const secondId = second.data.previewJob.id as string;
    expect(firstId).not.toBe(secondId);

    const generationJobs = await prisma.generationJob.findMany({
      where: {
        sourceType: "character_preview",
        sourceId: { in: [firstId, secondId] },
      },
    });
    cleanupJobDedupeKeys.push(
      ...generationJobs.map((job) => `generation:${job.id}`),
    );
    const firstStatus = await api(
      "GET",
      `character-drafts/${draftId}/preview`,
      { userId, ageGate: true, query: { previewJobId: firstId } },
    );
    const secondStatus = await api(
      "GET",
      `character-drafts/${draftId}/preview`,
      { userId, ageGate: true, query: { previewJobId: secondId } },
    );
    const latestStatus = await api(
      "GET",
      `character-drafts/${draftId}/preview`,
      { userId, ageGate: true },
    );

    expectOk(firstStatus);
    expectOk(secondStatus);
    expectOk(latestStatus);
    expect(firstStatus.data.previewJob.id).toBe(firstId);
    expect(secondStatus.data.previewJob.id).toBe(secondId);
    expect(latestStatus.data.previewJob.id).toBe(secondId);
    // INTENT: this test asserts polling identity while both jobs are queued; it
    // must not leave either Generate row for the next test's one-shot provider
    // failure mock to consume.
    for (const job of generationJobs) {
      await jobQueue.removeByDedupePrefix(`generation:${job.id}`, [
        "ai.image.generate",
      ]);
    }
  });

  it("replays one Character Preview reservation when its response is lost", async () => {
    const userId = `${P}preview-idempotent-user`;
    await createUser({ id: userId });
    const draft = await api("POST", "character-drafts", {
      userId,
      ageGate: true,
      body: { name: "Preview Replay", gender: "female", style: "realistic" },
    });
    expectOk(draft);
    const draftId = draft.data.draft.id as string;
    const idempotencyKey = `${P}preview-response-lost`;

    const first = await api("POST", `character-drafts/${draftId}/preview`, {
      userId,
      ageGate: true,
      headers: { "Idempotency-Key": idempotencyKey },
    });
    const replay = await api("POST", `character-drafts/${draftId}/preview`, {
      userId,
      ageGate: true,
      headers: { "Idempotency-Key": idempotencyKey },
    });
    expectOk(first);
    expectOk(replay);
    expect(replay.data.previewJob.id).toBe(first.data.previewJob.id);

    const generationJobs = await prisma.generationJob.findMany({
      where: { userId, idempotencyKey },
    });
    expect(generationJobs).toHaveLength(1);
    expect(generationJobs[0]?.momentSpec).toMatchObject({
      requestFingerprint: expect.any(String),
    });
    cleanupJobDedupeKeys.push(`generation:${generationJobs[0]!.id}`);
    await expect(
      prisma.generationAttempt.count({
        where: { requestId: generationJobs[0]!.id },
      }),
    ).resolves.toBe(1);

    const crossCommandReplay = await api("POST", "generation/jobs", {
      userId,
      ageGate: true,
      headers: { "Idempotency-Key": idempotencyKey },
      body: { mode: "image", characterId: CHAR, outputCount: 1 },
    });
    expectError(crossCommandReplay, 409, "conflict");
    expect(crossCommandReplay.error?.message).toContain(
      "Idempotency-Key was already used for a different generation request",
    );
    // INTENT: this test stops at reservation replay and never invokes Gen. The
    // queued fixture must not consume a later test's one-shot provider mock.
    await expect(
      jobQueue.removeByDedupePrefix(`generation:${generationJobs[0]!.id}`, [
        "ai.image.generate",
      ]),
    ).resolves.toBe(1);
    await expect(
      jobQueue.getByDedupeKey(
        "ai.image.generate",
        `generation:${generationJobs[0]!.id}:attempt:1`,
      ),
    ).resolves.toBeNull();
  });

  it("requires Character Preview callers to provide a durable idempotency key", async () => {
    const userId = `${P}preview-missing-key-user`;
    await createUser({ id: userId });
    const draft = await api("POST", "character-drafts", {
      userId,
      ageGate: true,
      body: { name: "Preview Key", gender: "female", style: "realistic" },
    });
    expectOk(draft);

    const response = await api(
      "POST",
      `character-drafts/${draft.data.draft.id as string}/preview`,
      {
        userId,
        ageGate: true,
        autoGenerationIdempotencyKey: false,
      },
    );

    expectError(response, 400, "bad_request");
    expect(response.error?.message).toContain("Idempotency-Key");
  });

  it("projects unknown, business retry, blocked replay, and late results through Generation authority", async () => {
    const userId = `${P}preview-no-body-user`;
    await createUser({ id: userId });

    const draft = await api("POST", "character-drafts", {
      userId,
      ageGate: true,
      body: { name: "Preview Missing Bytes", gender: "female", style: "realistic" },
    });
    expectOk(draft);
    const draftId = draft.data.draft.id as string;
    const preview = await api("POST", `character-drafts/${draftId}/preview`, {
      userId,
      ageGate: true,
    });
    expectOk(preview);
    const previewJobId = preview.data.previewJob.id as string;
    const generationJob = await prisma.generationJob.findFirstOrThrow({
      where: { sourceType: "character_preview", sourceId: previewJobId },
    });
    const firstAttempt = await prisma.generationAttempt.findFirstOrThrow({
      where: { requestId: generationJob.id, attemptNo: 1 },
    });
    cleanupJobDedupeKeys.push(`generation:${generationJob.id}`);
    await jobQueue.removeByDedupePrefix(
      `generation:${generationJob.id}`,
      ["ai.image.generate"],
    );
    const unknownTerminal = await generationTerminalFixture(
      generationJob.id,
      firstAttempt.id,
      {
        outcome: "unknown",
        error: {
          code: "preview_provider_unknown",
          message: "Provider outcome is ambiguous",
          retryability: "operator_retry",
        },
      },
    );
    await expect(ingestGenerationTerminalRecord(unknownTerminal)).resolves
      .toMatchObject({ acknowledged: true, status: "persisted" });
    await expect(dispatchPendingGenerationTerminalRecords({
      outboxIds: [`generation_terminal_record_${firstAttempt.id}`],
    })).resolves.toBe(1);

    await expect(runQueuedGenerationJobs(2, ["app.ai.finalize"])).resolves
      .toMatchObject({ processed: 1 });

    const unknownStatus = await api("GET", `character-drafts/${draftId}/preview`, {
      userId,
      ageGate: true,
    });
    expectOk(unknownStatus);
    expect(unknownStatus.data.previewJob).toMatchObject({
      status: "queued",
      errorCode: null,
    });
    expect(unknownStatus.data.asset).toBeNull();
    await expect(
      prisma.generationAttempt.findUniqueOrThrow({ where: { id: firstAttempt.id } }),
    ).resolves.toMatchObject({ status: "unknown", retryability: "operator_retry" });

    const failedRequest = await prisma.generationJob.findUniqueOrThrow({
      where: { id: generationJob.id },
    });
    await expect(retryGenerationRequest({
      requestId: generationJob.id,
      expectedVersion: failedRequest.version,
      actor: { id: userId, role: "user" },
      reason: "A business retry cannot bypass unknown reconciliation",
      idempotencyKey: `preview-unsafe-retry-${previewJobId}`,
      traceId: `preview-unsafe-retry-trace-${previewJobId}`,
    })).rejects.toMatchObject({ status: 409 });
    const reconciled = await reconcileUnknownGenerationRequest({
      requestId: generationJob.id,
      command: {
        entityVersion: failedRequest.version,
        resolution: "confirm_failed",
        reason: "Provider evidence confirms the Preview request failed",
        providerEvidenceRefs: [`test://provider/${firstAttempt.id}`],
        confirmation: `${generationJob.id}:confirm_failed`,
      },
      actor: { id: SYS, role: "ops" },
      idempotencyKey: `preview-confirm-failed-${previewJobId}`,
      traceId: `preview-confirm-failed-trace-${previewJobId}`,
    });
    expect(reconciled).toMatchObject({
      resolution: "confirm_failed",
      requestStatus: "failed",
      attemptId: firstAttempt.id,
    });
    const retried = await retryGenerationRequest({
      requestId: generationJob.id,
      expectedVersion: reconciled.version,
      actor: { id: userId, role: "user" },
      reason: "Retry the ambiguous Character Preview through a new Attempt",
      idempotencyKey: `preview-retry-${previewJobId}`,
      traceId: `preview-retry-trace-${previewJobId}`,
    });
    if (
      typeof retried !== "object" ||
      retried === null ||
      Array.isArray(retried) ||
      typeof retried.attemptId !== "string"
    ) {
      throw new Error("Character Preview retry did not return an Attempt identity");
    }
    expect(retried).toMatchObject({ attemptNo: 2, status: "queued" });
    await expect(
      prisma.characterPreviewJob.findUniqueOrThrow({ where: { id: previewJobId } }),
    ).resolves.toMatchObject({
      status: "queued",
      resultAssetId: null,
      errorCode: null,
      completedAt: null,
    });

    const secondAttempt = await prisma.generationAttempt.findUniqueOrThrow({
      where: { id: retried.attemptId },
    });
    const retryOutboxId = `generation_retry_${retried.commandId as string}`;
    const secondAttemptDedupeKey =
      `generation:${generationJob.id}:attempt:${secondAttempt.attemptNo}`;
    await expect(dispatchGenerationAttemptOutbox(prisma, {
      outboxIds: [retryOutboxId],
    })).resolves.toMatchObject({ delivered: 1, failed: 0 });
    await expect(jobQueue.getByDedupeKey(
      "ai.image.generate",
      secondAttemptDedupeKey,
    )).resolves.toMatchObject({
      payload: expect.objectContaining({
        generationJobId: generationJob.id,
        attemptId: secondAttempt.id,
        attemptNo: secondAttempt.attemptNo,
      }),
    });
    // INTENT: the injected Terminal below represents an external Gen owner
    // that already claimed the exact retry work. Removing that row models the
    // claim boundary and prevents Main recovery from dispatching it later.
    await expect(jobQueue.removeByDedupeKey(
      "ai.image.generate",
      secondAttemptDedupeKey,
    )).resolves.toBe(true);
    const blockedTerminal = await generationTerminalFixture(
      generationJob.id,
      secondAttempt.id,
      {
        outcome: "blocked",
        block: {
          policyCode: "preview_blocked",
          message: "Preview was blocked",
          layer: "provider",
        },
      },
    );
    await expect(ingestGenerationTerminalRecord(blockedTerminal)).resolves
      .toMatchObject({ acknowledged: true, status: "persisted" });
    await expect(dispatchPendingGenerationTerminalRecords({
      outboxIds: [`generation_terminal_record_${secondAttempt.id}`],
    })).resolves.toBe(1);
    await expect(runQueuedGenerationJobs(2, ["app.ai.finalize"])).resolves
      .toMatchObject({ processed: 1 });
    const blockedPreview = await prisma.characterPreviewJob.findUniqueOrThrow({
      where: { id: previewJobId },
    });
    expect(blockedPreview).toMatchObject({
      status: "failed",
      errorCode: "preview_blocked",
      resultAssetId: null,
    });

    // A repeated terminal delivery and a late success cannot overwrite the
    // already-projected blocked Preview outcome.
    const blockedOutbox = await prisma.mainOutboxEvent.findUniqueOrThrow({
      where: { id: `generation_terminal_record_${secondAttempt.id}` },
    });
    await jobQueue.enqueue({
      queue: "app.ai.finalize",
      payload: blockedOutbox.payload as Prisma.InputJsonValue,
      dedupeKey: `generation-finalize-replay:${generationJob.id}:blocked`,
    });
    const lateSuccessTerminal = await generationTerminalFixture(
      generationJob.id,
      secondAttempt.id,
      {
        outcome: "succeeded",
        assets: [{
          ordinal: 0,
          key:
            `gen/${generationJob.id}/attempts/${secondAttempt.id}/image-1.webp`,
          width: 832,
          height: 1024,
          contentType: "image/webp",
          providerKey: "late-provider-image",
        }],
      },
    );
    await expect(ingestGenerationTerminalRecord(lateSuccessTerminal)).resolves
      .toMatchObject({ acknowledged: false, status: "quarantined" });
    await runQueuedGenerationJobs(4, ["app.ai.finalize"]);
    await expect(
      prisma.characterPreviewJob.findUniqueOrThrow({ where: { id: previewJobId } }),
    ).resolves.toEqual(blockedPreview);
    await expect(jobQueue.getByDedupeKey(
      "ai.image.generate",
      secondAttemptDedupeKey,
    )).resolves.toBeNull();
    await expect(prisma.mainOutboxEvent.findUniqueOrThrow({
      where: { id: retryOutboxId },
    })).resolves.toMatchObject({ status: "delivered" });
  });

  it("fails and refunds image jobs when generated assets cannot be persisted", async () => {
    const userId = `${P}blob-fail-user`;
    await createUser({ id: userId });
    await grantCoins(userId, 100, "seed");

    const gen = await api("POST", "generation/jobs", {
      userId,
      ageGate: true,
      body: { mode: "image", characterId: CHAR, outputCount: 1 },
    });
    expectOk(gen, 202);
    const jobId = gen.data.job.id as string;
    cleanupJobDedupeKeys.push(
      `generation:${jobId}`,
      `generation-finalize:${jobId}:failed`,
      `generation-finalize:${jobId}:completed`,
    );
    cleanupModerationTargetIds.push(jobId);

    await requeueAsFinalAttempt("ai.image.generate", jobId);
    vi.spyOn(genProviders.blob, "putPrivateIfAbsent").mockResolvedValueOnce({
      ok: false,
      error: {
        code: "blob_write_failed",
        message: "object store unavailable",
        retryable: true,
      },
    });

    await runQueuedGenerationJobs(8);

    const failed = await api("GET", `generation/jobs/${jobId}`, { userId, ageGate: true });
    expectOk(failed);
    expect(failed.data.job.status).toBe("failed");
    expect(failed.data.job.errorCode).toBe("asset_persist_failed");
    expect(failed.data.assets).toHaveLength(0);
    expect(await dreamcoinBalance(userId)).toBe(100);
    expect(await prisma.mediaAsset.count({ where: { sourceJobId: jobId } })).toBe(0);

    const generateJob = await jobQueue.getByDedupeKey("ai.image.generate", `generation:${jobId}:attempt:1`);
    const finalizeJob = await jobQueue.getByDedupeKey(
      "app.ai.finalize",
      `generation-finalize:${jobId}:failed`,
    );
    expect(generateJob).toBeNull();
    expect(finalizeJob).toBeNull();
  });

  it("fails and refunds image jobs when the provider returns keys without asset bytes", async () => {
    const userId = `${P}image-no-body-user`;
    await createUser({ id: userId });
    await grantCoins(userId, 100, "seed");

    const gen = await api("POST", "generation/jobs", {
      userId,
      ageGate: true,
      body: { mode: "image", characterId: CHAR, outputCount: 1 },
    });
    expectOk(gen, 202);
    const jobId = gen.data.job.id as string;
    cleanupJobDedupeKeys.push(
      `generation:${jobId}`,
      `generation-finalize:${jobId}:failed`,
      `generation-finalize:${jobId}:completed`,
    );
    cleanupModerationTargetIds.push(jobId);

    await requeueAsFinalAttempt("ai.image.generate", jobId);
    vi.spyOn(genProviders.image, "generate").mockResolvedValueOnce({
      ok: true,
      data: {
        assets: [{
          key: "provider/image-without-body.png",
          width: 1024,
          height: 1024,
          contentType: "image/png",
        }],
      },
    });
    const blobPut = vi.spyOn(genProviders.blob, "putPrivateIfAbsent");

    await runQueuedGenerationJobs(8);

    const failed = await api("GET", `generation/jobs/${jobId}`, { userId, ageGate: true });
    expectOk(failed);
    expect(failed.data.job).toMatchObject({
      status: "failed",
      errorCode: "asset_body_missing",
    });
    expect(failed.data.assets).toHaveLength(0);
    expect(artifactWriteKeys(blobPut)).toEqual([]);
    expect(await dreamcoinBalance(userId)).toBe(100);
    expect(await prisma.mediaAsset.count({ where: { sourceJobId: jobId } })).toBe(0);
  });

  it("fails empty image provider results without charging the user", async () => {
    const userId = `${P}empty-result-user`;
    await createUser({ id: userId });
    await grantCoins(userId, 100, "seed");

    const gen = await api("POST", "generation/jobs", {
      userId,
      ageGate: true,
      body: { mode: "image", characterId: CHAR, outputCount: 1 },
    });
    expectOk(gen, 202);
    const jobId = gen.data.job.id as string;
    cleanupJobDedupeKeys.push(
      `generation:${jobId}`,
      `generation-finalize:${jobId}:failed`,
      `generation-finalize:${jobId}:completed`,
    );
    cleanupModerationTargetIds.push(jobId);

    vi.spyOn(genProviders.image, "generate").mockResolvedValueOnce({
      ok: true,
      data: { assets: [] },
    });

    await runQueuedGenerationJobs(8);

    const failed = await api("GET", `generation/jobs/${jobId}`, { userId, ageGate: true });
    expectOk(failed);
    expect(failed.data.job.status).toBe("failed");
    expect(failed.data.job.errorCode).toBe("empty_provider_result");
    expect(failed.data.assets).toHaveLength(0);
    expect(await dreamcoinBalance(userId)).toBe(100);
    expect(await prisma.mediaAsset.count({ where: { sourceJobId: jobId } })).toBe(0);
  });

  it("passes video context to the provider and fails when the video asset cannot be persisted", async () => {
    const userId = `${P}video-blob-fail`;
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
      const originalVideoGenerate = genProviders.video.generate.bind(genProviders.video);
      const videoSpy = vi
        .spyOn(genProviders.video, "generate")
        .mockImplementation((input) => originalVideoGenerate(input));
      // 视频产物走 putPrivateIfAbsent（同 key 重复投递不覆盖已发布字节），不是 putPrivate。
      vi.spyOn(genProviders.blob, "putPrivateIfAbsent").mockResolvedValueOnce({
        ok: false,
        error: {
          code: "blob_write_failed",
          message: "object store unavailable",
          retryable: true,
        },
      });

      const gen = await api("POST", "generation/jobs", {
        userId,
        ageGate: true,
        body: { mode: "video", characterId: CHAR, outputCount: 1 },
      });
      expectOk(gen, 202);
      const jobId = gen.data.job.id as string;
      cleanupJobDedupeKeys.push(
        `generation:${jobId}`,
        `generation-finalize:${jobId}:failed`,
        `generation-finalize:${jobId}:completed`,
      );
      cleanupModerationTargetIds.push(jobId);

      await requeueAsFinalAttempt("ai.video.generate", jobId);
      await runQueuedGenerationJobs(8);

      expect(videoSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: "Video generation for Test Character",
          seconds: 4,
          seed: expect.any(String),
          negativePrompt: null,
          model: "ltx23-gtanimation-i2v",
          controls: expect.objectContaining({
            profileId: "profile_video_beta_v1",
            width: 768,
            height: 1152,
            sourceImageAssetId: expect.any(String),
            workflowKey: "ltx23-gtanimation-i2v",
            workflowVersion: 1,
          }),
          referenceImages: [
            expect.objectContaining({
              assetId: expect.any(String),
              role: "source_image",
            }),
          ],
          requestId: expect.any(String),
        }),
      );

      const failed = await api("GET", `generation/jobs/${jobId}`, { userId, ageGate: true });
      expectOk(failed);
      expect(failed.data.job.status).toBe("failed");
      expect(failed.data.job.errorCode).toBe("asset_persist_failed");
      expect(failed.data.assets).toHaveLength(0);
      expect(await dreamcoinBalance(userId)).toBe(300);
      expect(await prisma.mediaAsset.count({ where: { sourceJobId: jobId } })).toBe(0);
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

  it("rejects non-four-second requests and unpublished Character sources", async () => {
    const userId = `${P}video-authority-user`;
    const privateCharacterId = `${P}private-video-char`;
    const privateAssetId = `${P}private-video-source`;
    const alternateProfileKey = `${P}alternate-video-profile`;
    await createUser({ id: userId });
    await grantCoins(userId, 300, "seed");
    await prisma.entitlement.createMany({
      data: [
        { userId, key: "video_generation", value: true, source: "test" },
        { userId, key: "premium_controls", value: true, source: "test" },
      ],
    });
    await createCharacter({
      id: privateCharacterId,
      creatorId: userId,
      source: "user",
      visibility: "private",
      status: "approved",
    });
    await prisma.mediaAsset.create({
      data: {
        id: privateAssetId,
        ownerId: userId,
        characterId: privateCharacterId,
        type: "image",
        storageKey: `${P}private-video-source.webp`,
        url: "/images/ourdream/card-sarah-mercer.webp",
        visibility: "private",
        safetyStatus: "passed",
        metadata: {
          synthetic: false,
          platformAsset: { status: "active" },
        },
      },
    });
    await prisma.character.update({
      where: { id: privateCharacterId },
      data: { imageAssetId: privateAssetId },
    });
    const previousFlag = await prisma.featureFlag.findUniqueOrThrow({
      where: { key: "video_gen" },
      select: { enabled: true, rolloutPercent: true },
    });
    const previousVideoProfile =
      await prisma.generationModelProfile.findUniqueOrThrow({
        where: { id: "seed-profile-video-beta-v1" },
        select: { rolloutPercent: true },
      });
    await prisma.featureFlag.update({
      where: { key: "video_gen" },
      data: { enabled: true, rolloutPercent: 100 },
    });
    await prisma.generationModelProfile.update({
      where: { id: "seed-profile-video-beta-v1" },
      data: { rolloutPercent: 100 },
    });
    await prisma.generationModelProfile.create({
      data: {
        id: alternateProfileKey,
        profileKey: alternateProfileKey,
        label: "Unauthorized alternate video route",
        mode: "video",
        runner: "comfyui",
        pipelineModel: "ltx23-gtanimation-int4-convrot",
        workflowKey: "ltx23-gtanimation-i2v",
        runnerConfig: {
          capabilities: { initImage: true, imageToVideo: true },
        },
        defaultWidth: 768,
        defaultHeight: 1152,
        allowedOrientations: ["2:3"],
        costMultiplier: 0.1,
        requiredEntitlement: "video_generation",
        maxCount: 1,
        enabled: true,
        rolloutPercent: 100,
        version: 1,
        status: "active",
      },
    });

    try {
      const config = await api("GET", "generation/config", {
        userId,
        ageGate: true,
      });
      expectOk(config);
      expect(config.data.video.models).toHaveLength(1);
      expect(config.data.video.models[0].id).toBe(
        "profile_video_beta_v1",
      );
      const alternateRoute = await api("POST", "generation/jobs", {
        userId,
        ageGate: true,
        body: {
          mode: "video",
          characterId: CHAR,
          model: alternateProfileKey,
          controls: { seconds: 4 },
          outputCount: 1,
        },
      });
      expectError(alternateRoute, 409, "conflict");

      const invalidDuration = await api("POST", "generation/jobs", {
        userId,
        ageGate: true,
        body: {
          mode: "video",
          characterId: CHAR,
          controls: { seconds: 6 },
          outputCount: 1,
        },
      });
      expectError(invalidDuration, 400, "bad_request");

      const unpublished = await api("POST", "generation/jobs", {
        userId,
        ageGate: true,
        body: {
          mode: "video",
          characterId: privateCharacterId,
          controls: { seconds: 4 },
          outputCount: 1,
        },
      });
      expectError(unpublished, 404, "not_found");
      await expect(
        prisma.generationJob.count({
          where: { userId, mode: "video" },
        }),
      ).resolves.toBe(0);
      await expect(dreamcoinBalance(userId)).resolves.toBe(300);
    } finally {
      await prisma.featureFlag.update({
        where: { key: "video_gen" },
        data: previousFlag,
      });
      await prisma.generationModelProfile.update({
        where: { id: "seed-profile-video-beta-v1" },
        data: previousVideoProfile,
      });
    }
  });

  it("fails closed when a video retry no longer matches its pinned workflow", async () => {
    const userId = `${P}video-retry-authority-user`;
    const retryKey = `${P}video-retry-authority-key`;
    await createUser({ id: userId });
    await grantCoins(userId, 300, "seed");
    await prisma.entitlement.create({
      data: { userId, key: "video_generation", value: true, source: "test" },
    });
    const previousFlag = await prisma.featureFlag.findUniqueOrThrow({
      where: { key: "video_gen" },
      select: { enabled: true, rolloutPercent: true },
    });
    const previousVideoProfile =
      await prisma.generationModelProfile.findUniqueOrThrow({
        where: { id: "seed-profile-video-beta-v1" },
        select: { rolloutPercent: true },
      });
    await prisma.featureFlag.update({
      where: { key: "video_gen" },
      data: { enabled: true, rolloutPercent: 100 },
    });
    await prisma.generationModelProfile.update({
      where: { id: "seed-profile-video-beta-v1" },
      data: { rolloutPercent: 100 },
    });

    try {
      const created = await api("POST", "generation/jobs", {
        userId,
        ageGate: true,
        body: {
          mode: "video",
          characterId: CHAR,
          controls: { seconds: 4 },
          outputCount: 1,
        },
      });
      expectOk(created, 202);
      const failedJobId = created.data.job.id as string;
      cleanupJobDedupeKeys.push(`generation:${failedJobId}`);
      await jobQueue.removeByDedupePrefix(
        `generation:${failedJobId}`,
        ["ai.video.generate"],
      );
      const originalControls = created.data.job.controls as Record<
        string,
        unknown
      >;
      await prisma.generationJob.update({
        where: { id: failedJobId },
        data: {
          status: "failed",
          errorCode: "video_retry_fixture",
          controls: {
            ...originalControls,
            workflowVersion: 2,
          } as Prisma.InputJsonValue,
        },
      });

      const staleQuote = await api(
        "POST",
        `generation/jobs/${failedJobId}/retry/quote`,
        {
          userId,
          ageGate: true,
          body: {},
        },
      );
      expectError(staleQuote, 409, "conflict");

      await prisma.generationJob.update({
        where: { id: failedJobId },
        data: { controls: originalControls as Prisma.InputJsonValue },
      });
      const quoted = await api(
        "POST",
        `generation/jobs/${failedJobId}/retry/quote`,
        {
          userId,
          ageGate: true,
          body: {},
        },
      );
      expectOk(quoted);
      const retried = await api(
        "POST",
        `generation/jobs/${failedJobId}/retry`,
        {
          userId,
          ageGate: true,
          headers: { "idempotency-key": retryKey },
          body: {
            quoteAuthority: {
              profileId: quoted.data.quote.profileId,
              profileVersion: quoted.data.quote.profileVersion,
              routeFingerprint: quoted.data.quote.routeFingerprint,
              pricingFingerprint: quoted.data.quote.pricing.fingerprint,
              outputCount: quoted.data.quote.outputCount,
              costDreamcoins: quoted.data.quote.costDreamcoins,
            },
          },
        },
      );
      expectOk(retried, 202);
      expect(retried.data.job.controls).toMatchObject({
        workflowKey: "ltx23-gtanimation-i2v",
        workflowVersion: 1,
      });
      cleanupJobDedupeKeys.push(`generation:${retried.data.job.id as string}`);
    } finally {
      await prisma.featureFlag.update({
        where: { key: "video_gen" },
        data: previousFlag,
      });
      await prisma.generationModelProfile.update({
        where: { id: "seed-profile-video-beta-v1" },
        data: previousVideoProfile,
      });
    }
  });

  it("serves generated video bytes instead of an unrelated image placeholder", async () => {
    const userId = `${P}video-success`;
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
      const jobId = gen.data.job.id as string;
      cleanupJobDedupeKeys.push(
        `generation:${jobId}`,
        `generation-finalize:${jobId}:completed`,
      );
      cleanupModerationTargetIds.push(jobId);

      await runQueuedGenerationJobs(8);

      const asset = await prisma.mediaAsset.findFirstOrThrow({
        where: { sourceJobId: jobId },
      });
      expect(asset.type).toBe("video");
      expect(asset.url).toMatch(/^\/user-content\/.+\/content\.mp4$/);
      expect(asset.thumbnailUrl).toBeNull();
      expect(asset.url).not.toContain("promo-card");
      expect(asset.metadata).toMatchObject({
        provider: "comfyui",
        synthetic: false,
      });
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

function whitePng(width: number, height: number) {
  const rows = Array.from({ length: height }, () => {
    const row = Buffer.alloc(1 + width * 3, 255);
    row[0] = 0;
    return row;
  });
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(Buffer.concat(rows))),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function contactSheetPng() {
  const width = 80;
  const height = 100;
  const rows = Array.from({ length: height }, (_, y) => {
    const row = Buffer.alloc(1 + width * 3);
    row[0] = 0;
    for (let x = 0; x < width; x += 1) {
      const offset = 1 + x * 3;
      const thumbnail = Math.floor(y / 25);
      const color: [number, number, number] = x < 60
        ? [
            (x * 3 + y) % 180,
            (x + y * 2) % 180,
            (x * 2 + y * 3) % 180,
          ]
        : [
            220 - thumbnail * 20,
            190 - thumbnail * 10,
            160 + ((x + y) % 40),
          ];
      row[offset] = color[0];
      row[offset + 1] = color[1];
      row[offset + 2] = color[2];
    }
    return row;
  });
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(Buffer.concat(rows))),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function pngChunk(type: string, data: Buffer) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const chunk = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(chunk), 0);
  return Buffer.concat([length, chunk, crc]);
}

const pngCrcTable = new Uint32Array(256).map((_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) {
    crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return crc >>> 0;
});

function crc32(data: Buffer) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc = pngCrcTable[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
