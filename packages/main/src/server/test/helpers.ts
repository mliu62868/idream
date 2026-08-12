/* eslint-disable @typescript-eslint/no-explicit-any */
import { expect } from "vitest";
import type { Prisma } from "@prisma/client";
import { idempotencyKeys, MAIN_QUEUES } from "@idream/shared/contracts";
import { prisma } from "@/server/lib/db";
import { AGE_GATE_COOKIE, type ActorRole } from "@/server/lib/auth";
import { dispatchV1 } from "@/server/modules/ourdream/service";
import { quoteAuthorityFor } from "@/server/modules/ourdream/generation-quote";
import { jobQueue } from "@/server/jobs/queue";
import { drainLocalAiPipeline } from "@/server/ai/local-pipeline";
import {
  dispatchPendingGenerationTerminalRecords,
  ingestGenerationTerminalRecord,
} from "@/server/ai/generation-terminal-record-ingest";
import { recordGenerationTransportExecution } from "@/server/ai/generation-transport-execution";
import { redeemCodeHash } from "@/server/lib/redeem-codes";

// SPEC: Shared integration-test client + fixtures for the /api/v1 surface.
// INTENT: One ergonomic `api()` that drives dispatchV1 exactly like the route
// handler does, plus deterministic fixtures and a prefix-scoped purge so each
// test file is self-isolating on the shared, freshly-seeded test DB.
// INVARIANTS: dev auth headers (x-idream-*) only work because APP_ENV=test.

export const AGE_GATE_COOKIE_HEADER = `${AGE_GATE_COOKIE}=true`;

export interface ApiOptions {
  body?: unknown;
  /**
   * Public generation writes require a durable idempotency key. Integration
   * clients add one by default; set false only to exercise the missing-key
   * fail-closed contract.
   */
  autoGenerationIdempotencyKey?: boolean;
  /**
   * Integration clients follow the same quote -> submit contract as the UI:
   * POST the matching `.../quote`, then project the reply into the six-field
   * token with `quoteAuthorityFor` (see modules/ourdream/generation-quote.ts
   * for the protocol itself). Set false only when a test intentionally
   * exercises a missing or hand-tampered quote.
   */
  autoGenerationQuote?: boolean;
  headers?: Record<string, string>;
  query?: Record<string, string | number | boolean | undefined>;
  /** Sets x-idream-user-id (dev auth) — authenticates as this user. */
  userId?: string;
  /** Sets x-idream-role (dev auth) — user | moderator | support | ops | analyst | admin. */
  role?: string;
  /** Sets x-idream-anonymous-id. */
  anonymousId?: string;
  /** Adds the age-gate acceptance cookie. */
  ageGate?: boolean;
  /** Raw Cookie header value (appended). */
  cookie?: string;
}

export interface ApiResult {
  status: number;
  ok: boolean;
  data: any;
  error: { code?: string; message?: string; details?: any } | undefined;
  json: any;
  headers: Headers;
  setCookies: string[];
}

function buildUrl(path: string, query?: ApiOptions["query"]) {
  const url = new URL(`http://localhost/api/v1/${path}`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
  }
  return url;
}

/** Drive the API exactly as the Next route handler does: dispatchV1(request, segments). */
export async function api(
  method: string,
  path: string,
  options: ApiOptions = {},
): Promise<ApiResult> {
  const testAnonymousId = await materializeAgeGateAuthority(options);
  let requestBody = options.body;
  const requestBodyObject = isJsonObject(requestBody) ? requestBody : {};
  if (
    method === "POST" &&
    options.autoGenerationQuote !== false &&
    // Retry takes no body of its own, so an absent body still gets quoted.
    (isJsonObject(requestBody) || /^generation\/jobs\/[^/]+\/retry$/.test(path)) &&
    !isJsonObject(requestBodyObject.quoteAuthority)
  ) {
    const step = generationQuoteStep(path, requestBodyObject);
    if (step) {
      const quote = await api("POST", step.path, {
        ...options,
        autoGenerationQuote: false,
        body: step.body,
      });
      if (!quote.ok) return quote;
      const authority = quoteAuthorityFor(
        quote.data.quote,
        typeof quote.data.quote.outputCount === "number"
          ? quote.data.quote.outputCount
          : step.outputCount,
      );
      if (authority) requestBody = { ...requestBodyObject, quoteAuthority: authority };
    }
  }

  const url = buildUrl(path, options.query);
  const headers: Record<string, string> = { ...options.headers };
  const hasIdempotencyKey = Object.keys(headers).some(
    (name) => name.toLowerCase() === "idempotency-key",
  );
  if (requestBody !== undefined) headers["content-type"] = "application/json";
  if (options.userId) headers["x-idream-user-id"] = options.userId;
  if (options.role) headers["x-idream-role"] = options.role;
  if (testAnonymousId) headers["x-idream-anonymous-id"] = testAnonymousId;
  if (
    path.startsWith("admin/") &&
    ["POST", "PATCH", "PUT", "DELETE"].includes(method) &&
    !hasIdempotencyKey
  ) {
    headers["idempotency-key"] = crypto.randomUUID();
  }
  if (
    method === "POST" &&
    options.autoGenerationIdempotencyKey !== false &&
    (
      path === "generation/jobs" ||
      /^media\/[^/]+\/variation$/.test(path) ||
      /^character-drafts\/[^/]+\/preview$/.test(path)
    ) &&
    !hasIdempotencyKey
  ) {
    headers["idempotency-key"] = crypto.randomUUID();
  }

  const cookies: string[] = [];
  if (options.cookie) cookies.push(options.cookie);
  if (options.ageGate) cookies.push(AGE_GATE_COOKIE_HEADER);
  if (cookies.length) headers["cookie"] = cookies.join("; ");

  const request = new Request(url, {
    method,
    headers,
    body: requestBody !== undefined ? JSON.stringify(requestBody) : undefined,
  });

  const segments = path.split("/").filter(Boolean);
  const response = await dispatchV1(request, segments);
  const text = await response.text();
  const json = text ? (JSON.parse(text) as any) : null;

  return {
    status: response.status,
    ok: Boolean(json?.ok),
    data: json?.data,
    error: json?.error,
    json,
    headers: response.headers,
    setCookies: response.headers.getSetCookie(),
  };
}

