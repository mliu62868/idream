import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";
import { AppError } from "@/server/lib/errors";
import {
  createMedia,
  createUser,
  dreamcoinBalance,
  grantCoins,
  purgeTestData,
} from "@/server/test/helpers";
import { generationJobSchema } from "./generation-request-schema";
import { quoteAuthorityFor, quoteGeneration } from "./generation-quote";
import { createGenerationJobForUser } from "./generation-job-create";
import {
  quoteGenerationRetry,
  resolveGenerationRetryTarget,
  retryGenerationJobForUser,
} from "./generation-job-retry";
import { duplicateCharacterForUser } from "./character-duplicate";
import { recordMediaIdentityFeedback } from "./media-feedback";

// SPEC: 用户侧生成写入的领域接口在没有 HTTP 的情况下也能被驱动 —— 直接传已解析的
// 业务参数，直接拿回数据。
//
// INTENT: 这些动作以前只存在于 dispatchV1 的 handler 里，「测它」等于「发一个请求」。
// 本文件不经 api() 助手、不构造 Request，只调模块导出的函数：接缝真的存在，
// 这个文件才跑得起来。

const P = "zt-genwrite-";
const PINNED_RETRY_JOB_AUTHORITY = {
  model: "redcraft-krea2-redmix3-txt2img",
  profileId: "profile_image_default_v1",
  profileVersion: 2,
  orientation: "1:1",
  outputCount: 1,
  provider: "comfyui",
} as const;

function freeplayBody(prompt: string) {
  return generationJobSchema.parse({
    mode: "image",
    freeplay: true,
    prompt,
    controls: {},
    presetIds: [],
    outputCount: 1,
  });
}

// Freeplay + a custom prompt is a Premium control; the seam under test is the
// write itself, so grant the entitlement rather than route around the prompt.
async function grantPremiumControls(userId: string) {
  await prisma.entitlement.create({
    data: { userId, key: "premium_controls", value: true, source: "test" },
  });
}

async function quotedFreeplayBody(userId: string, prompt: string) {
  const body = freeplayBody(prompt);
  const { quote } = await quoteGeneration({
    userId,
    body,
    profileSelectionAuthority: "public_generator",
  });
  const quoteAuthority = quoteAuthorityFor(quote, body.outputCount);
  expect(quoteAuthority).not.toBeNull();
  return { ...body, quoteAuthority: quoteAuthority! };
}

// The retry handshake's client half, driven through the same two exports a real
// caller uses: quote the retry, then project the six fields submit re-verifies.
async function exactRetryQuote(userId: string, generationJobId: string) {
  const { quote } = await quoteGenerationRetry({ userId, generationJobId });
  const authority = quoteAuthorityFor(quote, quote.outputCount);
  expect(authority).not.toBeNull();
  return authority!;
}

async function expectAppError(promise: Promise<unknown>, status: number) {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(AppError);
  expect((error as AppError).status).toBe(status);
  return error as AppError;
}

