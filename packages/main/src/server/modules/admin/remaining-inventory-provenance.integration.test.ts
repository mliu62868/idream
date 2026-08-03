import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";
import {
  getCharacterProjectDraftForResume,
  getCharacterWorkspace,
  updateCharacterProjectDraft,
} from "@/server/modules/admin-v2/characters/workspace";
import {
  listCharacterPortfolio,
} from "@/server/modules/admin-v2/characters/portfolio";
import {
  getGenerationJobV2,
  listGenerationJobsV2,
} from "@/server/modules/admin-v2/jobs/query";
import {
  getCreativeRunDetail,
  listCreativeRuns,
} from "@/server/modules/admin-v2/creative/workflow";
import {
  getContentAsset,
  listContentAssets,
} from "@/server/modules/admin/content/assets";
import {
  getPlacement,
  listPlacements,
} from "@/server/modules/admin/content/placements";
import {
  listReviewQueue,
  reviewSubmission,
} from "@/server/modules/admin/characters/review";
import {
  getContentCharacter,
  setCharacterVisibility,
} from "@/server/modules/admin/content/merchandising";
import {
  createCharacter,
  createUser,
  purgeTestData,
} from "@/server/test/helpers";

describe("remaining Admin inventory provenance", () => {
  const suffix = randomUUID();
  const prefix = `zt-remaining-provenance-${suffix}-`;
  const actorId = `${prefix}admin`;
  const classes = ["customer", "internal", "fixture", "audit"] as const;
  const owners = Object.fromEntries(
    classes.map((dataClass) => [dataClass, `${prefix}${dataClass}`]),
  ) as Record<(typeof classes)[number], string>;
  const characterIds = Object.fromEntries(
    classes.map((dataClass) => [dataClass, `${prefix}character-${dataClass}`]),
  ) as Record<(typeof classes)[number], string>;
  const projectIds = Object.fromEntries(
    classes.map((dataClass) => [dataClass, `${prefix}project-${dataClass}`]),
  ) as Record<(typeof classes)[number], string>;
  const jobIds = Object.fromEntries(
    classes.map((dataClass) => [dataClass, `${prefix}job-${dataClass}`]),
  ) as Record<(typeof classes)[number], string>;
  const batchIds = Object.fromEntries(
    classes.map((dataClass) => [dataClass, `${prefix}batch-${dataClass}`]),
  ) as Record<(typeof classes)[number], string>;
  const itemIds = Object.fromEntries(
    classes.map((dataClass) => [dataClass, `${prefix}item-${dataClass}`]),
  ) as Record<(typeof classes)[number], string>;
  const mediaIds = Object.fromEntries(
    classes.map((dataClass) => [dataClass, `${prefix}media-${dataClass}`]),
  ) as Record<(typeof classes)[number], string>;
  const placementIds = Object.fromEntries(
    classes.map((dataClass) => [dataClass, `${prefix}placement-${dataClass}`]),
  ) as Record<(typeof classes)[number], string>;
  const submissionIds = Object.fromEntries(
    classes.map((dataClass) => [dataClass, `${prefix}submission-${dataClass}`]),
  ) as Record<(typeof classes)[number], string>;

  beforeAll(async () => {
    await purgeTestData(prefix);
    await createUser({ id: actorId, role: "admin", dataClass: "internal" });
    for (const dataClass of classes) {
      await createUser({ id: owners[dataClass], dataClass });
      await createCharacter({
        id: characterIds[dataClass],
        creatorId: owners[dataClass],
        source: "user",
        name: `${prefix}${dataClass}`,
        visibility: "private",
        status: "pending_review",
      });
      await prisma.characterProject.create({
        data: {
          id: projectIds[dataClass],
          characterId: characterIds[dataClass],
          phase: "idea",
          audience: {
            audience: "Customers seeking a dependable companion",
            companionNeed: "A grounded conversation",
            productionPackage: "Character identity set",
            qaPlan: "Five-turn preview",
          },
          hypothesis: "A specific promise improves qualified conversations",
          differentiation: "A deliberately scoped companion experience",
          successCriteria: ["Qualified conversations improve"],
        },
      });
      await prisma.characterContentVersion.create({
        data: {
          id: `${prefix}content-${dataClass}`,
          characterId: characterIds[dataClass],
          version: 1,
          contentHash: `${prefix}content-hash-${dataClass}`,
          personaSnapshot: {
            name: `${prefix}${dataClass}`,
            relationshipArchetype: "steady confidante",
            characterPromise: "A dependable place to talk",
            personality: "Observant and warm",
            tone: "Warm and concise",
            backstory: "A thoughtful late-night host",
            exampleDialogue: ["Tell me what stayed with you today."],
          },
          openingSnapshot: {
            firstMessage: "What part of today is still following you?",
          },
          appearanceSnapshot: {
            identityAnchor: "Composed late-night host",
            stableTraits: ["warm eyes"],
            style: "realistic",
            referenceDirection: "Intimate editorial portrait",
          },
          sourceType: "remaining_inventory_provenance_test",
        },
      });
      await prisma.generationJob.create({
        data: {
          id: jobIds[dataClass],
          userId: owners[dataClass],
          characterId: characterIds[dataClass],
          mode: "image",
          status: "failed",
          controls: {},
          presetIds: [],
          outputCount: 1,
          errorCode: "provider_timeout",
        },
      });
      await prisma.contentProductionBatch.create({
        data: {
          id: batchIds[dataClass],
          title: `${prefix}${dataClass}`,
          purpose: "feed",
          targetType: "none",
          presetIds: [],
          totalItems: 1,
          createdById: owners[dataClass],
        },
      });
      await prisma.mediaAsset.create({
        data: {
          id: mediaIds[dataClass],
          ownerId: owners[dataClass],
          type: "image",
          url: `/user-content/${mediaIds[dataClass]}/content.webp`,
          safetyStatus: "passed",
          metadata: {
            platformAsset: {
              status: "approved",
              sourceBatchId: batchIds[dataClass],
            },
          },
        },
      });
      await prisma.contentProductionItem.create({
        data: {
          id: itemIds[dataClass],
          batchId: batchIds[dataClass],
          mediaAssetId: mediaIds[dataClass],
          status: "approved",
          tags: [],
        },
      });
      await prisma.mediaAssetPlacement.create({
        data: {
          id: placementIds[dataClass],
          mediaAssetId: mediaIds[dataClass],
          slot: "feed_card",
          targetType: "campaign",
          targetId: `${prefix}campaign-${dataClass}`,
          status: "draft",
          createdById: actorId,
          metadata: {},
        },
      });
      await prisma.characterSubmission.create({
        data: {
          id: submissionIds[dataClass],
          characterId: characterIds[dataClass],
          submitterId: owners[dataClass],
          status: "pending",
        },
      });
    }
  });

  afterAll(async () => {
    await purgeTestData(prefix);
    await prisma.$disconnect();
  });

  it("keeps character portfolio, workspace, review, and merchandising operational-only", async () => {
    const portfolio = await responseData(
      await listCharacterPortfolio(adminRequest(`/api/v2/admin/characters/portfolio?search=${prefix}&limit=100`)),
    );
    expect(ids(portfolio.items)).toEqual(
      new Set([characterIds.customer, characterIds.internal]),
    );

    await expect(getCharacterWorkspace(characterIds.customer)).resolves.toMatchObject({
      character: { id: characterIds.customer },
    });
    await expect(getCharacterWorkspace(characterIds.fixture)).rejects.toMatchObject({
      status: 404,
    });
    await expect(
      getCharacterProjectDraftForResume(characterIds.customer),
    ).resolves.toMatchObject({
      authority: { characterId: characterIds.customer },
    });
    await expect(
      getCharacterProjectDraftForResume(characterIds.fixture),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      updateCharacterProjectDraft({
        characterId: characterIds.fixture,
        expectedVersion: 1,
        actor: { id: actorId, role: "admin" },
        ownerId: null,
        audience: "Fixture data must remain isolated",
        companionNeed: "Fixture data must remain isolated",
        hypothesis: "Fixture data must remain isolated",
        differentiation: "Fixture data must remain isolated",
        targetPlacementKeys: [],
        successCriteria: ["Fixture data remains isolated"],
        productionPackage: "",
        qaPlan: "",
        plannedLaunchAt: null,
        reason: "Prove fixture project mutation is blocked",
        requestId: `${prefix}fixture-project-update`,
      }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      prisma.characterProject.findUniqueOrThrow({
        where: { id: projectIds.fixture },
        select: { version: true },
      }),
    ).resolves.toEqual({ version: 1 });

    const review = await responseData(
      await listReviewQueue(adminRequest(`/api/v1/admin/content/review-queue?search=${prefix}&limit=100`)),
    );
    expect(
      new Set(
        (review.items as Array<{ submissionId: string }>).map((item) => item.submissionId),
      ),
    ).toEqual(new Set([submissionIds.customer, submissionIds.internal]));

    await expect(
      reviewSubmission(
        adminRequest(
          `/api/v1/admin/content/review-queue/${submissionIds.fixture}`,
          "POST",
          {
            decision: "reject",
            reason: "fixture authority must stay isolated",
            confirmation: submissionIds.fixture,
          },
        ),
        submissionIds.fixture,
      ),
    ).rejects.toMatchObject({ status: 404 });

    await expect(
      getContentCharacter(
        adminRequest(`/api/v1/admin/content/characters/${characterIds.fixture}`),
        characterIds.fixture,
      ),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      setCharacterVisibility(
        adminRequest(
          `/api/v1/admin/content/characters/${characterIds.fixture}/visibility`,
          "POST",
          {
            visibility: "unlisted",
            reason: "fixture authority must stay isolated",
            confirmation: `${characterIds.fixture}:visibility:unlisted`,
          },
        ),
        characterIds.fixture,
      ),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("keeps generation and Creative Run list, detail, and commands operational-only", async () => {
    const jobs = await responseData(
      await listGenerationJobsV2(
        adminRequest(`/api/v2/admin/jobs?search=${prefix}&limit=100`),
      ),
    );
    expect(ids(jobs.items)).toEqual(new Set([jobIds.customer, jobIds.internal]));
    await expect(
      getGenerationJobV2(
        adminRequest(`/api/v2/admin/jobs/${jobIds.fixture}`),
        jobIds.fixture,
      ),
    ).rejects.toMatchObject({ status: 404 });

    const runs = await listCreativeRuns({
      requestUrl: `http://localhost/api/v2/admin/creative/runs?search=${prefix}&limit=100`,
      actor: { id: actorId, role: "admin" },
    });
    expect(ids(runs.items)).toEqual(new Set([batchIds.customer, batchIds.internal]));
    await expect(
      getCreativeRunDetail({
        runId: batchIds.fixture,
        actor: { id: actorId, role: "admin" },
      }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("keeps content assets and placements operational-only across list and detail", async () => {
    const assets = await responseData(
      await listContentAssets(
        adminRequest(`/api/v1/admin/content/assets?search=${prefix}&limit=100`),
      ),
    );
    expect(ids(assets.items)).toEqual(new Set([mediaIds.customer, mediaIds.internal]));
    await expect(
      getContentAsset(
        adminRequest(`/api/v1/admin/content/assets/${mediaIds.fixture}`),
        mediaIds.fixture,
      ),
    ).rejects.toMatchObject({ status: 404 });

    const placements = await responseData(
      await listPlacements(
        adminRequest(`/api/v1/admin/content/placements?search=${prefix}&limit=100`),
      ),
    );
    expect(ids(placements.items)).toEqual(
      new Set([placementIds.customer, placementIds.internal]),
    );
    await expect(
      getPlacement(
        adminRequest(`/api/v1/admin/content/placements/${placementIds.fixture}`),
        placementIds.fixture,
      ),
    ).rejects.toMatchObject({ status: 404 });
  });

  function adminRequest(
    path: string,
    method = "GET",
    body?: Record<string, unknown>,
  ) {
    return new Request(`http://localhost${path}`, {
      method,
      headers: {
        "x-idream-user-id": actorId,
        "x-idream-role": "admin",
        ...(method !== "GET"
          ? {
              "content-type": "application/json",
              "idempotency-key": `${prefix}${method.toLowerCase()}-${randomUUID()}`,
            }
          : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  }
});

async function responseData(response: Response) {
  expect(response.status).toBe(200);
  const payload = await response.json() as { data: Record<string, unknown> };
  return payload.data;
}

function ids(value: unknown) {
  return new Set(
    Array.isArray(value)
      ? value.flatMap((item) =>
          item && typeof item === "object" && "id" in item && typeof item.id === "string"
            ? [item.id]
            : item && typeof item === "object" && "characterId" in item && typeof item.characterId === "string"
              ? [item.characterId]
              : [],
        )
      : [],
  );
}
