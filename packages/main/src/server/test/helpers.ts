/* eslint-disable @typescript-eslint/no-explicit-any */
import { expect } from "vitest";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/server/lib/db";
import { AGE_GATE_COOKIE } from "@/server/lib/auth";
import { dispatchV1 } from "@/server/modules/ourdream/service";
import { jobQueue } from "@/server/jobs/queue";

// SPEC: Shared integration-test client + fixtures for the /api/v1 surface.
// INTENT: One ergonomic `api()` that drives dispatchV1 exactly like the route
// handler does, plus deterministic fixtures and a prefix-scoped purge so each
// test file is self-isolating on the shared, freshly-seeded test DB.
// INVARIANTS: dev auth headers (x-idream-*) only work because APP_ENV=test.

export const AGE_GATE_COOKIE_HEADER = `${AGE_GATE_COOKIE}=true`;

export interface ApiOptions {
  body?: unknown;
  headers?: Record<string, string>;
  query?: Record<string, string | number | boolean | undefined>;
  /** Sets x-idream-user-id (dev auth) — authenticates as this user. */
  userId?: string;
  /** Sets x-idream-role (dev auth) — user | moderator | admin. */
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
  const url = buildUrl(path, options.query);
  const headers: Record<string, string> = { ...options.headers };
  if (options.body !== undefined) headers["content-type"] = "application/json";
  if (options.userId) headers["x-idream-user-id"] = options.userId;
  if (options.role) headers["x-idream-role"] = options.role;
  if (options.anonymousId) headers["x-idream-anonymous-id"] = options.anonymousId;

  const cookies: string[] = [];
  if (options.cookie) cookies.push(options.cookie);
  if (options.ageGate) cookies.push(AGE_GATE_COOKIE_HEADER);
  if (cookies.length) headers["cookie"] = cookies.join("; ");

  const request = new Request(url, {
    method,
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
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
    setCookies: response.headers.getSetCookie(),
  };
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
  role?: "user" | "moderator" | "admin";
  displayName?: string;
  status?: "active" | "suspended" | "deleted";
}

export async function createUser(input: CreateUserInput) {
  return prisma.user.create({
    data: {
      id: input.id,
      email: input.email ?? `${input.id}@test.local`,
      emailVerified: true,
      displayName: input.displayName ?? "Test User",
      role: input.role ?? "user",
      status: input.status ?? "active",
    },
  });
}

export interface CreateCharacterInput {
  id: string;
  creatorId?: string;
  name?: string;
  age?: number;
  description?: string;
  visibility?: "private" | "unlisted" | "public";
  status?: string;
  style?: string;
  gender?: string;
  systemPrompt?: string;
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
      name: input.name ?? "Test Character",
      age: input.age ?? 24,
      description: input.description ?? "A seeded character for integration tests.",
      visibility: input.visibility ?? "public",
      status: input.status ?? "approved",
      style: input.style ?? "realistic",
      gender: input.gender ?? "female",
      systemPrompt: input.systemPrompt ?? null,
      imageAssetId: input.imageAssetId ?? null,
      appearance: {},
      advancedDetails: {},
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
      visibility: input.visibility ?? "private",
      safetyStatus: input.safetyStatus ?? "passed",
      prompt: input.prompt,
      sourceJobId: input.sourceJobId,
      metadata: {},
    },
  });
}

/** Mirror of service.simpleHash — used to seed redeem codes for tests. */
export function redeemCodeHash(code: string) {
  let hash = 5381;
  for (const char of code) hash = (hash * 33) ^ char.charCodeAt(0);
  return `redeem_${Math.abs(hash)}`;
}

export async function createRedeemCode(
  code: string,
  reward: Prisma.InputJsonValue = { dreamcoins: 500 },
) {
  return prisma.redeemCode.create({
    data: { codeHash: redeemCodeHash(code.toUpperCase()), reward, status: "active" },
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

// ---------------------------------------------------------------------------
// Cleanup — delete everything created under a test-file prefix, FK-safe order.
// ---------------------------------------------------------------------------

export async function purgeTestData(prefix: string) {
  const sw = { startsWith: prefix } as const;
  await jobQueue.removeByDedupePrefix(prefix, [
    "ai.image.generate",
    "ai.video.generate",
    "app.ai.finalize",
    "age.verification.webhook",
    "character.preview",
    "moderation.input",
    "report.triage",
    "analytics.events",
  ]);

  await prisma.moderationReview.deleteMany({ where: { OR: [{ id: sw }, { reportId: sw }] } });
  await prisma.appeal.deleteMany({ where: { OR: [{ id: sw }, { userId: sw }] } });
  await prisma.contentReport.deleteMany({
    where: { OR: [{ id: sw }, { targetId: sw }, { reporterId: sw }] },
  });
  await prisma.moderationEvent.deleteMany({ where: { OR: [{ id: sw }, { targetId: sw }] } });
  await prisma.providerEvent.deleteMany({
    where: { OR: [{ id: sw }, { providerEventId: sw }] },
  });
  await prisma.analyticsEvent.deleteMany({
    where: { OR: [{ userId: sw }, { anonymousId: sw }] },
  });
  await prisma.redeemCodeRedemption.deleteMany({
    where: { OR: [{ userId: sw }, { redeemCodeId: sw }] },
  });
  await prisma.redeemCode.deleteMany({ where: { OR: [{ id: sw }, { codeHash: sw }] } });
  await prisma.referral.deleteMany({
    where: { OR: [{ id: sw }, { inviterId: sw }, { inviteeId: sw }, { code: sw }] },
  });
  await prisma.follow.deleteMany({ where: { OR: [{ followerId: sw }, { followeeId: sw }] } });

  // Characters cascade: stats, tags, likes, submissions, chat sessions, messages.
  await prisma.character.deleteMany({ where: { OR: [{ id: sw }, { creatorId: sw }] } });
  // Media cascade: likes, collection items.
  await prisma.mediaAsset.deleteMany({ where: { OR: [{ id: sw }, { ownerId: sw }] } });
  await prisma.generationPreset.deleteMany({ where: { OR: [{ id: sw }, { ownerId: sw }] } });
  await prisma.characterDraft.deleteMany({ where: { OR: [{ id: sw }, { ownerId: sw }] } });
  await prisma.ageGateAcceptance.deleteMany({
    where: { OR: [{ anonymousId: sw }, { userId: sw }, { sourcePath: sw }] },
  });

  // Users cascade most remaining per-user rows (sessions, subs, ledger, jobs...).
  await prisma.user.deleteMany({ where: { id: sw } });
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
