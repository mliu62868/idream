import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";
import {
  publishCharacterForPublicAudience,
  purgeTestData,
  runQueuedGenerationJobs,
} from "@/server/test/helpers";
import { dispatchV1 } from "./service";

const testEmail = "api-smoke@customer.invalid";
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
    await prisma.character.create({
      data: {
        id: testCharacterId,
        creatorId: "api-smoke-owner",
        source: "official",
        name: "API Smoke Character",
        age: 24,
        description: "A seeded public character for API tests.",
        visibility: "public",
        status: "approved",
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
    await prisma.characterVisualProfile.create({
      data: {
        id: "api-smoke-bootstrap-visual-profile",
        characterId: testCharacterId,
        version: 1,
        status: "active",
        style: "realistic",
        identityPrompt: "API Smoke Character, adult woman",
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
      characterId: testCharacterId,
      ownerId: "api-smoke-owner",
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
          expect.objectContaining({
            id: testCharacterId,
            source: "official",
            creatorType: "official",
            creatorId: null,
            creator: "Official",
            creatorName: "Official",
            canEditIdentity: false,
          }),
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
    const signedUpUser = await prisma.user.findUniqueOrThrow({ where: { email: testEmail } });
    await expect(prisma.analyticsEvent.findUnique({
      where: {
        sourceService_sourceEventId: {
          sourceService: "main",
          sourceEventId: `signup:${signedUpUser.id}`,
        },
      },
    })).resolves.toMatchObject({
      name: "customer.signup.completed.v2",
      userId: signedUpUser.id,
    });

    const cookies = cookieHeader([...accepted.cookies, ...signup.cookies]);
    const checkout = await call(
      "POST",
      "/billing/checkout",
      { planId: testPlanId, autoConfirm: true },
      {
        cookie: cookies,
        "idempotency-key": "api-smoke-checkout-key",
      },
    );
    expect(checkout.status).toBe(200);
    const activeSubscription = await prisma.subscription.findFirstOrThrow({
      where: { userId: signedUpUser.id, status: "active" },
    });
    await expect(prisma.analyticsEvent.findUnique({
      where: {
        sourceService_sourceEventId: {
          sourceService: "main",
          sourceEventId: `subscription:${activeSubscription.id}:activated`,
        },
      },
    })).resolves.toMatchObject({
      name: "subscription.activated.v2",
      userId: signedUpUser.id,
    });

    const generationInput = {
      characterId: testCharacterId,
      mode: "image",
      outputCount: 1,
      prompt: "cinematic portrait",
    };
    const quotedGeneration = await call(
      "POST",
      "/generation/quote",
      generationInput,
      { cookie: cookies },
    );
    expect(quotedGeneration.status).toBe(200);
    const quote = (
      quotedGeneration.json as {
        data: {
          quote: {
            profileId: string;
            profileVersion: number;
            routeFingerprint: string;
            pricing: { fingerprint: string };
            costs: Array<{
              outputCount: number;
              costDreamcoins: number;
            }>;
          };
        };
      }
    ).data.quote;
    const exactCost = quote.costs.find(
      (cost) => cost.outputCount === generationInput.outputCount,
    );
    expect(exactCost).toBeTruthy();
    const generation = await call(
      "POST",
      "/generation/jobs",
      {
        ...generationInput,
        quoteAuthority: {
          profileId: quote.profileId,
          profileVersion: quote.profileVersion,
          routeFingerprint: quote.routeFingerprint,
          pricingFingerprint: quote.pricing.fingerprint,
          outputCount: generationInput.outputCount,
          costDreamcoins: exactCost?.costDreamcoins,
        },
      },
      {
        cookie: cookies,
        "idempotency-key": "api-smoke-generation",
      },
    );
    expect(generation.status).toBe(202);
    expect(generation.json).toMatchObject({
      ok: true,
      data: {
        job: { status: "queued" },
        assets: [],
      },
    });
    const generationBody = generation.json as { data: { job: { id: string } } };
    await drainGenerationToCompletion(generationBody.data.job.id);
    const poll = await call(
      "GET",
      `/generation/jobs/${generationBody.data.job.id}`,
      undefined,
      { cookie: cookies },
    );
    expect(poll.json).toMatchObject({
      ok: true,
      data: {
        job: { status: "completed" },
        assets: [expect.objectContaining({ type: "image" })],
      },
    });
  });
});

async function drainGenerationToCompletion(jobId: string) {
  for (let pass = 0; pass < 12; pass += 1) {
    await runQueuedGenerationJobs(8);
    const job = await prisma.generationJob.findUnique({
      where: { id: jobId },
      select: { status: true },
    });
    if (job?.status === "completed") return;
    if (job && ["blocked", "cancelled", "failed", "refunded"].includes(job.status)) {
      throw new Error(`Generation ${jobId} terminated as ${job.status}`);
    }
  }
  const job = await prisma.generationJob.findUnique({
    where: { id: jobId },
    select: { status: true },
  });
  throw new Error(`Generation ${jobId} did not complete; final status=${job?.status ?? "missing"}`);
}

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
  // The signup user's id is generated, so match its `api-smoke@…` email as
  // well as the deterministic `api-smoke-*` fixture ids. This deletes that
  // user's cascading Subscription before purge removes the prefixed Plan.
  await purgeTestData("api-smoke");
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
