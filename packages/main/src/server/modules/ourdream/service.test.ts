import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";
import { dispatchV1 } from "./service";

const testEmail = "api-smoke@idream.local";
const testCharacterId = "api-smoke-character";
const testPlanId = "api-smoke-plan";

describe("ourdream API dispatcher", () => {
  beforeEach(async () => {
    await cleanup();
    await prisma.user.create({
      data: {
        id: "api-smoke-owner",
        email: "api-smoke-owner@idream.local",
        emailVerified: true,
        displayName: "API Smoke Owner",
      },
    });
    await prisma.mediaAsset.create({
      data: {
        id: "api-smoke-image",
        ownerId: "api-smoke-owner",
        type: "image",
        url: "/images/ourdream/card-sarah-mercer.webp",
        thumbnailUrl: "/images/ourdream/card-sarah-mercer.webp",
        visibility: "public_pack",
        safetyStatus: "passed",
        metadata: {},
      },
    });
    await prisma.character.create({
      data: {
        id: testCharacterId,
        creatorId: "api-smoke-owner",
        name: "API Smoke Character",
        age: 24,
        description: "A seeded public character for API tests.",
        visibility: "public",
        status: "approved",
        imageAssetId: "api-smoke-image",
        appearance: {},
        advancedDetails: {},
      },
    });
    await prisma.characterStats.create({
      data: {
        characterId: testCharacterId,
        likesCount: 10,
        chatsCount: 20,
      },
    });
    await prisma.plan.create({
      data: {
        id: testPlanId,
        slug: "smoke-premium",
        name: "Premium Smoke",
        billingPeriod: "monthly",
        priceCents: 1999,
        includedDreamcoins: 1000,
        features: {
          unlimitedMessages: true,
          imageGeneration: true,
        },
      },
    });
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  it("enforces age gate before catalog access", async () => {
    const blocked = await call("GET", "/characters");
    expect(blocked.status).toBe(403);

    const accepted = await call("POST", "/age-gate/accept", {
      sourcePath: "/",
    });
    expect(accepted.status).toBe(200);

    const catalog = await call("GET", "/characters", undefined, {
      cookie: cookieHeader(accepted.cookies),
    });
    expect(catalog.status).toBe(200);
    expect(catalog.json).toMatchObject({
      ok: true,
      data: {
        items: expect.arrayContaining([
          expect.objectContaining({ id: testCharacterId }),
        ]),
      },
    });
  });

  it("runs signup, checkout, and image generation with mock providers", async () => {
    const accepted = await call("POST", "/age-gate/accept", {
      sourcePath: "/signup",
    });
    const signup = await call(
      "POST",
      "/auth/signup",
      {
        email: testEmail,
        password: "password123",
        name: "API Smoke User",
      },
      { cookie: cookieHeader(accepted.cookies) },
    );
    expect(signup.status).toBe(200);

    const cookies = cookieHeader([...accepted.cookies, ...signup.cookies]);
    const checkout = await call(
      "POST",
      "/billing/checkout",
      { planId: testPlanId, autoConfirm: true },
      { cookie: cookies },
    );
    expect(checkout.status).toBe(200);

    const generation = await call(
      "POST",
      "/generation/jobs",
      {
        characterId: testCharacterId,
        mode: "image",
        outputCount: 1,
        prompt: "cinematic portrait",
      },
      { cookie: cookies },
    );
    expect(generation.status).toBe(200);
    expect(generation.json).toMatchObject({
      ok: true,
      data: {
        job: { status: "completed" },
        assets: [expect.objectContaining({ type: "image" })],
      },
    });
  });
});

async function call(
  method: string,
  path: string,
  body?: unknown,
  headers?: Record<string, string>,
) {
  const request = new Request(`http://localhost/api/v1${path}`, {
    method,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const response = await dispatchV1(request, path.split("/").filter(Boolean));
  const text = await response.text();
  return {
    status: response.status,
    json: text ? (JSON.parse(text) as unknown) : null,
    cookies: response.headers.getSetCookie(),
  };
}

function cookieHeader(setCookies: string[]) {
  return setCookies
    .map((cookie) => cookie.split(";")[0])
    .filter(Boolean)
    .join("; ");
}

async function cleanup() {
  const users = await prisma.user.findMany({
    where: { email: { in: [testEmail, "api-smoke-owner@idream.local"] } },
    select: { id: true },
  });
  const userIds = users.map((user) => user.id);

  await prisma.mediaLike.deleteMany({
    where: { user: { email: testEmail } },
  });
  await prisma.mediaAsset.deleteMany({
    where: {
      OR: [{ id: "api-smoke-image" }, { owner: { email: testEmail } }],
    },
  });
  await prisma.generationJob.deleteMany({
    where: { user: { email: testEmail } },
  });
  await prisma.entitlement.deleteMany({ where: { user: { email: testEmail } } });
  await prisma.subscription.deleteMany({ where: { user: { email: testEmail } } });
  await prisma.checkoutSession.deleteMany({ where: { user: { email: testEmail } } });
  await prisma.dreamcoinLedger.deleteMany({ where: { user: { email: testEmail } } });
  await prisma.session.deleteMany({ where: { user: { email: testEmail } } });
  await prisma.account.deleteMany({ where: { user: { email: testEmail } } });
  await prisma.userPreferences.deleteMany({ where: { user: { email: testEmail } } });
  await prisma.ageGateAcceptance.deleteMany({
    where: {
      OR: [{ user: { email: testEmail } }, { sourcePath: { in: ["/", "/signup"] } }],
    },
  });
  await prisma.analyticsEvent.deleteMany({
    where: {
      OR: [
        { userId: { in: userIds } },
        { name: { in: ["signup", "age_gate_accepted", "checkout_started", "generation_completed"] } },
      ],
    },
  });
  await prisma.characterStats.deleteMany({ where: { characterId: testCharacterId } });
  await prisma.character.deleteMany({ where: { id: testCharacterId } });
  await prisma.plan.deleteMany({ where: { id: testPlanId } });
  await prisma.user.deleteMany({
    where: { email: { in: [testEmail, "api-smoke-owner@idream.local"] } },
  });
}