async function withRejectedAdmissionOutbox(run: () => Promise<void>) {
  // Fail the last durable reservation write, after Job/events/debit/Attempt.
  // Scope the trigger to this suite's owned users and always remove it.
  await prisma.$executeRawUnsafe(`
    CREATE FUNCTION test_reject_generation_admission_outbox()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW."eventType" = 'generation.retry.dispatch.v2' AND EXISTS (
        SELECT 1 FROM generation_jobs WHERE id = NEW."aggregateId" AND "userId" LIKE 'zt-genwrite-%'
      ) THEN
        RAISE EXCEPTION 'injected generation admission outbox failure';
      END IF;
      RETURN NEW;
    END
    $$
  `);
  try {
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER test_reject_generation_admission_outbox
      BEFORE INSERT ON main_outbox_events
      FOR EACH ROW EXECUTE FUNCTION test_reject_generation_admission_outbox()
    `);
    await run();
  } finally {
    await prisma.$executeRawUnsafe("DROP TRIGGER IF EXISTS test_reject_generation_admission_outbox ON main_outbox_events");
    await prisma.$executeRawUnsafe("DROP FUNCTION IF EXISTS test_reject_generation_admission_outbox()");
  }
}

beforeAll(async () => {
  await purgeTestData(P);
});

afterAll(async () => {
  await purgeTestData(P);
  await prisma.$disconnect();
});

describe("createGenerationJobForUser", () => {
  it("rolls back the accepted Job and debit if its dispatch outbox cannot commit", async () => {
    const userId = `${P}create-atomic`;
    await createUser({ id: userId });
    await grantPremiumControls(userId);
    await grantCoins(userId, 200, "seed");
    const body = await quotedFreeplayBody(userId, "a reading nook with a durable delivery");
    const openingBalance = await dreamcoinBalance(userId);
    const options = { idempotencyKey: `${P}create-atomic-key`, profileSelectionAuthority: "public_generator" as const };

    await withRejectedAdmissionOutbox(async () => {
      await expect(createGenerationJobForUser(userId, body, options)).rejects.toThrow("injected generation admission outbox failure");
    });

    expect(await prisma.generationJob.count({ where: { userId } })).toBe(0);
    expect(await prisma.dreamcoinLedger.count({ where: { userId, reason: "generation_spend" } })).toBe(0);
    expect(await dreamcoinBalance(userId)).toBe(openingBalance);
    const accepted = await createGenerationJobForUser(userId, body, options);
    expect(await prisma.generationAttempt.count({ where: { requestId: accepted.id } })).toBe(1);
    expect(await prisma.dreamcoinLedger.count({ where: { sourceId: accepted.id, reason: "generation_spend" } })).toBe(1);
  });

  it("queues a job, reserves its first attempt, and charges the quoted cost", async () => {
    const userId = `${P}create`;
    await createUser({ id: userId });
    await grantPremiumControls(userId);
    await grantCoins(userId, 200, "seed");
    const openingBalance = await dreamcoinBalance(userId);
    const body = await quotedFreeplayBody(userId, "a quiet reading nook at dusk");

    const job = await createGenerationJobForUser(userId, body, {
      idempotencyKey: `${P}create-key`,
      profileSelectionAuthority: "public_generator",
    });

    expect(job.userId).toBe(userId);
    expect(job.status).toBe("queued");
    expect(job.mode).toBe("image");
    expect(job.costDreamcoins).toBe(body.quoteAuthority.costDreamcoins);
    expect(job.prompt).toContain("a quiet reading nook at dusk");
    expect(await dreamcoinBalance(userId)).toBe(
      openingBalance - body.quoteAuthority.costDreamcoins,
    );
    const events = await prisma.generationJobEvent.findMany({
      where: { jobId: job.id },
      orderBy: { createdAt: "asc" },
      select: { type: true },
    });
    expect(events.map((event) => event.type)).toEqual([
      "created",
      "reserved",
      "queued",
    ]);
    const attempts = await prisma.generationAttempt.count({
      where: { requestId: job.id },
    });
    expect(attempts).toBe(1);
  });

  it("resolves a replayed Idempotency-Key to the same job without charging twice", async () => {
    const userId = `${P}replay`;
    await createUser({ id: userId });
    await grantPremiumControls(userId);
    await grantCoins(userId, 200, "seed");
    const idempotencyKey = `${P}replay-key`;
    const body = await quotedFreeplayBody(userId, "the same request twice");

    const first = await createGenerationJobForUser(userId, body, {
      idempotencyKey,
      profileSelectionAuthority: "public_generator",
    });
    const balanceAfterFirst = await dreamcoinBalance(userId);
    const second = await createGenerationJobForUser(userId, body, {
      idempotencyKey,
      profileSelectionAuthority: "public_generator",
    });

    expect(second.id).toBe(first.id);
    expect(await dreamcoinBalance(userId)).toBe(balanceAfterFirst);
    expect(
      await prisma.generationJob.count({ where: { userId } }),
    ).toBe(1);
  });

  it("refuses a public write that carries no exact quote", async () => {
    const userId = `${P}unquoted`;
    await createUser({ id: userId });
    await grantCoins(userId, 200, "seed");

    const error = await expectAppError(
      createGenerationJobForUser(userId, freeplayBody("no quote attached"), {
        idempotencyKey: `${P}unquoted-key`,
        profileSelectionAuthority: "public_generator",
      }),
      409,
    );
    expect(error.message).toContain("exact generation quote");
    expect(await prisma.generationJob.count({ where: { userId } })).toBe(0);
  });
});

describe("retryGenerationJobForUser", () => {
  async function seedFailedJob(userId: string, jobId: string) {
    return prisma.generationJob.create({
      data: {
        id: jobId,
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
  }

  it("keeps the failed source and balance intact when a retry's outbox reservation fails", async () => {
    const userId = `${P}retry-atomic`;
    await createUser({ id: userId });
    await grantCoins(userId, 200, "seed");
    const source = await seedFailedJob(userId, `${P}retry-atomic-job`);
    const target = await resolveGenerationRetryTarget({ userId, generationJobId: source.id, idempotencyKey: `${P}retry-atomic-key` });
    if (target.kind !== "retryable") throw new Error("expected a retryable source");
    const input = {
      userId, job: target.job, idempotencyKey: `${P}retry-atomic-key`,
      quoteAuthority: await exactRetryQuote(userId, source.id),
    };
    const openingBalance = await dreamcoinBalance(userId);

    await withRejectedAdmissionOutbox(async () => {
      await expect(retryGenerationJobForUser(input)).rejects.toThrow("injected generation admission outbox failure");
    });

    expect(await prisma.generationJob.findUniqueOrThrow({ where: { id: source.id } })).toEqual(source);
    expect(await prisma.generationJob.count({ where: { derivedFromJobId: source.id } })).toBe(0);
    expect(await dreamcoinBalance(userId)).toBe(openingBalance);
    const accepted = await retryGenerationJobForUser(input);
    expect(accepted.derivedFromJobId).toBe(source.id);
    expect(await prisma.generationAttempt.count({ where: { requestId: accepted.id } })).toBe(1);
    expect(await prisma.dreamcoinLedger.count({ where: { sourceId: accepted.id, reason: "generation_spend" } })).toBe(1);
  });

  it("derives a queued retry from the failed job and leaves the original failed", async () => {
    const userId = `${P}retry`;
    await createUser({ id: userId });
    await grantCoins(userId, 200, "seed");
    const failed = await seedFailedJob(userId, `${P}retry-job`);

    const target = await resolveGenerationRetryTarget({
      userId,
      generationJobId: failed.id,
      idempotencyKey: `${P}retry-key`,
    });
    expect(target.kind).toBe("retryable");
    if (target.kind !== "retryable") throw new Error("unreachable");

    const retry = await retryGenerationJobForUser({
      userId,
      job: target.job,
      idempotencyKey: `${P}retry-key`,
      quoteAuthority: await exactRetryQuote(userId, failed.id),
    });

    expect(retry.id).not.toBe(failed.id);
    expect(retry.derivedFromJobId).toBe(failed.id);
    expect(retry.status).toBe("queued");
    // The read model shape the HTTP layer renders comes back already loaded.
    expect(Array.isArray(retry.events)).toBe(true);
    expect(retry.events.map((event) => event.type)).toEqual([
      "created",
      "reserved",
      "queued",
    ]);
    const original = await prisma.generationJob.findUniqueOrThrow({
      where: { id: failed.id },
    });
    expect(original.status).toBe("failed");
  });

  it("replays a reused Idempotency-Key back to the derived retry before any body is read", async () => {
    const userId = `${P}retry-replay`;
    await createUser({ id: userId });
    await grantCoins(userId, 200, "seed");
    const failed = await seedFailedJob(userId, `${P}retry-replay-job`);
    const idempotencyKey = `${P}retry-replay-key`;

    const first = await resolveGenerationRetryTarget({
      userId,
      generationJobId: failed.id,
      idempotencyKey,
    });
    if (first.kind !== "retryable") throw new Error("expected a retryable job");
    const retry = await retryGenerationJobForUser({
      userId,
      job: first.job,
      idempotencyKey,
      quoteAuthority: await exactRetryQuote(userId, failed.id),
    });

    const replay = await resolveGenerationRetryTarget({
      userId,
      generationJobId: failed.id,
      idempotencyKey,
    });
    expect(replay.kind).toBe("replay");
    expect(replay.job.id).toBe(retry.id);
  });

  it("refuses a retry that carries no exact retry quote", async () => {
    const userId = `${P}retry-unquoted`;
    await createUser({ id: userId });
    await grantCoins(userId, 200, "seed");
    const failed = await seedFailedJob(userId, `${P}retry-unquoted-job`);
    const target = await resolveGenerationRetryTarget({
      userId,
      generationJobId: failed.id,
      idempotencyKey: `${P}retry-unquoted-key`,
    });
    if (target.kind !== "retryable") throw new Error("expected a retryable job");

    const error = await expectAppError(
      retryGenerationJobForUser({
        userId,
        job: target.job,
        idempotencyKey: `${P}retry-unquoted-key`,
      }),
      409,
    );
    expect(error.message).toContain("exact generation retry quote");
    expect(
      await prisma.generationJob.count({ where: { derivedFromJobId: failed.id } }),
    ).toBe(0);
  });

  it("rejects a job that is not failed", async () => {
    const userId = `${P}retry-completed`;
    await createUser({ id: userId });
    const completed = await prisma.generationJob.create({
      data: {
        id: `${P}retry-completed-job`,
        userId,
        mode: "image",
        ...PINNED_RETRY_JOB_AUTHORITY,
        status: "completed",
        costDreamcoins: 10,
        controls: {},
        presetIds: [],
      },
    });

    await expectAppError(
      resolveGenerationRetryTarget({
        userId,
        generationJobId: completed.id,
        idempotencyKey: `${P}retry-completed-key`,
      }),
      400,
    );
  });
});

describe("character and media write actions off the HTTP path", () => {
  it("duplicates a Character into a private copy owned by the caller", async () => {
    const ownerId = `${P}dup-owner`;
    const copierId = `${P}dup-copier`;
    const characterId = `${P}dup-char`;
    await createUser({ id: ownerId });
    await createUser({ id: copierId });
    await prisma.character.create({
      data: {
        id: characterId,
        creatorId: ownerId,
        source: "user",
        name: "Duplication Source",
        age: 24,
        description: "A source character for the duplication seam test.",
        visibility: "private",
        status: "approved",
        style: "realistic",
        gender: "female",
        appearance: {},
        advancedDetails: {
          personality: "Observant and steady.",
          tone: "Warm and direct.",
          backstory: "Seeded for a duplication test.",
          firstMessage: "I'm here. What should we talk about?",
          exampleDialogue: ["Tell me the part that matters most."],
        },
      },
    });
    await prisma.characterStats.create({ data: { characterId } });

    // A stranger cannot reach a private Character at all.
    await expectAppError(
      duplicateCharacterForUser({ userId: copierId, characterId }),
      404,
    );

    const duplicate = await duplicateCharacterForUser({
      userId: ownerId,
      characterId,
    });
    expect(duplicate.id).not.toBe(characterId);
    expect(duplicate.creatorId).toBe(ownerId);
    expect(duplicate.name).toBe("Duplication Source Copy");
    expect(duplicate.visibility).toBe("private");
  });

  it("records identity feedback as an event, a feedback row, and asset metadata", async () => {
    const userId = `${P}feedback`;
    const jobId = `${P}feedback-job`;
    const mediaId = `${P}feedback-media`;
    await createUser({ id: userId });
    await prisma.generationJob.create({
      data: {
        id: jobId,
        userId,
        mode: "image",
        ...PINNED_RETRY_JOB_AUTHORITY,
        status: "completed",
        costDreamcoins: 5,
        controls: {},
        presetIds: [],
      },
    });
    await createMedia({ id: mediaId, ownerId: userId, sourceJobId: jobId });

    const recorded = await recordMediaIdentityFeedback({
      userId,
      mediaAssetId: mediaId,
      feedbackType: "identity_match",
      sourceSurface: "gallery",
    });

    expect(recorded.feedback.value).toBe("match");
    expect(recorded.feedback.revision).toBe(1);
    expect(recorded.eventId).toBeTruthy();
    // No Character identity is pinned on this job, so there is no candidate to seed.
    expect(recorded.referenceCandidate).toBeNull();
    const stored = await prisma.generationFeedback.findFirst({
      where: { actorId: userId, mediaAssetId: mediaId, active: true },
    });
    expect(stored?.value).toBe("match");

    // Re-submitting the same verdict is idempotent: same revision, no new event.
    const replay = await recordMediaIdentityFeedback({
      userId,
      mediaAssetId: mediaId,
      feedbackType: "identity_match",
      sourceSurface: "gallery",
    });
    expect(replay.feedback.revision).toBe(1);
    expect(replay.eventId).toBe(recorded.eventId);
    expect(
      await prisma.generationJobEvent.count({
        where: { jobId, type: "user_feedback" },
      }),
    ).toBe(1);
  });
});