async function materializeAgeGateAuthority(options: ApiOptions) {
  const carriesLegacyAcceptance =
    options.ageGate === true ||
    options.cookie
      ?.split(";")
      .some((cookie) => cookie.trim() === AGE_GATE_COOKIE_HEADER);
  if (!carriesLegacyAcceptance) return options.anonymousId;

  const anonymousId = options.userId
    ? options.anonymousId
    : (options.anonymousId ?? "test-age-gate-anonymous");
  const existing = await prisma.ageGateAcceptance.findFirst({
    where: {
      ...(options.userId ? { userId: options.userId } : { anonymousId }),
      policyVersion: "2026-06-13",
    },
    select: { id: true },
  });
  if (!existing) {
    await prisma.ageGateAcceptance.create({
      data: {
        userId: options.userId,
        anonymousId,
        policyVersion: "2026-06-13",
        sourcePath: "test-helper",
      },
    });
  }
  return anonymousId;
}

function isJsonObject(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// SPEC: 三个生成写入端点各自对应的报价端点与报价请求体。
// INTENT: 只保留"哪个端点配哪个报价"这一条测试脚手架自己的知识；六字段令牌
// 怎么从报价里投影出来是协议本身的事，交给 generation-quote 的
// `quoteAuthorityFor`。
function generationQuoteStep(
  path: string,
  body: Record<string, any>,
): { path: string; body: unknown; outputCount: number } | null {
  const outputCount =
    typeof body.outputCount === "number" ? body.outputCount : 1;
  if (path === "generation/jobs") {
    return { path: "generation/quote", body, outputCount };
  }
  if (/^media\/[^/]+\/variation$/.test(path)) {
    return {
      path: `${path}/quote`,
      body: {
        consistencyMode:
          typeof body.consistencyMode === "string" ? body.consistencyMode : "balanced",
      },
      outputCount,
    };
  }
  if (/^generation\/jobs\/[^/]+\/retry$/.test(path)) {
    return { path: `${path}/quote`, body: {}, outputCount };
  }
  return null;
}

/** Reduce Set-Cookie headers to a single Cookie request header value. */
export function cookieHeader(setCookies: string[]) {
  return setCookies
    .map((cookie) => cookie.split(";")[0])
    .filter(Boolean)
    .join("; ");
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

export interface CreateUserInput {
  id: string;
  email?: string;
  role?: ActorRole;
  displayName?: string;
  status?: "active" | "suspended" | "deleted";
  dataClass?: "customer" | "internal" | "fixture" | "audit";
}

export async function createUser(input: CreateUserInput) {
  const dataClass = input.dataClass ?? "fixture";
  const defaultEmailDomain =
    dataClass === "customer"
      ? "customer.invalid"
      : dataClass === "fixture"
        ? "test.local"
        : "idream.internal";
  return prisma.user.create({
    data: {
      id: input.id,
      email: input.email ?? `${input.id}@${defaultEmailDomain}`,
      emailVerified: true,
      displayName: input.displayName ?? "Test User",
      role: input.role ?? "user",
      status: input.status ?? "active",
      dataClass,
    },
  });
}

export interface CreateCharacterInput {
  id: string;
  creatorId?: string;
  source?: "official" | "user";
  name?: string;
  age?: number;
  description?: string;
  visibility?: "private" | "unlisted" | "public";
  status?: string;
  style?: string;
  gender?: string;
  relationship?: string | null;
  systemPrompt?: string;
  appearance?: Prisma.InputJsonValue;
  advancedDetails?: Prisma.InputJsonValue;
  imageAssetId?: string;
  likes?: number;
  chats?: number;
  views?: number;
}

export async function createCharacter(input: CreateCharacterInput) {
  const character = await prisma.character.create({
    data: {
      id: input.id,
      creatorId: input.creatorId,
      source: input.source ?? "official",
      name: input.name ?? "Test Character",
      age: input.age ?? 24,
      description: input.description ?? "A seeded character for integration tests.",
      visibility: input.visibility ?? "public",
      status: input.status ?? "approved",
      style: input.style ?? "realistic",
      gender: input.gender ?? "female",
      relationship: input.relationship ?? "trusted companion",
      systemPrompt: input.systemPrompt ?? null,
      imageAssetId: input.imageAssetId ?? null,
      appearance: input.appearance ?? {},
      advancedDetails: input.advancedDetails ?? {
        personality: "Observant, emotionally specific, and consistent.",
        tone: "Natural, direct, and concise.",
        backstory: "A stable integration fixture with explicit persona context.",
        firstMessage: "I'm here. What should we talk about?",
        exampleDialogue: ["Tell me the part that matters most."],
      },
    },
  });
  await prisma.characterStats.create({
    data: {
      characterId: character.id,
      likesCount: input.likes ?? 0,
      chatsCount: input.chats ?? 0,
      viewsCount: input.views ?? 0,
    },
  });
  return character;
}

/**
 * Explicitly publishes an existing official Character into the customer
 * audience. `createCharacter` intentionally does not do this: public
 * visibility is only a presentation field until the immutable Release,
 * catalog qualification, serving pointer, and publishable avatar all agree.
 */
export async function publishCharacterForPublicAudience(input: {
  characterId: string;
  ownerId: string;
}) {
  const assetId = `${input.characterId}-public-avatar`;
  const projectId = `${input.characterId}-public-project`;
  const releaseId = `${input.characterId}-public-release`;
  const snapshotHash = `${releaseId}-snapshot`;

  await prisma.$transaction(async (tx) => {
    const character = await tx.character.findUnique({
      where: { id: input.characterId },
      select: {
        source: true,
        visibility: true,
        status: true,
        deletedAt: true,
      },
    });
    if (
      !character ||
      character.source !== "official" ||
      character.visibility !== "public" ||
      character.status !== "approved" ||
      character.deletedAt !== null
    ) {
      throw new Error(
        "Public editorial fixture requires an existing approved official Character",
      );
    }
    await tx.mediaAsset.create({
      data: {
        id: assetId,
        ownerId: input.ownerId,
        characterId: input.characterId,
        type: "image",
        url: `/user-content/${assetId}/content.webp`,
        thumbnailUrl: `/user-content/${assetId}/thumbnail.webp`,
        storageKey: `test-fixtures/${assetId}.webp`,
        contentType: "image/webp",
        visibility: "public_pack",
        safetyStatus: "passed",
        metadata: {
          source: "editorial_import",
          synthetic: false,
          platformAsset: { status: "approved" },
        },
      },
    });
    await tx.character.update({
      where: { id: input.characterId },
      data: { imageAssetId: assetId },
    });
    await tx.characterProject.create({
      data: {
        id: projectId,
        characterId: input.characterId,
        phase: "live_management",
        audience: {},
        successCriteria: [],
      },
    });
    await tx.characterRelease.create({
      data: {
        id: releaseId,
        projectId,
        revisionId: `${releaseId}-revision`,
        characterContentVersionId: `${releaseId}-content`,
        generationProvenance: {
          schemaVersion: "character-release-editorial-import-v1",
          sourceAssetId: assetId,
        },
        releasePlacementManifest: {
          schemaVersion: 1,
          kind: "editorial_import",
          placements: [
            {
              slotKey: "character_avatar",
              assetId,
              slotVersion: 1,
            },
          ],
        },
        snapshotHash,
        readiness: "ready",
        legacy: true,
        status: "published",
        publishedAt: new Date(),
      },
    });
    await tx.publicCatalogQualification.create({
      data: {
        id: `${releaseId}-qualification`,
        releaseId,
        releaseSnapshotHash: snapshotHash,
        kind: "editorial_import",
        evidence: {
          schemaVersion: "public-catalog-qualification-v1",
          policyVersion: "public-catalog-editorial-import-v1",
          sourceAssetId: assetId,
        },
      },
    });
    await tx.characterServing.create({
      data: {
        id: `${releaseId}-serving`,
        characterId: input.characterId,
        currentReleaseId: releaseId,
        state: "live",
      },
    });
  });

  return { assetId, projectId, releaseId };
}

export interface CreatePlanInput {
  id: string;
  slug?: string;
  name?: string;
  billingPeriod?: "monthly" | "yearly";
  priceCents?: number;
  includedDreamcoins?: number;
  features?: Prisma.InputJsonValue;
  active?: boolean;
}

export async function createPlan(input: CreatePlanInput) {
  return prisma.plan.create({
    data: {
      id: input.id,
      slug: input.slug ?? "premium",
      name: input.name ?? "Premium",
      billingPeriod: input.billingPeriod ?? "monthly",
      priceCents: input.priceCents ?? 1999,
      includedDreamcoins: input.includedDreamcoins ?? 1000,
      active: input.active ?? true,
      features:
        input.features ?? {
          unlimitedMessages: true,
          imageGeneration: true,
          videoGeneration: true,
          customPrompt: true,
        },
    },
  });
}

export interface CreateMediaInput {
  id: string;
  ownerId: string;
  type?: "image" | "video";
  url?: string;
  storageKey?: string | null;
  contentType?: string;
  visibility?: string;
  safetyStatus?: string;
  prompt?: string;
  sourceJobId?: string;
}

export async function createMedia(input: CreateMediaInput) {
  return prisma.mediaAsset.create({
    data: {
      id: input.id,
      ownerId: input.ownerId,
      type: input.type ?? "image",
      url: input.url ?? "/images/ourdream/card-sarah-mercer.webp",
      thumbnailUrl: input.url ?? "/images/ourdream/card-sarah-mercer.webp",
      storageKey:
        input.storageKey === undefined
          ? `test-fixtures/${input.id}.${input.type === "video" ? "mp4" : "webp"}`
          : input.storageKey,
      contentType:
        input.contentType ??
        (input.type === "video" ? "video/mp4" : "image/webp"),
      visibility: input.visibility ?? "private",
      safetyStatus: input.safetyStatus ?? "passed",
      prompt: input.prompt,
      sourceJobId: input.sourceJobId,
      metadata: {},
    },
  });
}

export async function createRedeemCode(
  code: string,
  reward: Prisma.InputJsonValue = { dreamcoins: 500 },
  options: { maxRedemptions?: number | null; expiresAt?: Date | null } = {},
) {
  const codeHash = redeemCodeHash(code);
  const update: Prisma.RedeemCodeUpdateInput = { reward, status: "active" };
  if (options.maxRedemptions !== undefined) update.maxRedemptions = options.maxRedemptions;
  if (options.expiresAt !== undefined) update.expiresAt = options.expiresAt;
  return prisma.redeemCode.upsert({
    where: { codeHash },
    update,
    create: {
      id: code,
      codeHash,
      reward,
      status: "active",
      maxRedemptions: options.maxRedemptions ?? null,
      expiresAt: options.expiresAt ?? null,
    },
  });
}

/** Append a dreamcoin ledger entry, keeping balanceAfter consistent. */
export async function grantCoins(userId: string, delta: number, reason = "test_grant") {
  const aggregate = await prisma.dreamcoinLedger.aggregate({
    where: { userId },
    _sum: { delta: true },
  });
  const balance = aggregate._sum.delta ?? 0;
  return prisma.dreamcoinLedger.create({
    data: { userId, delta, balanceAfter: balance + delta, reason },
  });
}

export async function dreamcoinBalance(userId: string) {
  const aggregate = await prisma.dreamcoinLedger.aggregate({
    where: { userId },
    _sum: { delta: true },
  });
  return aggregate._sum.delta ?? 0;
}

export async function runQueuedGenerationJobs(
  limit = 25,
  queues: readonly string[] = [
    "ai.image.generate",
    "ai.video.generate",
    MAIN_QUEUES.generationTerminalIngest,
    MAIN_QUEUES.aiFinalize,
  ],
) {
  const claimed: Array<{ id: string; queue: string; status: string; error?: string }> = [];
  let processed = 0;
  for (let index = 0; index < limit; index += 1) {
    let found = false;
    for (const queue of queues) {
      if (
        queue === MAIN_QUEUES.generationTerminalIngest ||
        queue === MAIN_QUEUES.aiFinalize
      ) {
        const result = await drainLocalAiPipeline({
          queues: [queue],
          limit: 1,
          workerId: `test-main-finalizer-${index}`,
        });
        if (result.claimed.length === 0) continue;
        const failed = result.claimed.find((item) => item.status === "failed");
        if (failed) {
          throw new Error(
            `Test Main finalizer failed ${failed.id}: ${failed.error ?? "unknown error"}`,
          );
        }
        found = true;
        claimed.push(...result.claimed);
        processed += result.processed;
        break;
      }
      if (queue !== "ai.image.generate" && queue !== "ai.video.generate") {
        continue;
      }
      const result = await jobQueue.processNext({
        queue,
        workerId: `test-external-gen-${index}`,
        processor: async (job) => {
          const genPipeline = await loadTestGenPipeline();
          const deps: TestGenPipelineDeps = {
            acknowledgeTerminalRecord: async (input) => {
              const result = await ingestGenerationTerminalRecord(input);
              if (!result.acknowledged) {
                const receipt = result.receiptId
                  ? await prisma.inboundEventReceipt.findUnique({
                      where: { id: result.receiptId },
                      select: { error: true },
                    })
                  : null;
                throw new Error(
                  `Main quarantined Gen terminal record ${input.terminalRecord.attemptId}: ${JSON.stringify(receipt?.error ?? "unknown reason")}`,
                );
              }
              await dispatchPendingGenerationTerminalRecords();
            },
            recordTransportExecution: async (input) => {
              await recordGenerationTransportExecution(input);
            },
            providers: await generationTestProviders(),
            attemptsMade: job.attemptsMade,
            maxAttempts: job.maxAttempts,
          };
          const payload =
            typeof job.payload === "object" &&
            job.payload !== null &&
            !Array.isArray(job.payload)
              ? (job.payload as Record<string, unknown>)
              : {};
          const pinnedProvider =
            typeof payload.provider === "string" ? payload.provider : "mock";
          const envKey =
            queue === "ai.image.generate"
              ? "GEN_IMAGE_PROVIDER"
              : "GEN_VIDEO_PROVIDER";
          const previousAdapter = process.env[envKey];
          process.env[envKey] =
            genPipeline.workerAdapterForRecordedProvider(pinnedProvider);
          try {
            if (queue === "ai.image.generate") {
              await genPipeline.processImageGenerate(job.payload, deps);
            } else {
              await genPipeline.processVideoGenerate(job.payload, deps);
            }
          } finally {
            if (previousAdapter === undefined) delete process.env[envKey];
            else process.env[envKey] = previousAdapter;
          }
        },
      });
      if (!result.job) continue;
      if (result.status === "failed") {
        throw new Error(
          `Test Gen owner failed ${queue} job=${result.job.id}: ${result.error ?? "unknown error"}`,
        );
      }
      found = true;
      claimed.push({
        id: result.job.id,
        queue: result.job.queue,
        status: result.status,
        ...(result.error ? { error: result.error } : {}),
      });
      if (result.status === "completed") processed += 1;
      break;
    }
    if (!found) break;
  }
  return { workerId: "test-external-gen", claimed, processed };
}

type TestGenPipelineDeps = {
  acknowledgeTerminalRecord(input: any): Promise<void>;
  recordTransportExecution(input: any): Promise<void>;
  providers: TestGenProviders;
  attemptsMade: number;
  maxAttempts: number;
};

type TestGenProviders = {
  image: { generate(input: any): Promise<any> };
  video: { generate(input: any): Promise<any> };
  moderation: { check(input: any): Promise<any> };
  blob: {
    putPrivate(input: any): Promise<any>;
    putPrivateIfAbsent(input: any): Promise<any>;
    delete(input: any): Promise<any>;
    signGetUrl(input: any): Promise<any>;
    getPrivate?(input: any): Promise<any>;
  };
};

type TestGenPipeline = {
  workerAdapterForRecordedProvider(provider: string): string;
  processImageGenerate(payload: unknown, deps: TestGenPipelineDeps): Promise<void>;
  processVideoGenerate(payload: unknown, deps: TestGenPipelineDeps): Promise<void>;
};

async function loadTestGenPipeline(): Promise<TestGenPipeline> {
  // INTENT: exercise the real Gen owner in integration tests without making
  // Main production code import Gen internals or reintroducing provider work.
  const modulePath = new URL("../../../../gen/src/pipeline.ts", import.meta.url).href;
  return await import(modulePath) as TestGenPipeline;
}

let stableTestGenProviders: TestGenProviders | undefined;

export async function generationTestProviders(): Promise<TestGenProviders> {
  if (stableTestGenProviders) return stableTestGenProviders;
  const modulePath = new URL("../../../../gen/src/providers.ts", import.meta.url).href;
  const providerModule = await import(modulePath) as {
    createMockGenProviders(): TestGenProviders;
  };
  stableTestGenProviders = providerModule.createMockGenProviders();
  return stableTestGenProviders;
}

export async function completeQueuedCharacterPreview(input: {
  previewJobId: string;
  draftId: string;
  userId: string;
}) {
  const generationJob = await prisma.generationJob.findFirstOrThrow({
    where: {
      sourceType: "character_preview",
      sourceId: input.previewJobId,
      userId: input.userId,
    },
  });
  const attempt = await prisma.generationAttempt.findFirstOrThrow({
    where: { requestId: generationJob.id },
    orderBy: { attemptNo: "desc" },
  });
  const generateDedupeKey =
    `generation:${generationJob.id}:attempt:${attempt.attemptNo}`;
  const queued = await jobQueue.getByDedupeKey(
    "ai.image.generate",
    generateDedupeKey,
  );
  expect(queued?.payload).toMatchObject({
    kind: "image",
    generationJobId: generationJob.id,
    attemptId: attempt.id,
    userId: input.userId,
  });
  // INTENT: Character Preview tests traverse the same Gen terminal-record ACK
  // seam as every other image Request. Hand-building a Main finalize payload
  // would bypass immutable Attempt storage and hide dispatch-envelope drift.
  return runQueuedGenerationJobs(4);
}

// ---------------------------------------------------------------------------
// Cleanup — delete everything created under a test-file prefix, FK-safe order.
// ---------------------------------------------------------------------------

export async function purgeQueuedGenerationJobs(
  generationJobIds: readonly string[],
) {
  const uniqueJobIds = [...new Set(generationJobIds)];
  const attempts = uniqueJobIds.length === 0
    ? []
    : await prisma.generationAttempt.findMany({
        where: { requestId: { in: uniqueJobIds } },
        select: { id: true },
      });
  let removed = 0;
  for (const jobId of uniqueJobIds) {
    removed += await jobQueue.removeByDedupePrefix(`generation:${jobId}`, [
      "ai.image.generate",
      "ai.video.generate",
    ]);
    removed += await jobQueue.removeByDedupePrefix(
      `generation-finalize:${jobId}:`,
      ["app.ai.finalize"],
    );
  }
  for (const attempt of attempts) {
    removed += (await jobQueue.removeByDedupeKey(
        MAIN_QUEUES.generationTerminalIngest,
        idempotencyKeys.generationTerminalRelay(attempt.id),
      ))
      ? 1
      : 0;
    removed += (await jobQueue.removeByDedupeKey(
        MAIN_QUEUES.aiFinalize,
        `generation-terminal-record-finalize:${attempt.id}`,
      ))
      ? 1
      : 0;
  }
  return removed;
}

export async function purgeTestData(prefix: string) {
  const sw = { startsWith: prefix } as const;
  const purgeUsers = await prisma.user.findMany({
    where: { OR: [{ id: sw }, { email: sw }] },
    select: { id: true },
  });
  const purgeUserIds = purgeUsers.map((user) => user.id);
  const purgeAnalyticsWhere: Prisma.AnalyticsEventWhereInput = {
    OR: [
      ...(purgeUserIds.length > 0 ? [{ userId: { in: purgeUserIds } }] : []),
      { userId: sw },
      { anonymousId: sw },
    ],
  };
  const purgeAnalyticsEvents = await prisma.analyticsEvent.findMany({
    where: purgeAnalyticsWhere,
    select: {
      id: true,
      sourceService: true,
      sourceEventId: true,
    },
  });
  const purgeAnalyticsEventIds = purgeAnalyticsEvents.map((event) => event.id);
  const purgeGenerationJobs = await prisma.generationJob.findMany({
    where: {
      OR: [
        ...(purgeUserIds.length > 0
          ? [{ userId: { in: purgeUserIds } }]
          : []),
        { id: sw },
        { characterId: sw },
        { visualProfileId: sw },
        { referenceSetRevisionId: sw },
        { lookId: sw },
        { sourceId: sw },
      ],
    },
    select: { id: true },
  });

  // GenerationJob IDs are generated independently from the test prefix. User
  // cascade removes their database rows, but BullMQ has no FK and would retain
  // `generation:<random-id>` work forever. Remove the exact work and finalize
  // keys before deleting the owning users so later test files cannot consume
  // orphan image work instead of their own video/image job.
  await purgeQueuedGenerationJobs(purgeGenerationJobs.map((job) => job.id));
  await jobQueue.removeByDedupePrefix(prefix, [
    "ai.image.generate",
    "ai.video.generate",
    MAIN_QUEUES.generationTerminalIngest,
    MAIN_QUEUES.aiFinalize,
  ]);

  const derivedCaseEvidence = await prisma.caseEvidence.findMany({
    where: { sourceId: sw },
    select: { caseId: true },
  });
  const derivedCases = await prisma.adminCase.findMany({
    where: {
      OR: [
        { id: sw },
        { targetId: sw },
        { ownerId: sw },
        { id: { in: derivedCaseEvidence.map((item) => item.caseId) } },
      ],
    },
    select: { id: true },
  });
  const derivedCaseIds = derivedCases.map((item) => item.id);
  if (derivedCaseIds.length > 0) {
    await prisma.operationalWorkPreference.deleteMany({
      where: { sourceType: "admin_case", sourceId: { in: derivedCaseIds } },
    });
    await prisma.decisionRecord.deleteMany({
      where: { sourceType: "admin_case", sourceId: { in: derivedCaseIds } },
    });
    await prisma.mainOutboxEvent.deleteMany({ where: { aggregateId: { in: derivedCaseIds } } });
    await prisma.adminAuditLog.deleteMany({ where: { targetId: { in: derivedCaseIds } } });
    await prisma.caseEvidence.deleteMany({ where: { caseId: { in: derivedCaseIds } } });
    await prisma.adminCase.deleteMany({ where: { id: { in: derivedCaseIds } } });
  }

  if (purgeAnalyticsEventIds.length > 0) {
    const projectionReceiptKeys = purgeAnalyticsEvents
      .filter((event) => event.sourceEventId !== null)
      .map((event) => ({
        sourceService: `main.product_projection:${event.sourceService}`,
        sourceEventId: event.sourceEventId as string,
      }));
    await prisma.metricProjectionReceipt.deleteMany({
      where: { canonicalEventId: { in: purgeAnalyticsEventIds } },
    });
    if (projectionReceiptKeys.length > 0) {
      await prisma.inboundEventReceipt.deleteMany({
        where: { OR: projectionReceiptKeys },
      });
    }
    await prisma.mainOutboxEvent.deleteMany({
      where: {
        eventType: "product.event.persisted.v2",
        aggregateId: { in: purgeAnalyticsEventIds },
      },
    });
  }
  await prisma.mainOutboxEvent.deleteMany({ where: { aggregateId: sw } });
  await prisma.moderationReview.deleteMany({ where: { OR: [{ id: sw }, { reportId: sw }] } });
  await prisma.adminAuditLog.deleteMany({
    where: { OR: [{ id: sw }, { actorId: sw }, { targetId: sw }] },
  });
  await prisma.adminActionRequest.deleteMany({
    where: { OR: [{ id: sw }, { requestedById: sw }, { approvedById: sw }, { targetId: sw }] },
  });
  await prisma.supportConsentGrant.deleteMany({
    where: { OR: [{ id: sw }, { userId: sw }, { targetId: sw }, { ticketId: sw }] },
  });
  await prisma.supportRequest.deleteMany({
    where: { OR: [{ id: sw }, { ticketId: sw }, { userId: sw }, { assignedToId: sw }] },
  });
  await prisma.productFeedbackVote.deleteMany({
    where: { OR: [{ id: sw }, { userId: sw }, { itemId: sw }] },
  });
  await prisma.productFeedbackItem.deleteMany({
    where: { OR: [{ id: sw }, { sourceKey: sw }, { createdById: sw }, { title: sw }] },
  });
  await prisma.legalHold.deleteMany({
    where: {
      OR: [
        { id: sw },
        { targetId: sw },
        { caseNumber: sw },
        { approvedById: sw },
        { createdById: sw },
        { releasedById: sw },
      ],
    },
  });
  await prisma.adminUserPermission.deleteMany({
    where: { OR: [{ id: sw }, { userId: sw }, { createdById: sw }] },
  });
  await prisma.adminSavedView.deleteMany({ where: { OR: [{ id: sw }, { ownerId: sw }] } });
  await prisma.mediaAssetPlacement.deleteMany({
    where: { OR: [{ id: sw }, { mediaAssetId: sw }, { targetId: sw }, { createdById: sw }] },
  });
  await prisma.contentProductionItem.deleteMany({
    where: {
      OR: [
        { id: sw },
        { batchId: sw },
        { jobId: sw },
        { mediaAssetId: sw },
        { reviewedById: sw },
      ],
    },
  });
  await prisma.contentProductionBatch.deleteMany({
    where: { OR: [{ id: sw }, { targetId: sw }, { createdById: sw }, { title: sw }] },
  });
  await prisma.generationModelProfile.deleteMany({ where: { OR: [{ id: sw }, { profileKey: sw }] } });
  await prisma.generationRecipe.deleteMany({
    where: { OR: [{ id: sw }, { recipeKey: sw }] },
  });
  await prisma.generationProviderRoute.deleteMany({
    where: { OR: [{ id: sw }, { profileKey: sw }] },
  });
  await prisma.pricingRule.deleteMany({ where: { OR: [{ id: sw }, { ruleKey: sw }] } });
  await prisma.featureFlag.deleteMany({ where: { key: sw } });
  await prisma.appSetting.deleteMany({ where: { key: sw } });
  await prisma.appeal.deleteMany({ where: { OR: [{ id: sw }, { userId: sw }] } });
  await prisma.contentReport.deleteMany({
    where: { OR: [{ id: sw }, { targetId: sw }, { reporterId: sw }] },
  });
  await prisma.moderationEvent.deleteMany({ where: { OR: [{ id: sw }, { targetId: sw }] } });
  await prisma.providerEvent.deleteMany({
    where: { OR: [{ id: sw }, { providerEventId: sw }] },
  });
  await prisma.analyticsEvent.deleteMany({ where: purgeAnalyticsWhere });
  await prisma.redeemCodeRedemption.deleteMany({
    where: { OR: [{ userId: sw }, { redeemCodeId: sw }] },
  });
  await prisma.redeemCode.deleteMany({ where: { OR: [{ id: sw }, { codeHash: sw }] } });
  await prisma.referral.deleteMany({
    where: { OR: [{ id: sw }, { inviterId: sw }, { inviteeId: sw }, { code: sw }] },
  });
  await prisma.follow.deleteMany({ where: { OR: [{ followerId: sw }, { followeeId: sw }] } });
  await prisma.generationSettlementLink.deleteMany({ where: { requestId: sw } });

  // Admin v2 character roots do not all carry database cascades because the
  // expand/backfill phase must tolerate legacy rows. Purge them explicitly so
  // tests cannot leave orphan Projects that poison Portfolio or cutover gates.
  const characters = await prisma.character.findMany({
    where: { OR: [{ id: sw }, { creatorId: sw }] },
    select: { id: true },
  });
  const characterIds = characters.map((character) => character.id);
  const projects = await prisma.characterProject.findMany({
    where: {
      OR: [
        { id: sw },
        ...(characterIds.length > 0 ? [{ characterId: { in: characterIds } }] : []),
      ],
    },
    select: { id: true, characterId: true },
  });
  const projectIds = projects.map((project) => project.id);
  const projectCharacterIds = [...new Set([...characterIds, ...projects.map((project) => project.characterId)])];
  const releases = projectIds.length > 0
    ? await prisma.characterRelease.findMany({ where: { projectId: { in: projectIds } }, select: { id: true } })
    : [];
  const releaseIds = releases.map((release) => release.id);
  if (releaseIds.length > 0) {
    await prisma.publicCatalogQualification.deleteMany({
      where: { releaseId: { in: releaseIds } },
    });
    const validationRuns = await prisma.releaseValidationRun.findMany({ where: { releaseId: { in: releaseIds } }, select: { id: true } });
    await prisma.releaseCheckResult.deleteMany({ where: { validationRunId: { in: validationRuns.map((run) => run.id) } } });
    await prisma.releaseValidationRun.deleteMany({ where: { releaseId: { in: releaseIds } } });
    await prisma.releaseMonitor.deleteMany({ where: { releaseId: { in: releaseIds } } });
    await prisma.characterReleaseEvent.deleteMany({ where: { releaseId: { in: releaseIds } } });
  }
  if (projectCharacterIds.length > 0) {
    await prisma.characterServing.deleteMany({ where: { characterId: { in: projectCharacterIds } } });
  }
  if (releaseIds.length > 0) await prisma.characterRelease.deleteMany({ where: { id: { in: releaseIds } } });
  if (projectIds.length > 0) {
    await prisma.mainOutboxEvent.deleteMany({ where: { aggregateId: { in: projectIds } } });
    await prisma.adminCollaborationActivity.deleteMany({ where: { targetId: { in: projectIds } } });
    await prisma.characterRevision.deleteMany({ where: { projectId: { in: projectIds } } });
    await prisma.characterProject.deleteMany({ where: { id: { in: projectIds } } });
  }
  if (projectCharacterIds.length > 0) {
    const profiles = await prisma.characterVisualProfile.findMany({ where: { characterId: { in: projectCharacterIds } }, select: { id: true } });
    const referenceSets = await prisma.referenceSetRevision.findMany({
      where: { visualProfileId: { in: profiles.map((profile) => profile.id) } },
      select: { id: true },
    });
    await prisma.characterVisualReferenceSnapshot.deleteMany({
      where: { referenceSetRevisionId: { in: referenceSets.map((referenceSet) => referenceSet.id) } },
    });
    await prisma.referenceSetRevision.deleteMany({ where: { id: { in: referenceSets.map((referenceSet) => referenceSet.id) } } });
    await prisma.character.updateMany({
      where: { id: { in: projectCharacterIds } },
      data: { currentContentVersionId: null },
    });
    await prisma.characterContentVersion.deleteMany({ where: { characterId: { in: projectCharacterIds } } });
  }
  await prisma.generationRouteQualification.deleteMany({ where: { OR: [{ id: sw }, { routeFingerprint: sw }] } });

  // Characters cascade: stats, tags, likes, submissions, chat sessions, messages.
  await prisma.character.deleteMany({ where: { OR: [{ id: sw }, { creatorId: sw }] } });
  // Media cascades most dependents, but immutable release reference snapshots
  // deliberately use RESTRICT. Discover the exact media purge set first so
  // official characters (which intentionally have no creatorId) cannot leave
  // a snapshot that makes fixture cleanup order-dependent.
  const purgeMedia = await prisma.mediaAsset.findMany({
    where: { OR: [{ id: sw }, { ownerId: sw }] },
    select: { id: true },
  });
  const purgeMediaIds = purgeMedia.map((asset) => asset.id);
  if (purgeMediaIds.length > 0) {
    await prisma.characterVisualReferenceSnapshot.deleteMany({
      where: { mediaAssetId: { in: purgeMediaIds } },
    });
  }
  // Media cascade: likes, collection items.
  await prisma.mediaAsset.deleteMany({ where: { id: { in: purgeMediaIds } } });
  await prisma.generationPreset.deleteMany({ where: { OR: [{ id: sw }, { ownerId: sw }] } });
  await prisma.characterDraft.deleteMany({ where: { OR: [{ id: sw }, { ownerId: sw }] } });
  await prisma.ageGateAcceptance.deleteMany({
    where: { OR: [{ anonymousId: sw }, { userId: sw }, { sourcePath: sw }] },
  });

  // AccountDeletion intentionally has no User FK because its anonymous
  // terminal receipt outlives the account. Non-terminal test workflows must
  // therefore be removed explicitly before their fixture User is purged.
  await prisma.accountDeletion.deleteMany({
    where: {
      OR: [
        { userId: sw },
        ...(purgeUserIds.length > 0 ? [{ userId: { in: purgeUserIds } }] : []),
      ],
    },
  });

  // Users cascade most remaining per-user rows (sessions, subs, ledger, jobs...).
  await prisma.user.deleteMany({ where: { OR: [{ id: sw }, { email: sw }] } });
  // Plans last — subscriptions referencing them are gone via user cascade.
  await prisma.plan.deleteMany({ where: { OR: [{ id: sw }, { slug: sw }] } });
  await prisma.tag.deleteMany({ where: { OR: [{ id: sw }, { slug: sw }] } });
}

// ---------------------------------------------------------------------------
// Common assertions
// ---------------------------------------------------------------------------

export function expectError(result: ApiResult, status: number, code?: string) {
  expect(result.status, JSON.stringify(result.json)).toBe(status);
  expect(result.ok).toBe(false);
  if (code) expect(result.error?.code).toBe(code);
}

export function expectOk(result: ApiResult, status = 200) {
  expect(result.status, JSON.stringify(result.json)).toBe(status);
  expect(result.ok).toBe(true);
}
