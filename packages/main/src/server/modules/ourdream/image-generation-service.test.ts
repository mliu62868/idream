import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";
import type { AiFinalizePayload } from "@/server/ai/schemas";
import { drainLocalAiPipeline, reconcileStaleGenerationJobs } from "@/server/ai/local-pipeline";
import { enqueueGenerationAttempt } from "@/server/modules/generation/attempt-dispatch";
import { jobQueue } from "@/server/jobs/queue";
import { prisma } from "@/server/lib/db";
import { referenceSetSnapshotHash } from "@/server/modules/admin-v2/characters/release-snapshot";
import * as generationCatalog from "@/server/modules/admin/generation-catalog";
import {
  api,
  createCharacter,
  createUser,
  dreamcoinBalance,
  expectError,
  expectOk,
  grantCoins,
  publishCharacterForPublicAudience,
  purgeTestData,
  runQueuedGenerationJobs,
} from "@/server/test/helpers";

const P = "zt-imgsvc-";
const SYS = `${P}sys`;
const CHAR = `${P}char`;
const COMPLETE_PERSONA_DETAILS = {
  description: "A grounded companion who notices the details other people miss.",
  relationshipArchetype: "trusted confidante",
  personality: "Perceptive, curious, and quietly protective.",
  tone: "Warm, direct, and lightly teasing.",
  backstory: "You became close after solving a difficult problem together.",
  firstMessage: "There you are. Tell me what happened.",
  exampleDialogue: ["Start with the detail everyone else missed."],
};

function asInputJson(value: AiFinalizePayload): Prisma.InputJsonValue {
  return value as unknown as Prisma.InputJsonValue;
}

type ExactGenerationQuote = {
  profileId: string;
  profileVersion: number;
  routeFingerprint: string;
  pricing: {
    ruleId: string;
    ruleKey: string;
    version: number;
    effectiveFrom: string | null;
    fingerprint: string;
  };
  costs: Array<{
    outputCount: number;
    costDreamcoins: number;
  }>;
};

type ExactGenerationRetryQuote = Omit<
  ExactGenerationQuote,
  "costs"
> & {
  generationJobId: string;
  outputCount: number;
  costDreamcoins: number;
  balance: number;
};

function quoteAuthority(
  quote: ExactGenerationQuote,
  outputCount = 1,
) {
  const exactCost = quote.costs.find(
    (cost) => cost.outputCount === outputCount,
  );
  if (!exactCost) {
    throw new Error(`Quote has no cost for outputCount=${outputCount}`);
  }
  return {
    profileId: quote.profileId,
    profileVersion: quote.profileVersion,
    routeFingerprint: quote.routeFingerprint,
    pricingFingerprint: quote.pricing.fingerprint,
    outputCount,
    costDreamcoins: exactCost.costDreamcoins,
  };
}

function retryQuoteAuthority(quote: ExactGenerationRetryQuote) {
  return {
    profileId: quote.profileId,
    profileVersion: quote.profileVersion,
    routeFingerprint: quote.routeFingerprint,
    pricingFingerprint: quote.pricing.fingerprint,
    outputCount: quote.outputCount,
    costDreamcoins: quote.costDreamcoins,
  };
}

async function createSealedReferenceSet(input: {
  id: string;
  visualProfileId: string;
  revision?: number;
  references: Array<{
    mediaAssetId: string;
    role: string;
    weight: number;
    selectionReason: string;
  }>;
}) {
  const revision = input.revision ?? 1;
  const references = input.references.map((reference, position) => ({
    ...reference,
    position,
  }));
  return prisma.referenceSetRevision.create({
    data: {
      id: input.id,
      visualProfileId: input.visualProfileId,
      revision,
      status: "active",
      selectorVersion: "v1",
      createdFrom: "test",
      snapshotHash: referenceSetSnapshotHash({
        visualProfileId: input.visualProfileId,
        revision,
        selectorVersion: "v1",
        references,
      }),
      references: {
        create: references.map((reference) => ({
          ...reference,
          selectorVersion: "v1",
        })),
      },
    },
    include: { references: true },
  });
}

async function completeCharacterPreview(input: {
  previewJobId: string;
  draftId: string;
  userId: string;
}) {
  const dedupeKey = `character-preview:${input.previewJobId}`;
  const queued = await jobQueue.getByDedupeKey("character.preview", dedupeKey);
  expect(queued?.payload).toMatchObject({
    kind: "character.preview",
    previewJobId: input.previewJobId,
    draftId: input.draftId,
    userId: input.userId,
    model: expect.not.stringContaining("mock"),
  });
  await jobQueue.removeByDedupePrefix(dedupeKey, ["character.preview"]);
  await jobQueue.enqueue({
    queue: "app.ai.finalize",
    payload: asInputJson({
      version: 1,
      kind: "character.preview.completed",
      requestId: `character-preview:${input.previewJobId}`,
      previewJobId: input.previewJobId,
      draftId: input.draftId,
      userId: input.userId,
      provider: "backend",
      model: "redcraft-krea2-comfyui",
      asset: {
        key: `preview/${input.previewJobId}/image-1.webp`,
        width: 832,
        height: 1024,
        contentType: "image/webp",
      },
    }),
    dedupeKey: `character-preview-finalize:${input.previewJobId}:completed`,
  });
  await drainLocalAiPipeline({
    limit: 2,
    queues: ["app.ai.finalize"],
    workerId: `${P}preview-finalizer`,
  });
  await jobQueue.removeByDedupePrefix(
    `character-preview-finalize:${input.previewJobId}:`,
    ["app.ai.finalize"],
  );
}

beforeAll(async () => {
  await purgeTestData(P);
  await prisma.generationModelProfile.create({
    data: {
      id: `${P}compatible-reference-route-v2`,
      profileKey: "chat-image-edit",
      label: "Compatible Character reference test route",
      mode: "image",
      runner: "comfyui",
      pipelineModel: "qwen-image-edit",
      workflowKey: "qwen-image-edit-img2img",
      runnerConfig: {
        workflowVersion: 1,
        capabilities: {
          textToImage: true,
          stableSeed: true,
          referenceImages: true,
          initImage: true,
          lora: false,
        },
      },
      allowedOrientations: ["4:5", "16:9"],
      costMultiplier: 1,
      maxCount: 4,
      version: 2,
      status: "active",
    },
  });
  await createUser({ id: SYS });
  await createCharacter({ id: CHAR, creatorId: SYS, visibility: "public", status: "approved" });
  const assetId = `${P}sys-char-asset`;
  const profileId = `${P}sys-char-profile`;
  const referenceSetId = `${P}sys-char-reference-set`;
  const projectId = `${P}sys-char-project`;
  const releaseId = `${P}sys-char-release`;
  await prisma.mediaAsset.create({
    data: {
      id: assetId,
      ownerId: SYS,
      characterId: CHAR,
      type: "image",
      url: "/images/ourdream/card-sarah-mercer.webp",
      storageKey: `${P}sys-char-asset.webp`,
      visibility: "public_pack",
      safetyStatus: "passed",
      metadata: {
        synthetic: false,
        platformAsset: { status: "active" },
      },
    },
  });
  await prisma.character.update({
    where: { id: CHAR },
    data: { imageAssetId: assetId },
  });
  await prisma.characterVisualProfile.create({
    data: {
      id: profileId,
      characterId: CHAR,
      version: 1,
      status: "active",
      style: "realistic",
      identityPrompt: "Stable official test identity",
      faceTraits: {},
      hairTraits: {},
      bodyTraits: {},
      signatureTraits: {},
      styleTraits: {},
      anchorAssetIds: [assetId],
      referenceAssetIds: [],
      adapterRefs: {},
      createdFrom: "test",
    },
  });
  await createSealedReferenceSet({
    id: referenceSetId,
    visualProfileId: profileId,
    references: [
      {
        mediaAssetId: assetId,
        role: "primary_face",
        weight: 1,
        selectionReason: "primary_identity_anchor",
      },
    ],
  });
  await prisma.characterProject.create({
    data: {
      id: projectId,
      characterId: CHAR,
      ownerId: SYS,
      audience: {},
      successCriteria: [],
      activeKey: `official:${CHAR}`,
    },
  });
  await prisma.characterRelease.create({
    data: {
      id: releaseId,
      projectId,
      revisionId: `${releaseId}:revision`,
      characterContentVersionId: `${releaseId}:content`,
      visualProfileId: profileId,
      visualProfileVersion: 1,
      referenceSetRevisionId: referenceSetId,
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
      snapshotHash: `${releaseId}:snapshot`,
      readiness: "ready",
      legacy: true,
      status: "published",
      publishedAt: new Date(),
    },
  });
  await prisma.publicCatalogQualification.create({
    data: {
      id: `${releaseId}:qualification`,
      releaseId,
      releaseSnapshotHash: `${releaseId}:snapshot`,
      kind: "editorial_import",
      evidence: {
        schemaVersion: "public-catalog-qualification-v1",
        policyVersion: "public-catalog-editorial-import-v1",
        sourceAssetId: assetId,
      },
    },
  });
  await prisma.characterServing.create({
    data: {
      id: `${releaseId}:serving`,
      characterId: CHAR,
      currentReleaseId: releaseId,
      state: "live",
    },
  });
});

afterAll(async () => {
  await purgeTestData(P);
  await prisma.$disconnect();
});

describe("image generation service contract", () => {
  it("keeps implicit no-reference routes on public T2I and skips cheaper inaccessible profiles", async () => {
    const userId = `${P}implicit-route-user`;
    const characterId = `${P}implicit-route-character`;
    const hiddenProfileId = `${P}cheaper-hidden-source-profile`;
    const gatedTextProfileId = `${P}cheaper-gated-text-profile`;
    const gatedReferenceProfileId = `${P}cheaper-gated-reference-profile`;
    const accessibleReferenceProfileId =
      `${P}accessible-reference-profile`;
    await createUser({ id: userId });
    await createCharacter({
      id: characterId,
      creatorId: userId,
      visibility: "private",
      status: "approved",
    });
    await grantCoins(userId, 500, "seed");
    const imageRunnerConfig = {
      workflowVersion: 1,
      capabilities: {
        textToImage: true,
        stableSeed: true,
        referenceImages: true,
        initImage: true,
        lora: false,
      },
    };
    await prisma.generationModelProfile.createMany({
      data: [
        {
          id: hiddenProfileId,
          profileKey: hiddenProfileId,
          label: "Cheaper hidden source-only route",
          mode: "image",
          runner: "comfyui",
          pipelineModel: "qwen-image-edit",
          workflowKey: "qwen-image-edit-img2img",
          runnerConfig: {
            ...imageRunnerConfig,
            capabilities: {
              ...imageRunnerConfig.capabilities,
              referenceImages: false,
            },
          },
          allowedOrientations: ["4:5"],
          costMultiplier: 0.001,
          maxCount: 1,
          status: "active",
          enabled: true,
          rolloutPercent: 100,
          version: 1,
        },
        {
          id: gatedTextProfileId,
          profileKey: gatedTextProfileId,
          label: "Cheaper gated public T2I route",
          mode: "image",
          runner: "comfyui",
          pipelineModel: "redcraft-krea2",
          workflowKey: "redcraft-krea2-txt2img",
          runnerConfig: {
            workflowVersion: 1,
            capabilities: {
              textToImage: true,
              stableSeed: true,
              referenceImages: false,
              initImage: false,
              lora: false,
            },
          },
          allowedOrientations: ["4:5"],
          costMultiplier: 0.002,
          requiredEntitlement: `${P}premium-model-access`,
          maxCount: 1,
          status: "active",
          enabled: true,
          rolloutPercent: 100,
          version: 1,
        },
        {
          id: gatedReferenceProfileId,
          profileKey: gatedReferenceProfileId,
          label: "Cheaper gated Character reference route",
          mode: "image",
          runner: "comfyui",
          pipelineModel: "qwen-image-edit",
          workflowKey: "qwen-image-edit-img2img",
          runnerConfig: imageRunnerConfig,
          allowedOrientations: ["4:5"],
          costMultiplier: 0.003,
          requiredEntitlement: `${P}premium-model-access`,
          maxCount: 1,
          status: "active",
          enabled: true,
          rolloutPercent: 100,
          version: 1,
        },
        {
          id: accessibleReferenceProfileId,
          profileKey: accessibleReferenceProfileId,
          label: "Accessible Character reference route",
          mode: "image",
          runner: "comfyui",
          pipelineModel: "qwen-image-edit",
          workflowKey: "qwen-image-edit-img2img",
          runnerConfig: imageRunnerConfig,
          allowedOrientations: ["4:5"],
          costMultiplier: 0.004,
          maxCount: 1,
          status: "active",
          enabled: true,
          rolloutPercent: 100,
          version: 1,
        },
      ],
    });

    try {
      const freeplayBody = {
        mode: "image" as const,
        freeplay: true,
        outputCount: 1,
      };
      const freeplayQuoteResponse = await api(
        "POST",
        "generation/quote",
        {
          userId,
          ageGate: true,
          body: freeplayBody,
        },
      );
      expectOk(freeplayQuoteResponse);
      const freeplayQuote =
        freeplayQuoteResponse.data.quote as ExactGenerationQuote;
      expect(freeplayQuote.profileId).toBe("profile_image_default_v1");
      const freeplayCreated = await api("POST", "generation/jobs", {
        userId,
        ageGate: true,
        body: {
          ...freeplayBody,
          quoteAuthority: quoteAuthority(freeplayQuote),
        },
      });
      expectOk(freeplayCreated, 202);
      expect(freeplayCreated.data.job.profileId).toBe(
        "profile_image_default_v1",
      );

      const characterBody = {
        mode: "image" as const,
        characterId,
        outputCount: 1,
      };
      const characterQuoteResponse = await api(
        "POST",
        "generation/quote",
        {
          userId,
          ageGate: true,
          body: characterBody,
        },
      );
      expectOk(characterQuoteResponse);
      const characterQuote =
        characterQuoteResponse.data.quote as ExactGenerationQuote;
      expect(characterQuote.profileId).toBe("profile_image_default_v1");
      const characterCreated = await api("POST", "generation/jobs", {
        userId,
        ageGate: true,
        body: {
          ...characterBody,
          quoteAuthority: quoteAuthority(characterQuote),
        },
      });
      expectOk(characterCreated, 202);
      expect(characterCreated.data.job.profileId).toBe(
        "profile_image_default_v1",
      );

      const referenceBody = {
        mode: "image" as const,
        characterId: CHAR,
        outputCount: 1,
      };
      const referenceQuoteResponse = await api(
        "POST",
        "generation/quote",
        {
          userId,
          ageGate: true,
          body: referenceBody,
        },
      );
      expectOk(referenceQuoteResponse);
      const referenceQuote =
        referenceQuoteResponse.data.quote as ExactGenerationQuote;
      expect(referenceQuote.profileId).toBe(
        accessibleReferenceProfileId,
      );
      const referenceCreated = await api("POST", "generation/jobs", {
        userId,
        ageGate: true,
        body: {
          ...referenceBody,
          quoteAuthority: quoteAuthority(referenceQuote),
        },
      });
      expectOk(referenceCreated, 202);
      expect(referenceCreated.data.job.profileId).toBe(
        accessibleReferenceProfileId,
      );
      await runQueuedGenerationJobs(8);
    } finally {
      await prisma.generationModelProfile.deleteMany({
        where: {
          id: {
            in: [
              hiddenProfileId,
              gatedTextProfileId,
              gatedReferenceProfileId,
              accessibleReferenceProfileId,
            ],
          },
        },
      });
    }
  });

  it("quotes from read-only authority and rejects missing, forged, and unaffordable writes before mutations", async () => {
    const userId = `${P}exact-quote-guard-user`;
    const characterId = `${P}exact-quote-guard-character`;
    await createUser({ id: userId });
    await createCharacter({
      id: characterId,
      creatorId: userId,
      visibility: "private",
      status: "approved",
    });
    const body = {
      mode: "image" as const,
      characterId,
      outputCount: 1,
    };
    const balanceBefore = await dreamcoinBalance(userId);

    const quoted = await api("POST", "generation/quote", {
      userId,
      ageGate: true,
      body,
    });
    expectOk(quoted);
    const quote = quoted.data.quote as ExactGenerationQuote;
    expect(quote.costs[0]?.costDreamcoins).toBeGreaterThan(0);
    await expect(
      prisma.characterVisualProfile.count({ where: { characterId } }),
    ).resolves.toBe(0);
    await expect(
      prisma.generationJob.count({ where: { userId } }),
    ).resolves.toBe(0);
    await expect(dreamcoinBalance(userId)).resolves.toBe(balanceBefore);

    const missing = await api("POST", "generation/jobs", {
      userId,
      ageGate: true,
      autoGenerationQuote: false,
      body,
    });
    expectError(missing, 409, "conflict");

    const forgedRoute = await api("POST", "generation/jobs", {
      userId,
      ageGate: true,
      body: {
        ...body,
        quoteAuthority: {
          ...quoteAuthority(quote),
          routeFingerprint: "0".repeat(64),
        },
      },
    });
    expectError(forgedRoute, 409, "conflict");

    const forgedPricing = await api("POST", "generation/jobs", {
      userId,
      ageGate: true,
      body: {
        ...body,
        quoteAuthority: {
          ...quoteAuthority(quote),
          pricingFingerprint: "1".repeat(64),
        },
      },
    });
    expectError(forgedPricing, 409, "conflict");

    const unaffordable = await api("POST", "generation/jobs", {
      userId,
      ageGate: true,
      body: {
        ...body,
        quoteAuthority: quoteAuthority(quote),
      },
    });
    expectError(unaffordable, 402, "payment_required");

    for (const rejected of [missing, forgedRoute, forgedPricing, unaffordable]) {
      expect(rejected.data).toBeUndefined();
    }
    await expect(
      prisma.characterVisualProfile.count({ where: { characterId } }),
    ).resolves.toBe(0);
    await expect(
      prisma.generationJob.count({ where: { userId } }),
    ).resolves.toBe(0);
    await expect(dreamcoinBalance(userId)).resolves.toBe(balanceBefore);
  });

  it("returns quote drift as 409 before current max-count or orientation validation", async () => {
    const userId = `${P}quote-drift-user`;
    await createUser({ id: userId });
    await grantCoins(userId, 1_000, "seed");
    const body = {
      mode: "image" as const,
      freeplay: true,
      outputCount: 1,
    };
    const quoted = await api("POST", "generation/quote", {
      userId,
      ageGate: true,
      body,
    });
    expectOk(quoted);
    const quote = quoted.data.quote as ExactGenerationQuote & {
      maxCount: number;
      orientations: string[];
    };
    expect(quote.maxCount).toBeGreaterThan(1);
    expect(quote.orientations.length).toBeGreaterThan(1);
    const profile = await prisma.generationModelProfile.findFirstOrThrow({
      where: {
        profileKey: quote.profileId,
        version: quote.profileVersion,
        status: "active",
      },
    });
    const originalMaxCount = profile.maxCount;
    const originalOrientations = Array.isArray(profile.allowedOrientations)
      ? profile.allowedOrientations.filter(
          (orientation): orientation is string =>
            typeof orientation === "string",
        )
      : [];
    const balanceBefore = await dreamcoinBalance(userId);

    try {
      await prisma.generationModelProfile.update({
        where: { id: profile.id },
        data: { maxCount: 1 },
      });
      const maxDrift = await api("POST", "generation/jobs", {
        userId,
        ageGate: true,
        body: {
          ...body,
          outputCount: quote.maxCount,
          quoteAuthority: quoteAuthority(quote, quote.maxCount),
        },
      });
      expectError(maxDrift, 409, "conflict");

      await prisma.generationModelProfile.update({
        where: { id: profile.id },
        data: {
          maxCount: originalMaxCount,
          allowedOrientations: [quote.orientations[0]],
        },
      });
      const orientationDrift = await api("POST", "generation/jobs", {
        userId,
        ageGate: true,
        body: {
          ...body,
          controls: { orientation: quote.orientations[1] },
          quoteAuthority: quoteAuthority(quote),
        },
      });
      expectError(orientationDrift, 409, "conflict");
    } finally {
      await prisma.generationModelProfile.update({
        where: { id: profile.id },
        data: {
          maxCount: originalMaxCount,
          allowedOrientations: originalOrientations,
        },
      });
    }

    await expect(
      prisma.generationJob.count({ where: { userId } }),
    ).resolves.toBe(0);
    await expect(dreamcoinBalance(userId)).resolves.toBe(balanceBefore);
  });

  it("quotes and creates the same single-anchor character route, cost, count, and orientation authority", async () => {
    const userId = `${P}single-anchor-quote-user`;
    await createUser({ id: userId });
    await grantCoins(userId, 100, "seed");
    const body = {
      mode: "image" as const,
      characterId: CHAR,
      outputCount: 1,
    };
    const quoted = await api("POST", "generation/quote", {
      userId,
      ageGate: true,
      body,
    });
    expectOk(quoted);
    const quote = quoted.data.quote as ExactGenerationQuote & {
      defaultOrientation: string;
      maxCount: number;
      orientations: string[];
    };
    expect(quote.maxCount).toBeGreaterThan(0);
    expect(quote.orientations).toContain(quote.defaultOrientation);
    expect(quote.costs).toHaveLength(quote.maxCount);
    const balanceBefore = await dreamcoinBalance(userId);

    const created = await api("POST", "generation/jobs", {
      userId,
      ageGate: true,
      body: {
        ...body,
        controls: { orientation: quote.defaultOrientation },
        quoteAuthority: quoteAuthority(quote),
      },
    });
    expectOk(created, 202);
    expect(created.data.job).toMatchObject({
      profileId: quote.profileId,
      profileVersion: quote.profileVersion,
      orientation: quote.defaultOrientation,
      outputCount: 1,
      costDreamcoins: quote.costs[0]?.costDreamcoins,
      controls: {
        generationQuoteAuthority: {
          schemaVersion: "generation-quote-authority-v1",
          profileId: quote.profileId,
          profileVersion: quote.profileVersion,
          routeFingerprint: quote.routeFingerprint,
          pricing: {
            ruleId: quote.pricing.ruleId,
            ruleKey: quote.pricing.ruleKey,
            version: quote.pricing.version,
            effectiveFrom: quote.pricing.effectiveFrom,
            fingerprint: quote.pricing.fingerprint,
          },
          outputCount: 1,
          costDreamcoins: quote.costs[0]?.costDreamcoins,
        },
      },
    });
    await expect(dreamcoinBalance(userId)).resolves.toBe(
      balanceBefore - (quote.costs[0]?.costDreamcoins ?? 0),
    );
    await runQueuedGenerationJobs(4);
  });

  it("quotes failed-job retry without writes, rejects stale authority, and replays a committed retry without revalidation", async () => {
    const userId = `${P}retry-quote-user`;
    const retryKey = `${P}retry-quote-key`;
    await createUser({ id: userId });
    await grantCoins(userId, 200, "seed");
    const generationBody = {
      mode: "image" as const,
      characterId: CHAR,
      outputCount: 1,
    };
    const initialQuoteResponse = await api(
      "POST",
      "generation/quote",
      {
        userId,
        ageGate: true,
        body: generationBody,
      },
    );
    expectOk(initialQuoteResponse);
    const initialQuote =
      initialQuoteResponse.data.quote as ExactGenerationQuote;
    const initial = await api("POST", "generation/jobs", {
      userId,
      ageGate: true,
      body: {
        ...generationBody,
        quoteAuthority: quoteAuthority(initialQuote),
      },
    });
    expectOk(initial, 202);
    const failedJobId = initial.data.job.id as string;
    await jobQueue.removeByDedupePrefix(
      `generation:${failedJobId}`,
      ["ai.image.generate"],
    );
    await prisma.generationJob.update({
      where: { id: failedJobId },
      data: {
        status: "failed",
        errorCode: "retry_quote_fixture",
      },
    });
    const balanceBeforeQuote = await dreamcoinBalance(userId);
    const ledgerBeforeQuote = await prisma.dreamcoinLedger.count({
      where: { userId },
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
    const retryQuote =
      quoted.data.quote as ExactGenerationRetryQuote;
    expect(retryQuote).toMatchObject({
      generationJobId: failedJobId,
      profileId: initial.data.job.profileId,
      profileVersion: initial.data.job.profileVersion,
      outputCount: 1,
    });
    await expect(dreamcoinBalance(userId)).resolves.toBe(
      balanceBeforeQuote,
    );
    await expect(
      prisma.dreamcoinLedger.count({ where: { userId } }),
    ).resolves.toBe(ledgerBeforeQuote);
    await expect(
      prisma.generationJob.count({
        where: { derivedFromJobId: failedJobId },
      }),
    ).resolves.toBe(0);

    const missing = await api(
      "POST",
      `generation/jobs/${failedJobId}/retry`,
      {
        userId,
        ageGate: true,
        autoGenerationQuote: false,
        headers: { "idempotency-key": `${retryKey}-missing` },
        body: {},
      },
    );
    expectError(missing, 409, "conflict");
    const forged = await api(
      "POST",
      `generation/jobs/${failedJobId}/retry`,
      {
        userId,
        ageGate: true,
        headers: { "idempotency-key": `${retryKey}-forged` },
        body: {
          quoteAuthority: {
            ...retryQuoteAuthority(retryQuote),
            routeFingerprint: "0".repeat(64),
          },
        },
      },
    );
    expectError(forged, 409, "conflict");
    const quotedProfile =
      await prisma.generationModelProfile.findFirstOrThrow({
        where: {
          profileKey: retryQuote.profileId,
          version: retryQuote.profileVersion,
        },
      });
    await prisma.generationModelProfile.update({
      where: { id: quotedProfile.id },
      data: {
        costMultiplier: quotedProfile.costMultiplier + 0.25,
      },
    });
    try {
      const stale = await api(
        "POST",
        `generation/jobs/${failedJobId}/retry`,
        {
          userId,
          ageGate: true,
          headers: { "idempotency-key": `${retryKey}-stale` },
          body: {
            quoteAuthority: retryQuoteAuthority(retryQuote),
          },
        },
      );
      expectError(stale, 409, "conflict");
    } finally {
      await prisma.generationModelProfile.update({
        where: { id: quotedProfile.id },
        data: {
          costMultiplier: quotedProfile.costMultiplier,
        },
      });
    }
    await expect(
      prisma.generationJob.count({
        where: { derivedFromJobId: failedJobId },
      }),
    ).resolves.toBe(0);
    await expect(dreamcoinBalance(userId)).resolves.toBe(
      balanceBeforeQuote,
    );

    const retried = await api(
      "POST",
      `generation/jobs/${failedJobId}/retry`,
      {
        userId,
        ageGate: true,
        headers: { "idempotency-key": retryKey },
        body: {
          quoteAuthority: retryQuoteAuthority(retryQuote),
        },
      },
    );
    expectOk(retried, 202);
    expect(retried.data.job).toMatchObject({
      derivedFromJobId: failedJobId,
      profileId: retryQuote.profileId,
      profileVersion: retryQuote.profileVersion,
      costDreamcoins: retryQuote.costDreamcoins,
      controls: {
        generationRetryQuoteAuthority: {
          schemaVersion: "generation-retry-quote-authority-v1",
          generationJobId: failedJobId,
          profileId: retryQuote.profileId,
          profileVersion: retryQuote.profileVersion,
          routeFingerprint: retryQuote.routeFingerprint,
          pricing: {
            ruleId: retryQuote.pricing.ruleId,
            ruleKey: retryQuote.pricing.ruleKey,
            version: retryQuote.pricing.version,
            effectiveFrom: retryQuote.pricing.effectiveFrom,
            fingerprint: retryQuote.pricing.fingerprint,
          },
          outputCount: retryQuote.outputCount,
          costDreamcoins: retryQuote.costDreamcoins,
        },
      },
    });
    await expect(dreamcoinBalance(userId)).resolves.toBe(
      balanceBeforeQuote - retryQuote.costDreamcoins,
    );

    const profile = quotedProfile;
    await prisma.generationModelProfile.update({
      where: { id: profile.id },
      data: { enabled: false },
    });
    try {
      const replay = await api(
        "POST",
        `generation/jobs/${failedJobId}/retry`,
        {
          userId,
          ageGate: true,
          autoGenerationQuote: false,
          headers: { "idempotency-key": retryKey },
          body: {},
        },
      );
      expectOk(replay, 202);
      expect(replay.data.job.id).toBe(retried.data.job.id);
    } finally {
      await prisma.generationModelProfile.update({
        where: { id: profile.id },
        data: { enabled: true },
      });
    }
    await expect(
      prisma.generationJob.count({
        where: { derivedFromJobId: failedJobId },
      }),
    ).resolves.toBe(1);
    await expect(dreamcoinBalance(userId)).resolves.toBe(
      balanceBeforeQuote - retryQuote.costDreamcoins,
    );
    await runQueuedGenerationJobs(4);
  });

  it("queues a live legacy editorial Character without inventing identity authority", async () => {
    const userId = `${P}legacy-editorial-user`;
    const characterId = `${P}legacy-editorial-character`;
    await createUser({ id: userId });
    await createCharacter({
      id: characterId,
      name: "Legacy Editorial Muse",
      source: "official",
      visibility: "public",
      status: "approved",
    });
    const published = await publishCharacterForPublicAudience({
      characterId,
      ownerId: SYS,
    });
    await grantCoins(userId, 100, "seed");

    const response = await api("POST", "generation/jobs", {
      userId,
      ageGate: true,
      body: { mode: "image", characterId, outputCount: 1 },
    });
    expectOk(response, 202);

    const job = await prisma.generationJob.findUniqueOrThrow({
      where: { id: response.data.job.id as string },
    });
    expect(job).toMatchObject({
      characterId,
      visualProfileId: null,
      visualProfileVersion: null,
      referenceSetRevisionId: null,
      referenceManifest: null,
      profileId: "profile_image_default_v1",
      model: "redcraft-krea2-txt2img",
      recipeId: "template_image_character_default",
      status: "queued",
    });
    expect(job.controls).toMatchObject({
      legacyReleaseAuthority: {
        schemaVersion: "legacy-character-generation-authority-v1",
        characterId,
        releaseId: published.releaseId,
        releaseSnapshotHash: `${published.releaseId}-snapshot`,
        qualificationId: `${published.releaseId}-qualification`,
        qualificationKind: "editorial_import",
        qualificationPolicyVersion: "public-catalog-editorial-import-v1",
      },
    });
    expect(job.prompt).toContain("Legacy Editorial Muse");
    expect(
      await prisma.characterVisualProfile.count({ where: { characterId } }),
    ).toBe(0);
    await expect(
      prisma.characterServing.findUniqueOrThrow({ where: { characterId } }),
    ).resolves.toMatchObject({
      currentReleaseId: published.releaseId,
      state: "live",
    });

    await runQueuedGenerationJobs(8);
  });

  it("keeps a live legacy Release authoritative over an unpinned active profile", async () => {
    const userId = `${P}legacy-profile-coexist-user`;
    const characterId = `${P}legacy-profile-coexist-character`;
    const profileId = `${P}legacy-profile-coexist-profile`;
    await createUser({ id: userId });
    await createCharacter({
      id: characterId,
      creatorId: userId,
      name: "Legacy Coexist Muse",
      source: "official",
      visibility: "public",
      status: "approved",
    });
    const published = await publishCharacterForPublicAudience({
      characterId,
      ownerId: SYS,
    });
    await prisma.characterVisualProfile.create({
      data: {
        id: profileId,
        characterId,
        version: 1,
        status: "active",
        style: "realistic",
        identityPrompt: "Unreleased staged identity",
        faceTraits: {},
        hairTraits: {},
        bodyTraits: {},
        signatureTraits: {},
        styleTraits: {},
        anchorAssetIds: [],
        referenceAssetIds: [],
        adapterRefs: {},
        createdFrom: "test",
      },
    });
    await grantCoins(userId, 100, "seed");

    const response = await api("POST", "generation/jobs", {
      userId,
      ageGate: true,
      body: { mode: "image", characterId, outputCount: 1 },
    });
    expectOk(response, 202);
    await expect(
      prisma.generationJob.findUniqueOrThrow({
        where: { id: response.data.job.id as string },
      }),
    ).resolves.toMatchObject({
      visualProfileId: null,
      visualProfileVersion: null,
      controls: {
        legacyReleaseAuthority: {
          releaseId: published.releaseId,
          releaseSnapshotHash: `${published.releaseId}-snapshot`,
        },
      },
    });
    await expect(
      prisma.characterVisualProfile.findMany({
        where: { characterId },
        select: { id: true, status: true },
      }),
    ).resolves.toEqual([{ id: profileId, status: "active" }]);

    await runQueuedGenerationJobs(8);
  });

  it("replays a committed legacy retry but fails new retry and dispatch after serving switches authority", async () => {
    const userId = `${P}legacy-switch-user`;
    const characterId = `${P}legacy-switch-character`;
    const profileId = `${P}legacy-switch-profile`;
    const modernReleaseId = `${P}legacy-switch-modern-release`;
    const modernSnapshotHash = `${modernReleaseId}-snapshot`;
    const validationRunId = `${modernReleaseId}-validation`;
    await createUser({ id: userId });
    await createCharacter({
      id: characterId,
      creatorId: userId,
      name: "Legacy Switch Muse",
      source: "official",
      visibility: "public",
      status: "approved",
    });
    const published = await publishCharacterForPublicAudience({
      characterId,
      ownerId: SYS,
    });
    await grantCoins(userId, 100, "seed");

    const created = await api("POST", "generation/jobs", {
      userId,
      ageGate: true,
      body: { mode: "image", characterId, outputCount: 1 },
    });
    expectOk(created, 202);
    const generationJobId = created.data.job.id as string;
    await jobQueue.removeByDedupePrefix(
      `generation:${generationJobId}`,
      ["ai.image.generate"],
    );
    await prisma.generationJob.update({
      where: { id: generationJobId },
      data: { status: "failed", errorCode: "legacy-switch-fixture" },
    });

    const retryKey = `${P}legacy-switch-retry`;
    const firstRetry = await api(
      "POST",
      `generation/jobs/${generationJobId}/retry`,
      {
        userId,
        ageGate: true,
        headers: { "idempotency-key": retryKey },
      },
    );
    expectOk(firstRetry, 202);
    const retryJobId = firstRetry.data.job.id as string;
    await jobQueue.removeByDedupePrefix(
      `generation:${retryJobId}`,
      ["ai.image.generate"],
    );

    await prisma.$transaction(async (tx) => {
      await tx.characterVisualProfile.create({
        data: {
          id: profileId,
          characterId,
          version: 1,
          status: "active",
          style: "realistic",
          identityPrompt: "Replacement strict identity",
          faceTraits: {},
          hairTraits: {},
          bodyTraits: {},
          signatureTraits: {},
          styleTraits: {},
          anchorAssetIds: [],
          referenceAssetIds: [],
          adapterRefs: {},
          createdFrom: "test",
        },
      });
      await tx.characterRelease.create({
        data: {
          id: modernReleaseId,
          projectId: published.projectId,
          revisionId: `${modernReleaseId}-revision`,
          characterContentVersionId: `${modernReleaseId}-content`,
          visualProfileId: profileId,
          visualProfileVersion: 1,
          generationProvenance: {
            schemaVersion: "character-release-generation-provenance-v2",
            policyVersion: "character-release-policy-v2",
            requiredReleaseRoute: {
              visualProfileId: profileId,
              visualProfileVersion: 1,
            },
          },
          releasePlacementManifest: {
            schemaVersion: 2,
            placements: [],
          },
          snapshotHash: modernSnapshotHash,
          readiness: "ready",
          legacy: false,
          status: "published",
          publishedAt: new Date(),
        },
      });
      await tx.releaseValidationRun.create({
        data: {
          id: validationRunId,
          releaseId: modernReleaseId,
          snapshotHash: modernSnapshotHash,
          policyVersion: "character-release-policy-v2",
          result: "passed",
          finishedAt: new Date(),
        },
      });
      await tx.publicCatalogQualification.create({
        data: {
          id: `${modernReleaseId}-qualification`,
          releaseId: modernReleaseId,
          releaseSnapshotHash: modernSnapshotHash,
          kind: "generated_release",
          validationRunId,
          evidence: {
            schemaVersion: "public-catalog-qualification-v1",
            policyVersion: "character-release-policy-v2",
          },
        },
      });
      await tx.characterRelease.update({
        where: { id: published.releaseId },
        data: { status: "superseded" },
      });
      await tx.characterServing.update({
        where: { characterId },
        data: { currentReleaseId: modernReleaseId },
      });
    });

    const balanceBeforeReplay = await dreamcoinBalance(userId);
    const replay = await api(
      "POST",
      `generation/jobs/${generationJobId}/retry`,
      {
        userId,
        ageGate: true,
        autoGenerationQuote: false,
        headers: { "idempotency-key": retryKey },
      },
    );
    expectOk(replay, 202);
    expect(replay.data.job.id).toBe(retryJobId);
    await expect(dreamcoinBalance(userId)).resolves.toBe(
      balanceBeforeReplay,
    );

    const newRetry = await api(
      "POST",
      `generation/jobs/${generationJobId}/retry`,
      {
        userId,
        ageGate: true,
        headers: {
          "idempotency-key": `${P}legacy-switch-second-retry`,
        },
      },
    );
    expectError(newRetry, 409, "conflict");

    const attemptCount = await prisma.generationAttempt.count({
      where: { requestId: generationJobId },
    });
    const originalJob = await prisma.generationJob.findUniqueOrThrow({
      where: { id: generationJobId },
    });
    await expect(
      enqueueGenerationAttempt(originalJob),
    ).rejects.toMatchObject({
      status: 409,
      details: {
        generationJobId,
        characterId,
        pinnedReleaseId: published.releaseId,
        currentReleaseId: null,
      },
    });
    await expect(
      prisma.generationAttempt.count({
        where: { requestId: generationJobId },
      }),
    ).resolves.toBe(attemptCount);
    await expect(
      jobQueue.getByDedupeKey(
        "ai.image.generate",
        `generation:${generationJobId}`,
      ),
    ).resolves.toBeNull();
  });

  it("creates an active visual profile from the character preview anchor on draft submit", async () => {
    const userId = `${P}create-identity-user`;
    await createUser({ id: userId });

    const draftResponse = await api("POST", "character-drafts", {
      userId,
      ageGate: true,
      body: {
        gender: "female",
        style: "realistic",
        name: "Lyra Sol",
      },
    });
    expectOk(draftResponse);
    const draftId = draftResponse.data.draft.id as string;

    const patchResponse = await api("PATCH", `character-drafts/${draftId}`, {
      userId,
      ageGate: true,
      body: {
        appearance: { face: { eyes: "hazel" }, hair: { color: "auburn", style: "long waves" } },
        body: { build: "athletic" },
        advancedDetails: {
          ...COMPLETE_PERSONA_DETAILS,
          signature: { freckles: true },
        },
      },
    });
    expectOk(patchResponse);

    const previewResponse = await api("POST", `character-drafts/${draftId}/preview`, {
      userId,
      ageGate: true,
    });
    expectOk(previewResponse);
    await completeCharacterPreview({
      previewJobId: previewResponse.data.previewJob.id as string,
      draftId,
      userId,
    });
    const selectedPreview = await api("POST", `character-drafts/${draftId}/preview-anchor`, {
      userId,
      ageGate: true,
      body: { previewJobId: previewResponse.data.previewJob.id },
    });
    expectOk(selectedPreview);

    const submitResponse = await api("POST", `character-drafts/${draftId}/submit`, {
      userId,
      ageGate: true,
      body: {
        visibility: "private",
        description: "A grounded companion with auburn waves and hazel eyes.",
        age: 25,
      },
    });
    expectOk(submitResponse);
    const characterId = submitResponse.data.character.id as string;
    const character = await prisma.character.findUniqueOrThrow({ where: { id: characterId } });
    const visualProfile = await prisma.characterVisualProfile.findFirstOrThrow({
      where: { characterId, status: "active" },
    });

    expect(visualProfile.version).toBe(1);
    expect(visualProfile.createdFrom).toBe("create_preview");
    expect(visualProfile.identityPrompt).toContain("Lyra Sol");
    expect(visualProfile.identityPrompt).toContain("hazel");
    expect(visualProfile.anchorAssetIds).toEqual([character.imageAssetId]);
    expect(character.imageAssetId).toBeTruthy();
    await expect(
      prisma.referenceSetRevision.findFirst({
        where: {
          visualProfileId: visualProfile.id,
          status: "active",
        },
        include: { references: true },
      }),
    ).resolves.toMatchObject({
      createdFrom: "create_preview",
      references: [
        {
          mediaAssetId: character.imageAssetId,
          position: 0,
          role: "primary_face",
        },
      ],
    });
  });

  it("atomically rejects draft submission when the selected preview was already claimed by another Character", async () => {
    const userId = `${P}claimed-preview-user`;
    const existingCharacterId = `${P}claimed-preview-character`;
    const assetId = `${P}claimed-preview-asset`;
    await createUser({ id: userId });
    await createCharacter({
      id: existingCharacterId,
      creatorId: userId,
      source: "user",
      visibility: "private",
      status: "approved",
    });
    await prisma.mediaAsset.create({
      data: {
        id: assetId,
        ownerId: userId,
        characterId: existingCharacterId,
        type: "image",
        url: `/user-content/${assetId}/content.webp`,
        visibility: "private",
        safetyStatus: "passed",
        metadata: {},
      },
    });
    await prisma.character.update({
      where: { id: existingCharacterId },
      data: { imageAssetId: assetId },
    });

    const draftResponse = await api("POST", "character-drafts", {
      userId,
      ageGate: true,
      body: {
        gender: "female",
        style: "realistic",
        name: "No Reparent",
      },
    });
    expectOk(draftResponse);
    const draftId = draftResponse.data.draft.id as string;
    const completedPersona = await api("PATCH", `character-drafts/${draftId}`, {
      userId,
      ageGate: true,
      body: { advancedDetails: COMPLETE_PERSONA_DETAILS },
    });
    expectOk(completedPersona);
    const preview = await prisma.characterPreviewJob.create({
      data: {
        draftId,
        status: "completed",
        provider: "backend",
        resultAssetId: assetId,
        completedAt: new Date(),
      },
    });
    const selected = await api("POST", `character-drafts/${draftId}/preview-anchor`, {
      userId,
      ageGate: true,
      body: { previewJobId: preview.id },
    });
    expectOk(selected);

    const before = {
      characters: await prisma.character.count({ where: { creatorId: userId } }),
      profiles: await prisma.characterVisualProfile.count({
        where: { character: { creatorId: userId } },
      }),
      submissions: await prisma.characterSubmission.count({
        where: { character: { creatorId: userId } },
      }),
    };
    const submitted = await api("POST", `character-drafts/${draftId}/submit`, {
      userId,
      ageGate: true,
      body: {
        visibility: "private",
        description: "This submission must not steal another Character image.",
        age: 25,
      },
    });
    expectError(submitted, 409, "conflict");
    await expect(
      prisma.mediaAsset.findUniqueOrThrow({ where: { id: assetId } }),
    ).resolves.toMatchObject({ characterId: existingCharacterId });
    await expect(
      prisma.character.count({ where: { creatorId: userId } }),
    ).resolves.toBe(before.characters);
    await expect(
      prisma.characterVisualProfile.count({
        where: { character: { creatorId: userId } },
      }),
    ).resolves.toBe(before.profiles);
    await expect(
      prisma.characterSubmission.count({
        where: { character: { creatorId: userId } },
      }),
    ).resolves.toBe(before.submissions);
  });

  it("never promotes a synthetic preview into a character identity authority", async () => {
    const userId = `${P}synthetic-preview-user`;
    await createUser({ id: userId });
    const draftResponse = await api("POST", "character-drafts", {
      userId,
      ageGate: true,
      body: {
        gender: "female",
        style: "realistic",
        name: "Synthetic Demo",
      },
    });
    expectOk(draftResponse);
    const draftId = draftResponse.data.draft.id as string;
    const assetId = `${P}synthetic-preview-asset`;
    await prisma.mediaAsset.create({
      data: {
        id: assetId,
        ownerId: userId,
        type: "image",
        url: "/user-content/synthetic/content.png",
        visibility: "private",
        safetyStatus: "passed",
        metadata: { source: "character_preview", synthetic: true },
      },
    });
    const preview = await prisma.characterPreviewJob.create({
      data: {
        draftId,
        status: "completed",
        provider: "mock",
        resultAssetId: assetId,
        completedAt: new Date(),
      },
    });

    const select = await api("POST", `character-drafts/${draftId}/preview-anchor`, {
      userId,
      ageGate: true,
      body: { previewJobId: preview.id },
    });
    expectError(select, 400, "bad_request");

    await prisma.characterDraft.update({
      where: { id: draftId },
      data: { previewJobId: preview.id },
    });
    const submit = await api("POST", `character-drafts/${draftId}/submit`, {
      userId,
      ageGate: true,
      body: {
        visibility: "private",
        description: "Must not publish a demo identity.",
        age: 25,
      },
    });
    expectError(submit, 400, "bad_request");
    expect(await prisma.character.count({
      where: { creatorId: userId },
    })).toBe(0);
  });

  it("uses the selected preview candidate as the visual identity anchor", async () => {
    const userId = `${P}selected-preview-user`;
    await createUser({ id: userId });

    const draftResponse = await api("POST", "character-drafts", {
      userId,
      ageGate: true,
      body: {
        gender: "female",
        style: "realistic",
        name: "Mara Lune",
      },
    });
    expectOk(draftResponse);
    const draftId = draftResponse.data.draft.id as string;
    await api("PATCH", `character-drafts/${draftId}`, {
      userId,
      ageGate: true,
      body: {
        appearance: { face: { eyes: "blue" }, hair: { color: "black" } },
        body: { build: "soft athletic" },
        advancedDetails: {
          ...COMPLETE_PERSONA_DETAILS,
          signature: "silver necklace",
        },
      },
    });

    const firstAssetId = `${P}selected-preview-asset-1`;
    const secondAssetId = `${P}selected-preview-asset-2`;
    const firstStorageKey = `${P}selected-preview-asset-1.webp`;
    const secondStorageKey = `${P}selected-preview-asset-2.webp`;
    await prisma.mediaAsset.createMany({
      data: [
        {
          id: firstAssetId,
          ownerId: userId,
          type: "image",
          url: "/images/ourdream/card-sarah-mercer.webp",
          thumbnailUrl: "/images/ourdream/card-sarah-mercer.webp",
          storageKey: firstStorageKey,
          visibility: "private",
          safetyStatus: "passed",
          metadata: {
            providerKey: firstStorageKey,
            synthetic: false,
          },
        },
        {
          id: secondAssetId,
          ownerId: userId,
          type: "image",
          url: "/images/ourdream/card-sophie.webp",
          thumbnailUrl: "/images/ourdream/card-sophie.webp",
          storageKey: secondStorageKey,
          visibility: "private",
          safetyStatus: "passed",
          metadata: {
            providerKey: secondStorageKey,
            synthetic: false,
          },
        },
      ],
    });
    const firstPreview = await prisma.characterPreviewJob.create({
      data: {
        draftId,
        status: "completed",
        provider: "mock",
        resultAssetId: firstAssetId,
        completedAt: new Date(Date.now() - 5_000),
      },
    });
    await prisma.characterPreviewJob.create({
      data: {
        draftId,
        status: "completed",
        provider: "mock",
        resultAssetId: secondAssetId,
        completedAt: new Date(),
      },
    });

    const selected = await api("POST", `character-drafts/${draftId}/preview-anchor`, {
      userId,
      ageGate: true,
      body: { previewJobId: firstPreview.id },
    });
    expectOk(selected);

    const submitResponse = await api("POST", `character-drafts/${draftId}/submit`, {
      userId,
      ageGate: true,
      body: {
        visibility: "private",
        description: "A grounded companion with blue eyes and a silver necklace.",
        age: 26,
      },
    });
    expectOk(submitResponse);
    const characterId = submitResponse.data.character.id as string;
    const character = await prisma.character.findUniqueOrThrow({ where: { id: characterId } });
    const visualProfile = await prisma.characterVisualProfile.findFirstOrThrow({
      where: { characterId, status: "active" },
    });

    expect(character.imageAssetId).toBe(firstAssetId);
    expect(visualProfile.anchorAssetIds).toEqual([firstAssetId]);
  });

  it("requires a bounded Idempotency-Key before reserving a generation write", async () => {
    const userId = `${P}missing-idem-user`;
    await createUser({ id: userId });
    await grantCoins(userId, 100, "seed");

    const missing = await api("POST", "generation/jobs", {
      userId,
      ageGate: true,
      autoGenerationIdempotencyKey: false,
      body: { mode: "image", characterId: CHAR, outputCount: 1 },
    });
    expectError(missing, 400, "bad_request");
    expect(missing.error?.message).toContain("Idempotency-Key");

    const oversized = await api("POST", "generation/jobs", {
      userId,
      ageGate: true,
      autoGenerationIdempotencyKey: false,
      headers: { "Idempotency-Key": "x".repeat(161) },
      body: { mode: "image", characterId: CHAR, outputCount: 1 },
    });
    expectError(oversized, 400, "bad_request");
    expect(oversized.error?.message).toContain("between 8 and 160");
    await expect(
      prisma.generationJob.count({ where: { userId } }),
    ).resolves.toBe(0);
    await expect(dreamcoinBalance(userId)).resolves.toBe(100);
  });

  it("dedupes POST by Idempotency-Key, binds its request, and does not double reserve", async () => {
    const userId = `${P}idem-user`;
    await createUser({ id: userId });
    await grantCoins(userId, 100, "seed");
    const quoted = await api("POST", "generation/quote", {
      userId,
      ageGate: true,
      body: { mode: "image", characterId: CHAR, outputCount: 1 },
    });
    expectOk(quoted);
    const quote = quoted.data.quote as ExactGenerationQuote;
    const generationBody = {
      mode: "image" as const,
      characterId: CHAR,
      outputCount: 1,
      quoteAuthority: quoteAuthority(quote),
    };

    const first = await api("POST", "generation/jobs", {
      userId,
      ageGate: true,
      headers: { "Idempotency-Key": `${P}idem-key` },
      body: generationBody,
    });
    const second = await api("POST", "generation/jobs", {
      userId,
      ageGate: true,
      headers: { "Idempotency-Key": `${P}idem-key` },
      body: {
        ...generationBody,
        quoteAuthority: {
          ...generationBody.quoteAuthority,
          pricingFingerprint: "f".repeat(64),
        },
      },
    });

    expectOk(first, 202);
    expectOk(second, 202);
    expect(second.data.job.id).toBe(first.data.job.id);

    const conflicting = await api("POST", "generation/jobs", {
      userId,
      ageGate: true,
      headers: { "Idempotency-Key": `${P}idem-key` },
      body: { mode: "image", characterId: CHAR, outputCount: 2 },
    });
    expectError(conflicting, 409, "conflict");
    expect(conflicting.error?.message).toContain(
      "different generation request",
    );
    expect(await prisma.generationJob.count({ where: { userId } })).toBe(1);
    expect(await dreamcoinBalance(userId)).toBe(95);
    await runQueuedGenerationJobs(8);
  });

  it("enforces the per-user active job limit before reserve", async () => {
    const userId = `${P}limit-user`;
    await createUser({ id: userId });
    await grantCoins(userId, 100, "seed");
    const previous = process.env.MAX_INFLIGHT_JOBS_PER_USER;
    process.env.MAX_INFLIGHT_JOBS_PER_USER = "1";
    try {
      const first = await api("POST", "generation/jobs", {
        userId,
        ageGate: true,
        body: { mode: "image", characterId: CHAR, outputCount: 1 },
      });
      expectOk(first, 202);

      const second = await api("POST", "generation/jobs", {
        userId,
        ageGate: true,
        body: { mode: "image", characterId: CHAR, outputCount: 1 },
      });
      expectError(second, 429, "rate_limited");
      expect(await prisma.generationJob.count({ where: { userId } })).toBe(1);
      expect(await dreamcoinBalance(userId)).toBe(95);
      await runQueuedGenerationJobs(8);
    } finally {
      if (previous === undefined) delete process.env.MAX_INFLIGHT_JOBS_PER_USER;
      else process.env.MAX_INFLIGHT_JOBS_PER_USER = previous;
    }
  });

  it("reconciles stale non-terminal jobs to failed and refunds idempotently", async () => {
    const userId = `${P}stale-user`;
    await createUser({ id: userId });
    await grantCoins(userId, 100, "seed");

    const gen = await api("POST", "generation/jobs", {
      userId,
      ageGate: true,
      body: { mode: "image", characterId: CHAR, outputCount: 1 },
    });
    expectOk(gen, 202);
    const jobId = gen.data.job.id as string;
    await prisma.generationJob.update({
      where: { id: jobId },
      data: { updatedAt: new Date("2026-01-01T00:00:00.000Z") },
    });

    const reconciled = await reconcileStaleGenerationJobs({
      now: new Date("2026-01-01T00:20:00.000Z"),
      timeoutMs: 60_000,
    });
    expect(reconciled.enqueued).toBeGreaterThanOrEqual(1);
    await runQueuedGenerationJobs(4);
    await runQueuedGenerationJobs(4);

    const poll = await api("GET", `generation/jobs/${jobId}`, { userId, ageGate: true });
    expectOk(poll);
    expect(poll.data.job.status).toBe("failed");
    expect(poll.data.job.completedAt).toBeNull();
    expect(poll.data.job.errorCode).toBe("stale_timeout");
    expect(await dreamcoinBalance(userId)).toBe(100);
  });

  it("removes pending generate work when a job is finalized as failed", async () => {
    const userId = `${P}failed-cleanup-user`;
    await createUser({ id: userId });
    await grantCoins(userId, 100, "seed");

    const gen = await api("POST", "generation/jobs", {
      userId,
      ageGate: true,
      body: { mode: "image", characterId: CHAR, outputCount: 1 },
    });
    expectOk(gen, 202);
    const jobId = gen.data.job.id as string;
    expect(await jobQueue.getByDedupeKey("ai.image.generate", `generation:${jobId}`)).not.toBeNull();

    await jobQueue.enqueue({
      queue: "app.ai.finalize",
      payload: asInputJson({
        version: 1,
        kind: "generation.failed",
        requestId: `${P}failed-cleanup`,
        generationJobId: jobId,
        mode: "image",
        error: {
          code: "worker_interrupted",
          message: "Worker interrupted",
          retryable: false,
        },
      }),
      dedupeKey: `generation-finalize:${jobId}:failed`,
    });

    await drainLocalAiPipeline({
      queues: ["app.ai.finalize"],
      limit: 2,
      workerId: `${P}failed-cleanup-finalizer`,
    });

    const poll = await api("GET", `generation/jobs/${jobId}`, { userId, ageGate: true });
    expectOk(poll);
    expect(poll.data.job.status).toBe("failed");
    expect(poll.data.job.completedAt).toBeNull();
    expect(await dreamcoinBalance(userId)).toBe(100);
    expect(await jobQueue.getByDedupeKey("ai.image.generate", `generation:${jobId}`)).toBeNull();
    const attempt = await prisma.generationAttempt.findFirstOrThrow({ where: { requestId: jobId } });
    expect(attempt).toMatchObject({ status: "failed", terminalSequence: expect.any(Number) });
    expect(await prisma.generationAttemptEvent.findMany({
      where: { attemptId: attempt.id, terminalScope: "terminal" },
    })).toEqual([
      expect.objectContaining({ outcome: "failed", eventType: "generation.attempt.failed.v1" }),
    ]);
  });

  it("lets the owner download private synthetic output without making it public", async () => {
    const userId = `${P}ttl-user`;
    const mediaId = `${P}media-ttl`;
    await createUser({ id: userId });
    await prisma.mediaAsset.create({
      data: {
        id: mediaId,
        ownerId: userId,
        type: "image",
        url: "/images/ourdream/card-sarah-mercer.webp",
        thumbnailUrl: "/images/ourdream/card-sarah-mercer.webp",
        storageKey: `${P}private/image.webp`,
        contentType: "image/webp",
        visibility: "private",
        safetyStatus: "passed",
        metadata: { synthetic: true, source: "mock" },
      },
    });

    const download = await api("GET", `media/${mediaId}/download`, { userId, ageGate: true });
    expectOk(download);
    const token = Buffer.from(mediaId, "utf8").toString("base64url");
    expect(download.data.url).toBe(`/user-content/${token}/content.webp?download=1`);
    expect(download.headers.get("cache-control")).toBe(
      "private, no-store, max-age=0",
    );
    expect(download.headers.get("vary")).toContain("Cookie");
    expect(download.headers.get("vary")).toContain("Authorization");

    const unauthorized = await api("GET", `media/${mediaId}/content`, {
      ageGate: true,
    });
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get("cache-control")).toBe(
      "private, no-store, max-age=0",
    );
    expect(unauthorized.headers.get("vary")).toContain("Cookie");
    expect(unauthorized.headers.get("vary")).toContain("Authorization");
  });

  it("summarizes partial success refunds in the job cost response", async () => {
    const userId = `${P}partial-user`;
    await createUser({ id: userId });
    await grantCoins(userId, 100, "seed");

    const gen = await api("POST", "generation/jobs", {
      userId,
      ageGate: true,
      body: { mode: "image", characterId: CHAR, outputCount: 2 },
    });
    expectOk(gen, 202);
    const jobId = gen.data.job.id as string;
    await jobQueue.removeByDedupePrefix(`generation:${jobId}`, ["ai.image.generate"]);
    await jobQueue.enqueue({
      queue: "app.ai.finalize",
      payload: asInputJson({
        version: 1,
        kind: "generation.completed",
        requestId: `${P}partial-request`,
        generationJobId: jobId,
        mode: "image",
        assets: [
          {
            key: `${P}partial/${jobId}/0.webp`,
            contentType: "image/webp",
            width: 1024,
            height: 1280,
          },
        ],
        usage: { gpuSeconds: 1.2, model: "mock-image" },
      }),
      dedupeKey: `generation-finalize:${jobId}:completed`,
    });

    await runQueuedGenerationJobs(4);
    const poll = await api("GET", `generation/jobs/${jobId}`, { userId, ageGate: true });
    expectOk(poll);
    expect(poll.data.job.status).toBe("completed");
    expect(poll.data.cost).toMatchObject({
      charged: 10,
      refunded: 5,
      finalCharge: 5,
      assetCount: 1,
      requestedCount: 2,
      missingOutputs: 1,
    });
    expect(await dreamcoinBalance(userId)).toBe(95);
  });

  it("persists dimension-level quality evidence without inventing identity scores", async () => {
    const userId = `${P}quality-user`;
    await createUser({ id: userId });
    await grantCoins(userId, 100, "seed");
    const gen = await api("POST", "generation/jobs", {
      userId,
      ageGate: true,
      body: { mode: "image", characterId: CHAR, outputCount: 1 },
    });
    expectOk(gen, 202);
    const jobId = gen.data.job.id as string;
    await jobQueue.removeByDedupePrefix(`generation:${jobId}`, ["ai.image.generate"]);

    await jobQueue.enqueue({
      queue: "app.ai.finalize",
      payload: asInputJson({
        version: 1,
        kind: "generation.completed",
        requestId: `${P}quality-request`,
        generationJobId: jobId,
        mode: "image",
        assets: [
          {
            key: `${P}quality/${jobId}/0.webp`,
            contentType: "image/webp",
            width: 1024,
            height: 1280,
            quality: {
              schemaVersion: "1",
              evaluatorVersion: "sanity-v1",
              artifact: { status: "passed" },
              faceCount: { status: "unscored", reason: "evaluator_unavailable" },
              identity: { status: "unscored", reason: "evaluator_unavailable" },
              intent: { status: "unscored", reason: "evaluator_unavailable" },
            },
          },
        ],
        usage: { gpuSeconds: 1.2, model: "mock-image" },
      }),
      dedupeKey: `generation-finalize:${jobId}:completed`,
    });
    await drainLocalAiPipeline({ queues: ["app.ai.finalize"], limit: 2 });

    const poll = await api("GET", `generation/jobs/${jobId}`, { userId, ageGate: true });
    expectOk(poll);
    expect(poll.data.assets[0].quality).toMatchObject({
      artifact: { status: "passed" },
      identity: { status: "unscored", reason: "evaluator_unavailable" },
    });
    expect(poll.data.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "image_quality_scored" }),
      ]),
    );
  });

  it("folds selected built-in and public community presets into the generation prompt", async () => {
    const userId = `${P}preset-user`;
    await createUser({ id: userId });
    await grantCoins(userId, 100, "seed");
    const modePreset = await prisma.generationPreset.create({
      data: {
        scope: "built_in",
        type: "mode",
        label: "Realistic",
        controls: { style: "realistic", rendering: "cinematic realism" },
        visibility: "public",
        status: "active",
      },
    });
    const preset = await prisma.generationPreset.create({
      data: {
        scope: "built_in",
        type: "background",
        label: "Bedroom",
        controls: { background: "bedroom", lighting: "soft" },
        visibility: "public",
        status: "active",
      },
    });
    const communityPreset = await prisma.generationPreset.create({
      data: {
        scope: "community",
        type: "outfit",
        label: "Evening Glam",
        controls: { outfit: "evening glam", accessories: "silver jewelry" },
        visibility: "public",
        status: "active",
      },
    });

    const gen = await api("POST", "generation/jobs", {
      userId,
      ageGate: true,
      body: {
        mode: "image",
        characterId: CHAR,
        outputCount: 1,
        controls: {
          modePresetId: modePreset.id,
          backgroundPresetId: preset.id,
          outfitPresetId: communityPreset.id,
        },
      },
    });
    expectOk(gen, 202);
    const job = await prisma.generationJob.findUniqueOrThrow({
      where: { id: gen.data.job.id as string },
    });
    expect(job.prompt).toContain("realistic");
    expect(job.prompt).toContain("cinematic realism");
    expect(job.prompt).toContain("bedroom");
    expect(job.prompt).toContain("soft");
    expect(job.prompt).toContain("evening glam");
    expect(job.prompt).toContain("silver jewelry");
    await runQueuedGenerationJobs(4);
  });

  it("ignores preset ids that are not built-in or owned by the user", async () => {
    const owner = `${P}preset-owner`;
    const intruder = `${P}preset-intruder`;
    await createUser({ id: owner });
    await createUser({ id: intruder });
    await grantCoins(intruder, 100, "seed");
    const privatePreset = await prisma.generationPreset.create({
      data: {
        ownerId: owner,
        scope: "user",
        type: "outfit",
        label: "Secret",
        controls: { outfit: "secret-couture" },
        visibility: "private",
        status: "active",
      },
    });

    const gen = await api("POST", "generation/jobs", {
      userId: intruder,
      ageGate: true,
      body: {
        mode: "image",
        characterId: CHAR,
        outputCount: 1,
        controls: { outfitPresetId: privatePreset.id },
      },
    });
    expectOk(gen, 202);
    const job = await prisma.generationJob.findUniqueOrThrow({
      where: { id: gen.data.job.id as string },
    });
    expect(job.prompt).not.toContain("secret-couture");
    await runQueuedGenerationJobs(4);
  });

  it("locks character image jobs to the active visual profile and records identity metadata", async () => {
    const userId = `${P}identity-user`;
    const characterId = `${P}identity-char`;
    const modelKey = `${P}reference-capable-model`;
    await createUser({ id: userId });
    await createCharacter({
      id: characterId,
      creatorId: userId,
      name: "Iris Vale",
      description: "A calm companion with silver hair and amber eyes.",
      visibility: "private",
      status: "approved",
    });
    await prisma.generationModelProfile.create({
      data: {
        id: `${P}reference-capable-profile`,
        profileKey: modelKey,
        label: "Reference-capable identity model",
        mode: "image",
        runner: "comfyui",
        pipelineModel: "qwen-image-edit",
        workflowKey: "qwen-image-edit-multi-identity",
        runnerConfig: {
          workflowVersion: 1,
          capabilities: {
            textToImage: true,
            stableSeed: true,
            referenceImages: true,
            initImage: true,
            lora: false,
          },
        },
        allowedOrientations: ["4:5"],
        defaultWidth: 768,
        defaultHeight: 1024,
        version: 1,
        status: "active",
      },
    });
    await prisma.mediaAsset.createMany({
      data: [
        {
          id: `${P}anchor-1`,
          ownerId: userId,
          characterId,
          type: "image",
          url: "/user-content/test-anchor/content.webp",
          thumbnailUrl: "/user-content/test-anchor/content.webp",
          storageKey: `${P}identity/anchor-1.webp`,
          contentType: "image/webp",
          width: 1024,
          height: 1280,
          visibility: "private",
          safetyStatus: "passed",
          metadata: {},
        },
        {
          id: `${P}ref-1`,
          ownerId: userId,
          characterId,
          type: "image",
          url: "/user-content/test-ref/content.webp",
          thumbnailUrl: "/user-content/test-ref/content.webp",
          storageKey: `${P}identity/ref-1.webp`,
          contentType: "image/webp",
          width: 1024,
          height: 1280,
          visibility: "private",
          safetyStatus: "passed",
          metadata: {},
        },
      ],
    });
    await prisma.characterVisualProfile.create({
      data: {
        id: `${P}cvp-1`,
        characterId,
        version: 3,
        status: "active",
        style: "realistic",
        identityPrompt: "Iris Vale, adult woman, silver bob haircut, amber eyes, heart-shaped face",
        negativeIdentityPrompt: "black hair, blue eyes, different face",
        faceTraits: { eyes: "amber", face: "heart-shaped" },
        hairTraits: { color: "silver", cut: "bob" },
        bodyTraits: {},
        signatureTraits: {},
        styleTraits: { style: "realistic" },
        anchorAssetIds: [`${P}anchor-1`],
        referenceAssetIds: [`${P}ref-1`],
        defaultSeed: `${P}identity-seed`,
        adapterRefs: {},
        createdFrom: "test",
      },
    });
    await createSealedReferenceSet({
      id: `${P}cvp-1-reference-set`,
      visualProfileId: `${P}cvp-1`,
      references: [
        {
          mediaAssetId: `${P}anchor-1`,
          role: "primary_face",
          weight: 1,
          selectionReason: "primary_identity_anchor",
        },
        {
          mediaAssetId: `${P}ref-1`,
          role: "identity_reference",
          weight: 0.75,
          selectionReason: "supporting_identity_reference",
        },
      ],
    });
    await grantCoins(userId, 100, "seed");

    const gen = await api("POST", "generation/jobs", {
      userId,
      ageGate: true,
      body: {
        mode: "image",
        characterId,
        outputCount: 1,
        consistencyMode: "strict",
      },
    });
    expectOk(gen, 202);
    const job = await prisma.generationJob.findUniqueOrThrow({
      where: { id: gen.data.job.id as string },
    });
    expect(job.visualProfileId).toBe(`${P}cvp-1`);
    expect(job.visualProfileVersion).toBe(3);
    expect(job.consistencyMode).toBe("strict");
    expect(job.seed).toBe(`${P}identity-seed`);
    expect(job.referenceAssetIds).toEqual([`${P}anchor-1`, `${P}ref-1`]);
    expect(job.prompt).toContain("Locked identity");
    expect(job.prompt).toContain("silver bob haircut");
    expect(job.prompt).toContain("Identity consistency: strict");
    expect(job.negativePrompt).toContain("different face");
    expect(job.negativePrompt).toContain("black hair");
    expect(job.controls).toMatchObject({
      consistencyMode: "strict",
      visualIdentity: {
        visualProfileId: `${P}cvp-1`,
        visualProfileVersion: 3,
        consistencyMode: "strict",
        seed: `${P}identity-seed`,
      },
    });
    const queued = await jobQueue.getByDedupeKey("ai.image.generate", `generation:${job.id}`);
    const queuedPayload = queued?.payload as { referenceImages?: unknown[] } | undefined;
    expect(queuedPayload?.referenceImages).toEqual([
      expect.objectContaining({
        assetId: `${P}anchor-1`,
        role: "identity_anchor",
        storageKey: `${P}identity/anchor-1.webp`,
        weight: 1.25,
      }),
      expect.objectContaining({
        assetId: `${P}ref-1`,
        role: "identity_reference",
        storageKey: `${P}identity/ref-1.webp`,
        weight: 0.95,
      }),
    ]);
    await runQueuedGenerationJobs(4);
  });

  it("fails closed when the current profile cannot consume its pinned Character references", async () => {
    const userId = `${P}text-identity-user`;
    const characterId = `${P}text-identity-char`;
    const modelKey = `${P}text-only-model`;
    await createUser({ id: userId });
    await createCharacter({
      id: characterId,
      creatorId: userId,
      name: "Selene Ward",
      description: "A composed companion with ash-blonde waves and gray eyes.",
      visibility: "private",
      status: "approved",
    });
    await prisma.generationModelProfile.create({
      data: {
        id: `${P}text-only-profile`,
        profileKey: modelKey,
        label: "Text-only identity model",
        mode: "image",
        runner: "pipeline",
        pipelineModel: "mock-image",
        runnerConfig: {
          capabilities: {
            textToImage: true,
            stableSeed: true,
            referenceImages: false,
            initImage: false,
            lora: false,
          },
        },
        allowedOrientations: ["4:5"],
        defaultWidth: 768,
        defaultHeight: 1024,
        version: 1,
        status: "active",
      },
    });
    await prisma.mediaAsset.createMany({
      data: [
        {
          id: `${P}text-anchor`,
          ownerId: userId,
          characterId,
          type: "image",
          url: "/user-content/text-identity/anchor.webp",
          thumbnailUrl: "/user-content/text-identity/anchor.webp",
          storageKey: `${P}text-identity/anchor.webp`,
          contentType: "image/webp",
          width: 1024,
          height: 1280,
          visibility: "private",
          safetyStatus: "passed",
          metadata: {},
        },
        {
          id: `${P}text-ref`,
          ownerId: userId,
          characterId,
          type: "image",
          url: "/user-content/text-identity/ref.webp",
          thumbnailUrl: "/user-content/text-identity/ref.webp",
          storageKey: `${P}text-identity/ref.webp`,
          contentType: "image/webp",
          width: 1024,
          height: 1280,
          visibility: "private",
          safetyStatus: "passed",
          metadata: {},
        },
      ],
    });
    await prisma.characterVisualProfile.create({
      data: {
        id: `${P}text-cvp`,
        characterId,
        version: 1,
        status: "active",
        style: "realistic",
        identityPrompt: "Selene Ward, adult woman, ash-blonde waves, gray eyes, straight nose",
        negativeIdentityPrompt: "brown eyes, short black hair, different face",
        faceTraits: { eyes: "gray", nose: "straight" },
        hairTraits: { color: "ash-blonde", texture: "waves" },
        bodyTraits: {},
        signatureTraits: {},
        styleTraits: { style: "realistic" },
        anchorAssetIds: [`${P}text-anchor`],
        referenceAssetIds: [`${P}text-ref`],
        defaultSeed: `${P}text-seed`,
        adapterRefs: {},
        createdFrom: "test",
      },
    });
    await createSealedReferenceSet({
      id: `${P}text-reference-set`,
      visualProfileId: `${P}text-cvp`,
      references: [
        {
          mediaAssetId: `${P}text-anchor`,
          role: "primary_face",
          weight: 1,
          selectionReason: "primary_identity_anchor",
        },
        {
          mediaAssetId: `${P}text-ref`,
          role: "identity_reference",
          weight: 0.75,
          selectionReason: "supporting_identity_reference",
        },
      ],
    });
    await grantCoins(userId, 100, "seed");

    const gen = await api("POST", "generation/jobs", {
      userId,
      ageGate: true,
      body: {
        mode: "image",
        characterId,
        model: modelKey,
        outputCount: 1,
        consistencyMode: "strict",
      },
    });
    expectError(gen, 409, "conflict");
    await expect(prisma.generationJob.count({
      where: { userId, characterId },
    })).resolves.toBe(0);
    await expect(dreamcoinBalance(userId)).resolves.toBe(100);
  });

  it("keeps chat image scene prompts separate from the character visual identity", async () => {
    const userId = `${P}chat-identity-user`;
    const characterId = `${P}chat-identity-char`;
    const anchorId = `${P}chat-identity-anchor`;
    await createUser({ id: userId });
    await createCharacter({
      id: characterId,
      creatorId: userId,
      name: "Mira Dawn",
      description: "A warm companion with copper curls.",
      visibility: "private",
      status: "approved",
    });
    await prisma.mediaAsset.create({
      data: {
        id: anchorId,
        ownerId: userId,
        characterId,
        type: "image",
        url: "/images/ourdream/card-sarah-mercer.webp",
        storageKey: `${P}chat-identity-anchor.webp`,
        visibility: "private",
        safetyStatus: "passed",
        metadata: {},
      },
    });
    await prisma.characterVisualProfile.create({
      data: {
        id: `${P}chat-cvp`,
        characterId,
        version: 1,
        status: "active",
        style: "realistic",
        identityPrompt: "Mira Dawn, adult woman, copper curly hair, green eyes, soft freckles",
        negativeIdentityPrompt: "straight black hair, different face",
        faceTraits: { eyes: "green", freckles: true },
        hairTraits: { color: "copper", texture: "curly" },
        bodyTraits: {},
        signatureTraits: { freckles: true },
        styleTraits: { style: "realistic" },
        anchorAssetIds: [anchorId],
        referenceAssetIds: [],
        defaultSeed: `${P}chat-seed`,
        adapterRefs: {},
        createdFrom: "test",
      },
    });
    await createSealedReferenceSet({
      id: `${P}chat-reference-set`,
      visualProfileId: `${P}chat-cvp`,
      references: [
        {
          mediaAssetId: anchorId,
          role: "primary_face",
          weight: 1,
          selectionReason: "primary_identity_anchor",
        },
      ],
    });
    await grantCoins(userId, 100, "seed");

    const job = await import("@/server/modules/ourdream/service").then((mod) =>
      mod.createChatImageGenerationJob({
        version: 1,
        kind: "chat.image.requested",
        requestId: `${P}chat-req`,
        attachmentId: `${P}attachment`,
        sessionId: `${P}session`,
        messageId: `${P}message`,
        userId,
        characterId,
        promptHint: "sitting beside a rain-streaked window, soft evening light",
        conversationContext: "The user asked for a quiet photo from the current scene.",
        controls: { orientation: "4:5", outputCount: 1 },
      }),
    );

    const stored = await prisma.generationJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(stored.sourceType).toBe("chat_image");
    expect(stored.visualProfileId).toBe(`${P}chat-cvp`);
    expect(stored.prompt).toContain("Locked identity");
    expect(stored.prompt).toContain("copper curly hair");
    expect(stored.prompt).toContain("rain-streaked window");
    expect(stored.prompt).not.toContain("Recent chat context");
    expect(stored.controls).toMatchObject({
      consistencyMode: "balanced",
      visualIdentity: {
        visualProfileId: `${P}chat-cvp`,
        visualProfileVersion: 1,
      },
    });
    await runQueuedGenerationJobs(4);
  });

  it("sets owned generated media as the display avatar without bootstrapping identity", async () => {
    const userId = `${P}promote-user`;
    const characterId = `${P}promote-char`;
    const mediaId = `${P}promote-media`;
    await createUser({ id: userId });
    await createCharacter({
      id: characterId,
      creatorId: userId,
      name: "Nora Vale",
      description: "A thoughtful companion with dark curls.",
      visibility: "private",
      status: "approved",
    });
    await prisma.mediaAsset.create({
      data: {
        id: mediaId,
        ownerId: userId,
        type: "image",
        url: "/images/ourdream/card-sarah-mercer.webp",
        thumbnailUrl: "/images/ourdream/card-sarah-mercer.webp",
        visibility: "private",
        safetyStatus: "passed",
        metadata: {},
      },
    });

    const promoted = await api("POST", `media/${mediaId}/use-as-character-image`, {
      userId,
      ageGate: true,
      body: { characterId },
    });
    expectOk(promoted);

    const character = await prisma.character.findUniqueOrThrow({ where: { id: characterId } });
    const media = await prisma.mediaAsset.findUniqueOrThrow({ where: { id: mediaId } });
    expect(character.imageAssetId).toBe(mediaId);
    expect(await prisma.characterVisualProfile.count({ where: { characterId } })).toBe(0);
    expect(await prisma.referenceSetRevision.count({
      where: { visualProfile: { characterId } },
    })).toBe(0);
    expect(media.characterId).toBe(characterId);
    expect(media.metadata).toMatchObject({
      quality: {
        selectedAsCharacterImage: true,
      },
    });
  });

  it("never reparents an asset that already belongs to another Character", async () => {
    const userId = `${P}cross-character-user`;
    const sourceCharacterId = `${P}cross-character-source`;
    const targetCharacterId = `${P}cross-character-target`;
    const sourceAssetId = `${P}cross-character-source-asset`;
    const targetAnchorId = `${P}cross-character-target-anchor`;
    const sourceProfileId = `${P}cross-character-source-profile`;
    const targetProfileId = `${P}cross-character-target-profile`;
    const sourceProjectId = `${P}cross-character-source-project`;
    const sourceReleaseId = `${P}cross-character-source-release`;
    await createUser({ id: userId });
    await createCharacter({
      id: sourceCharacterId,
      creatorId: userId,
      visibility: "private",
      status: "approved",
    });
    await createCharacter({
      id: targetCharacterId,
      creatorId: userId,
      visibility: "private",
      status: "approved",
    });
    await prisma.mediaAsset.createMany({
      data: [
        {
          id: sourceAssetId,
          ownerId: userId,
          characterId: sourceCharacterId,
          type: "image",
          url: "/images/ourdream/card-sarah-mercer.webp",
          visibility: "private",
          safetyStatus: "passed",
          metadata: {},
        },
        {
          id: targetAnchorId,
          ownerId: userId,
          characterId: targetCharacterId,
          type: "image",
          url: "/images/ourdream/card-sophie.webp",
          visibility: "private",
          safetyStatus: "passed",
          metadata: {},
        },
      ],
    });
    await prisma.character.update({
      where: { id: sourceCharacterId },
      data: { imageAssetId: sourceAssetId },
    });
    await prisma.characterVisualProfile.createMany({
      data: [
        {
          id: sourceProfileId,
          characterId: sourceCharacterId,
          version: 1,
          status: "active",
          style: "realistic",
          identityPrompt: "Source identity",
          faceTraits: {},
          hairTraits: {},
          bodyTraits: {},
          signatureTraits: {},
          styleTraits: {},
          anchorAssetIds: [sourceAssetId],
          referenceAssetIds: [],
          adapterRefs: {},
          createdFrom: "test",
        },
        {
          id: targetProfileId,
          characterId: targetCharacterId,
          version: 1,
          status: "active",
          style: "realistic",
          identityPrompt: "Target identity",
          faceTraits: {},
          hairTraits: {},
          bodyTraits: {},
          signatureTraits: {},
          styleTraits: {},
          anchorAssetIds: [targetAnchorId],
          referenceAssetIds: [],
          adapterRefs: {},
          createdFrom: "test",
        },
      ],
    });
    const sourceReferenceSet = await createSealedReferenceSet({
      id: `${P}cross-character-source-reference-set`,
      visualProfileId: sourceProfileId,
      references: [{
        mediaAssetId: sourceAssetId,
        role: "primary_face",
        weight: 1,
        selectionReason: "source_anchor",
      }],
    });
    const targetReferenceSet = await createSealedReferenceSet({
      id: `${P}cross-character-target-reference-set`,
      visualProfileId: targetProfileId,
      references: [{
        mediaAssetId: targetAnchorId,
        role: "primary_face",
        weight: 1,
        selectionReason: "target_anchor",
      }],
    });
    await prisma.characterProject.create({
      data: {
        id: sourceProjectId,
        characterId: sourceCharacterId,
        ownerId: userId,
        audience: {},
        successCriteria: [],
        draftImageAssetId: sourceAssetId,
        draftAssetPack: {
          character_cover: { assetId: sourceAssetId },
        },
        activeKey: `user:${sourceCharacterId}`,
      },
    });
    await prisma.characterRelease.create({
      data: {
        id: sourceReleaseId,
        projectId: sourceProjectId,
        revisionId: `${sourceReleaseId}:revision`,
        characterContentVersionId: `${sourceReleaseId}:content`,
        visualProfileId: sourceProfileId,
        visualProfileVersion: 1,
        referenceSetRevisionId: sourceReferenceSet.id,
        generationProvenance: {},
        releasePlacementManifest: {
          placements: [{ slotKey: "character_avatar", assetId: sourceAssetId }],
        },
        snapshotHash: `${sourceReleaseId}:snapshot`,
        status: "approved",
      },
    });

    const displayAttempt = await api(
      "POST",
      `media/${sourceAssetId}/use-as-character-image`,
      {
        userId,
        ageGate: true,
        body: { characterId: targetCharacterId },
      },
    );
    expectError(displayAttempt, 409, "conflict");
    const identityAttempt = await api(
      "POST",
      `media/${sourceAssetId}/add-to-identity`,
      {
        userId,
        ageGate: true,
        body: { characterId: targetCharacterId },
      },
    );
    expectError(identityAttempt, 409, "conflict");
    const createLookAttempt = await api(
      "POST",
      `characters/${targetCharacterId}/looks`,
      {
        userId,
        ageGate: true,
        body: {
          label: "Stolen source look",
          appearanceDelta: { outfit: "black jacket" },
          referenceAssetId: sourceAssetId,
        },
      },
    );
    expectError(createLookAttempt, 409, "conflict");
    const targetLook = await api(
      "POST",
      `characters/${targetCharacterId}/looks`,
      {
        userId,
        ageGate: true,
        body: {
          label: "Target-owned look",
          appearanceDelta: { outfit: "blue jacket" },
        },
      },
    );
    expectOk(targetLook, 201);
    const updateLookAttempt = await api(
      "PATCH",
      `characters/${targetCharacterId}/looks/${targetLook.data.look.id as string}`,
      {
        userId,
        ageGate: true,
        body: { referenceAssetId: sourceAssetId },
      },
    );
    expectError(updateLookAttempt, 409, "conflict");

    await expect(
      prisma.mediaAsset.findUniqueOrThrow({ where: { id: sourceAssetId } }),
    ).resolves.toMatchObject({ characterId: sourceCharacterId });
    await expect(
      prisma.character.findUniqueOrThrow({ where: { id: sourceCharacterId } }),
    ).resolves.toMatchObject({ imageAssetId: sourceAssetId });
    await expect(
      prisma.character.findUniqueOrThrow({ where: { id: targetCharacterId } }),
    ).resolves.toMatchObject({ imageAssetId: null });
    await expect(
      prisma.characterProject.findUniqueOrThrow({ where: { id: sourceProjectId } }),
    ).resolves.toMatchObject({
      draftImageAssetId: sourceAssetId,
      draftAssetPack: { character_cover: { assetId: sourceAssetId } },
    });
    await expect(
      prisma.referenceSetRevision.findUniqueOrThrow({
        where: { id: sourceReferenceSet.id },
        include: { references: true },
      }),
    ).resolves.toMatchObject({
      status: "active",
      references: [expect.objectContaining({ mediaAssetId: sourceAssetId })],
    });
    await expect(
      prisma.referenceSetRevision.findUniqueOrThrow({
        where: { id: targetReferenceSet.id },
        include: { references: true },
      }),
    ).resolves.toMatchObject({
      status: "active",
      references: [expect.objectContaining({ mediaAssetId: targetAnchorId })],
    });
    await expect(
      prisma.characterRelease.findUniqueOrThrow({ where: { id: sourceReleaseId } }),
    ).resolves.toMatchObject({
      status: "approved",
      releasePlacementManifest: {
        placements: [
          expect.objectContaining({ assetId: sourceAssetId }),
        ],
      },
    });
    await expect(
      prisma.characterLook.findUniqueOrThrow({
        where: { id: targetLook.data.look.id as string },
      }),
    ).resolves.toMatchObject({
      characterId: targetCharacterId,
      referenceAssetId: null,
      status: "active",
    });
  });

  it("serializes concurrent display-avatar changes without invalidating identity-bound drafts", async () => {
    const userId = `${P}promote-race-user`;
    const characterId = `${P}promote-race-char`;
    const firstMediaId = `${P}promote-race-media-a`;
    const secondMediaId = `${P}promote-race-media-b`;
    const staleDraftId = `${P}promote-race-stale-draft`;
    const projectId = `${P}promote-race-project`;
    await createUser({ id: userId });
    await createCharacter({
      id: characterId,
      creatorId: userId,
      visibility: "private",
      status: "approved",
    });
    await prisma.mediaAsset.createMany({
      data: [
        {
          id: firstMediaId,
          ownerId: userId,
          type: "image",
          url: "/images/ourdream/card-sarah-mercer.webp",
          visibility: "private",
          safetyStatus: "passed",
          metadata: {},
        },
        {
          id: secondMediaId,
          ownerId: userId,
          type: "image",
          url: "/images/ourdream/card-sophie.webp",
          visibility: "private",
          safetyStatus: "passed",
          metadata: {},
        },
        {
          id: staleDraftId,
          ownerId: userId,
          characterId,
          type: "image",
          url: "/images/ourdream/card-emily.webp",
          visibility: "private",
          safetyStatus: "passed",
          metadata: {},
        },
      ],
    });
    await prisma.characterProject.create({
      data: {
        id: projectId,
        characterId,
        ownerId: userId,
        audience: {},
        successCriteria: [],
        draftImageAssetId: staleDraftId,
        draftAssetPack: {
          character_cover: { assetId: staleDraftId },
        },
        activeKey: `user:${characterId}`,
      },
    });

    const [first, second] = await Promise.all([
      api("POST", `media/${firstMediaId}/use-as-character-image`, {
        userId,
        ageGate: true,
        body: { characterId },
      }),
      api("POST", `media/${secondMediaId}/use-as-character-image`, {
        userId,
        ageGate: true,
        body: { characterId },
      }),
    ]);
    expectOk(first);
    expectOk(second);

    const [character, project, activeProfiles, activeReferenceSets] = await Promise.all([
      prisma.character.findUniqueOrThrow({ where: { id: characterId } }),
      prisma.characterProject.findUniqueOrThrow({ where: { id: projectId } }),
      prisma.characterVisualProfile.findMany({
        where: { characterId, status: "active" },
      }),
      prisma.referenceSetRevision.findMany({
        where: {
          visualProfile: { characterId },
          status: "active",
        },
        include: { references: true },
      }),
    ]);
    expect([firstMediaId, secondMediaId]).toContain(character.imageAssetId);
    expect(project).toMatchObject({
      version: 1,
      draftImageAssetId: staleDraftId,
      draftAssetPack: {
        character_cover: { assetId: staleDraftId },
      },
    });
    expect(activeProfiles).toHaveLength(0);
    expect(activeReferenceSets).toHaveLength(0);
  });

  it("blocks character identity version changes behind an active Release, then invalidates drafts atomically", async () => {
    const userId = `${P}character-update-authority-user`;
    const characterId = `${P}character-update-authority-char`;
    const anchorId = `${P}character-update-authority-anchor`;
    const referenceId = `${P}character-update-authority-reference`;
    const staleDraftId = `${P}character-update-authority-draft`;
    const profileId = `${P}character-update-authority-profile`;
    const projectId = `${P}character-update-authority-project`;
    const releaseId = `${P}character-update-authority-release`;
    await createUser({ id: userId });
    await createCharacter({
      id: characterId,
      creatorId: userId,
      name: "Before update",
      visibility: "private",
      status: "approved",
    });
    await prisma.mediaAsset.createMany({
      data: [
        {
          id: anchorId,
          ownerId: userId,
          characterId,
          type: "image",
          url: "/images/ourdream/card-sarah-mercer.webp",
          storageKey: `${P}character-update-authority-anchor.webp`,
          visibility: "private",
          safetyStatus: "passed",
          metadata: {},
        },
        {
          id: staleDraftId,
          ownerId: userId,
          characterId,
          type: "image",
          url: "/images/ourdream/card-sophie.webp",
          storageKey: `${P}character-update-authority-draft.webp`,
          visibility: "private",
          safetyStatus: "passed",
          metadata: {},
        },
        {
          id: referenceId,
          ownerId: userId,
          characterId,
          type: "image",
          url: "/images/ourdream/card-emily.webp",
          storageKey: `${P}character-update-authority-reference.webp`,
          visibility: "private",
          safetyStatus: "passed",
          metadata: {},
        },
      ],
    });
    await prisma.character.update({
      where: { id: characterId },
      data: { imageAssetId: anchorId },
    });
    await prisma.characterVisualProfile.create({
      data: {
        id: profileId,
        characterId,
        version: 1,
        status: "active",
        style: "realistic",
        identityPrompt: "stable identity",
        faceTraits: {},
        hairTraits: {},
        bodyTraits: {},
        signatureTraits: {},
        styleTraits: {},
        anchorAssetIds: [anchorId],
        referenceAssetIds: [],
        adapterRefs: {},
        createdFrom: "test",
      },
    });
    await createSealedReferenceSet({
      id: `${P}character-update-authority-reference-set`,
      visualProfileId: profileId,
      references: [
        {
          mediaAssetId: anchorId,
          role: "primary_face",
          weight: 1,
          selectionReason: "primary_identity_anchor",
        },
        {
          mediaAssetId: referenceId,
          role: "identity_reference",
          weight: 0.75,
          selectionReason: "gallery_identity_reference",
        },
      ],
    });
    await prisma.characterProject.create({
      data: {
        id: projectId,
        characterId,
        ownerId: userId,
        audience: {},
        successCriteria: [],
        draftImageAssetId: staleDraftId,
        draftAssetPack: {
          character_hero: { assetId: staleDraftId },
        },
        activeKey: `user:${characterId}`,
      },
    });
    await prisma.characterRelease.create({
      data: {
        id: releaseId,
        projectId,
        revisionId: `${releaseId}-revision`,
        characterContentVersionId: `${releaseId}-content`,
        visualProfileId: profileId,
        visualProfileVersion: 1,
        generationProvenance: {},
        releasePlacementManifest: {},
        snapshotHash: `${releaseId}-snapshot`,
        status: "approved",
      },
    });

    const blockedDisplayImage = await api(
      "POST",
      `media/${referenceId}/use-as-character-image`,
      {
        userId,
        ageGate: true,
        body: { characterId },
      },
    );
    expectError(blockedDisplayImage, 409, "conflict");
    await expect(
      prisma.character.findUniqueOrThrow({ where: { id: characterId } }),
    ).resolves.toMatchObject({ imageAssetId: anchorId });

    const blocked = await api("PATCH", `characters/${characterId}`, {
      userId,
      ageGate: true,
      body: { name: "Must not commit" },
    });
    expectError(blocked, 409, "conflict");
    await expect(
      prisma.character.findUniqueOrThrow({ where: { id: characterId } }),
    ).resolves.toMatchObject({ name: "Before update" });
    await expect(
      prisma.characterProject.findUniqueOrThrow({ where: { id: projectId } }),
    ).resolves.toMatchObject({ version: 1, draftImageAssetId: staleDraftId });

    await prisma.characterRelease.delete({ where: { id: releaseId } });
    const updated = await api("PATCH", `characters/${characterId}`, {
      userId,
      ageGate: true,
      body: { name: "After update" },
    });
    expectOk(updated);

    const [project, profiles] = await Promise.all([
      prisma.characterProject.findUniqueOrThrow({ where: { id: projectId } }),
      prisma.characterVisualProfile.findMany({
        where: { characterId },
        orderBy: { version: "asc" },
      }),
    ]);
    expect(project).toMatchObject({
      version: 2,
      draftImageAssetId: null,
      draftAssetPack: {},
    });
    expect(profiles).toHaveLength(2);
    expect(profiles.map((profile) => [profile.version, profile.status])).toEqual([
      [1, "archived"],
      [2, "active"],
    ]);
    expect(profiles[1]).toMatchObject({
      anchorAssetIds: [anchorId],
      referenceAssetIds: [referenceId],
    });
    const nextReferenceSet = await prisma.referenceSetRevision.findFirstOrThrow({
      where: { visualProfileId: profiles[1]?.id, status: "active" },
      include: { references: { orderBy: { position: "asc" } } },
    });
    expect(nextReferenceSet.references.map((reference) => reference.mediaAssetId)).toEqual([
      anchorId,
      referenceId,
    ]);
  });

  it("never promotes synthetic gallery media into character identity authority", async () => {
    const userId = `${P}synthetic-gallery-user`;
    const characterId = `${P}synthetic-gallery-char`;
    const mediaId = `${P}synthetic-gallery-media`;
    await createUser({ id: userId });
    await createCharacter({
      id: characterId,
      creatorId: userId,
      visibility: "private",
      status: "approved",
    });
    await prisma.mediaAsset.create({
      data: {
        id: mediaId,
        ownerId: userId,
        characterId,
        type: "image",
        url: `/user-content/${mediaId}/content.webp`,
        visibility: "private",
        safetyStatus: "passed",
        metadata: { synthetic: true, source: "mock" },
      },
    });

    const characterImage = await api("POST", `media/${mediaId}/use-as-character-image`, {
      userId,
      ageGate: true,
      body: { characterId },
    });
    expectError(characterImage, 400, "bad_request");

    const identityReference = await api("POST", `media/${mediaId}/add-to-identity`, {
      userId,
      ageGate: true,
      body: { characterId },
    });
    expectError(identityReference, 400, "bad_request");

    const look = await api("POST", `media/${mediaId}/save-as-look`, {
      userId,
      ageGate: true,
      body: {
        label: "Synthetic look",
        appearanceDelta: { outfit: "red dress" },
      },
    });
    expectError(look, 400, "bad_request");

    await expect(
      prisma.character.findUniqueOrThrow({ where: { id: characterId } }),
    ).resolves.toMatchObject({ imageAssetId: null });
    await expect(
      prisma.characterVisualProfile.count({ where: { characterId } }),
    ).resolves.toBe(0);
    await expect(
      prisma.characterLook.count({ where: { characterId } }),
    ).resolves.toBe(0);
  });

  it("rejects unsafe or non-operational media at display, identity, and public visibility boundaries", async () => {
    const userId = `${P}unsafe-authority-user`;
    const characterId = `${P}unsafe-authority-char`;
    const blockedAssetId = `${P}unsafe-authority-blocked`;
    const archivedAssetId = `${P}unsafe-authority-archived`;
    await createUser({ id: userId });
    await createCharacter({
      id: characterId,
      creatorId: userId,
      visibility: "private",
      status: "approved",
    });
    await prisma.mediaAsset.createMany({
      data: [
        {
          id: blockedAssetId,
          ownerId: userId,
          characterId,
          type: "image",
          url: "/images/ourdream/card-sarah-mercer.webp",
          visibility: "private",
          safetyStatus: "blocked",
          metadata: {},
        },
        {
          id: archivedAssetId,
          ownerId: userId,
          characterId,
          type: "image",
          url: "/images/ourdream/card-sophie.webp",
          visibility: "private",
          safetyStatus: "passed",
          metadata: { platformAsset: { status: "archived" } },
        },
      ],
    });

    for (const mediaAssetId of [blockedAssetId, archivedAssetId]) {
      const display = await api(
        "POST",
        `media/${mediaAssetId}/use-as-character-image`,
        {
          userId,
          ageGate: true,
          body: { characterId },
        },
      );
      expectError(display, 409, "conflict");
      const identity = await api(
        "POST",
        `media/${mediaAssetId}/add-to-identity`,
        {
          userId,
          ageGate: true,
          body: { characterId },
        },
      );
      expectError(identity, 409, "conflict");
    }

    await prisma.character.update({
      where: { id: characterId },
      data: { imageAssetId: blockedAssetId },
    });
    const unsafePublish = await api("PATCH", `characters/${characterId}`, {
      userId,
      ageGate: true,
      body: { visibility: "public" },
    });
    expectError(unsafePublish, 400, "bad_request");
    await prisma.character.update({
      where: { id: characterId },
      data: { imageAssetId: archivedAssetId },
    });
    const archivedPublish = await api("PATCH", `characters/${characterId}`, {
      userId,
      ageGate: true,
      body: { visibility: "public" },
    });
    expectError(archivedPublish, 400, "bad_request");
    await expect(
      prisma.character.findUniqueOrThrow({ where: { id: characterId } }),
    ).resolves.toMatchObject({ visibility: "private" });
  });

  it("keeps one active identity verdict while preserving superseded feedback events", async () => {
    const userId = `${P}feedback-user`;
    const characterId = `${P}feedback-char`;
    const visualProfileId = `${P}feedback-profile`;
    const jobId = `${P}feedback-job`;
    const mediaId = `${P}feedback-media`;
    await createUser({ id: userId });
    await createCharacter({
      id: characterId,
      creatorId: userId,
      visibility: "private",
      status: "approved",
    });
    await prisma.characterVisualProfile.create({
      data: {
        id: visualProfileId,
        characterId,
        version: 1,
        status: "active",
        style: "realistic",
        identityPrompt: "Feedback job identity",
        faceTraits: {},
        hairTraits: {},
        bodyTraits: {},
        signatureTraits: {},
        styleTraits: {},
        anchorAssetIds: [],
        referenceAssetIds: [],
        adapterRefs: {},
        createdFrom: "test",
      },
    });
    await prisma.generationJob.create({
      data: {
        id: jobId,
        userId,
        characterId,
        visualProfileId,
        visualProfileVersion: 1,
        mode: "image",
        controls: {},
        presetIds: [],
        outputCount: 1,
        status: "completed",
      },
    });
    await prisma.mediaAsset.create({
      data: {
        id: mediaId,
        ownerId: userId,
        characterId,
        sourceJobId: jobId,
        type: "image",
        url: "/images/ourdream/card-sarah-mercer.webp",
        visibility: "private",
        safetyStatus: "passed",
        metadata: {},
      },
    });

    const first = await api("POST", `media/${mediaId}/feedback`, {
      userId,
      ageGate: true,
      body: { feedbackType: "identity_match", sourceSurface: "chat" },
    });
    expectOk(first);
    expect(first.data.feedback).toMatchObject({
      dimension: "identity",
      value: "match",
      revision: 1,
    });
    expect(first.data.referenceCandidate).toMatchObject({
      mediaAssetId: mediaId,
      status: "candidate",
      proposedRole: "identity_reference",
      source: "user_feedback",
    });

    const duplicate = await api("POST", `media/${mediaId}/feedback`, {
      userId,
      ageGate: true,
      body: { feedbackType: "identity_match", sourceSurface: "chat" },
    });
    expectOk(duplicate);
    expect(duplicate.data.feedback).toEqual(first.data.feedback);

    const replaced = await api("POST", `media/${mediaId}/feedback`, {
      userId,
      ageGate: true,
      body: { feedbackType: "identity_mismatch", sourceSurface: "chat" },
    });
    expectOk(replaced);
    expect(replaced.data.feedback).toMatchObject({
      id: first.data.feedback.id,
      dimension: "identity",
      value: "mismatch",
      revision: 2,
    });
    expect(replaced.data.referenceCandidate).toMatchObject({
      id: first.data.referenceCandidate.id,
      status: "rejected",
    });

    const detail = await api("GET", `generation/jobs/${jobId}`, {
      userId,
      ageGate: true,
    });
    expectOk(detail);
    const feedbackEvents = (detail.data.events as Array<{ type: string; metadata: Record<string, unknown> }>).filter(
      (event) => event.type === "user_feedback",
    );
    expect(feedbackEvents).toHaveLength(2);
    expect(feedbackEvents[1]?.metadata).toMatchObject({
      feedbackDimension: "identity",
      feedbackValue: "mismatch",
      supersedesEventId: first.data.eventId,
    });
    const feedbackRows = await prisma.generationFeedback.findMany({
      where: { actorId: userId, mediaAssetId: mediaId, dimension: "identity" },
      orderBy: { revision: "asc" },
    });
    expect(feedbackRows).toHaveLength(2);
    expect(feedbackRows.map((row) => ({ value: row.value, active: row.active }))).toEqual([
      { value: "match", active: false },
      { value: "mismatch", active: true },
    ]);
    expect(feedbackRows[1]?.supersedesId).toBe(feedbackRows[0]?.id);
  });

  it("records historical profile-less feedback without polluting a new active identity", async () => {
    const userId = `${P}legacy-feedback-user`;
    const characterId = `${P}legacy-feedback-char`;
    const visualProfileId = `${P}legacy-feedback-new-profile`;
    const jobId = `${P}legacy-feedback-job`;
    const mediaId = `${P}legacy-feedback-media`;
    await createUser({ id: userId });
    await createCharacter({
      id: characterId,
      creatorId: userId,
      visibility: "private",
      status: "approved",
    });
    await prisma.generationJob.create({
      data: {
        id: jobId,
        userId,
        characterId,
        visualProfileId: null,
        visualProfileVersion: null,
        mode: "image",
        controls: {
          legacyReleaseAuthority: {
            schemaVersion: "legacy-character-generation-authority-v1",
            characterId,
            releaseId: `${P}historical-release`,
            releaseSnapshotHash: `${P}historical-snapshot`,
            releaseProvenanceSchemaVersion:
              "character-release-editorial-import-v1",
            qualificationId: `${P}historical-qualification`,
            qualificationKind: "editorial_import",
            qualificationEvidenceSchemaVersion:
              "public-catalog-qualification-v1",
            qualificationPolicyVersion:
              "public-catalog-editorial-import-v1",
          },
        },
        presetIds: [],
        outputCount: 1,
        status: "completed",
      },
    });
    await prisma.mediaAsset.create({
      data: {
        id: mediaId,
        ownerId: userId,
        characterId,
        sourceJobId: jobId,
        type: "image",
        url: "/images/ourdream/card-sarah-mercer.webp",
        visibility: "private",
        safetyStatus: "passed",
        metadata: {},
      },
    });
    await prisma.characterVisualProfile.create({
      data: {
        id: visualProfileId,
        characterId,
        version: 1,
        status: "active",
        style: "realistic",
        identityPrompt: "New identity created after historical media",
        faceTraits: {},
        hairTraits: {},
        bodyTraits: {},
        signatureTraits: {},
        styleTraits: {},
        anchorAssetIds: [],
        referenceAssetIds: [],
        adapterRefs: {},
        createdFrom: "test",
      },
    });

    const response = await api("POST", `media/${mediaId}/feedback`, {
      userId,
      ageGate: true,
      body: { feedbackType: "identity_match", sourceSurface: "gallery" },
    });
    expectOk(response);
    expect(response.data.feedback).toMatchObject({
      value: "match",
      revision: 1,
    });
    expect(response.data.referenceCandidate).toBeNull();
    await expect(
      prisma.referenceCandidate.count({ where: { mediaAssetId: mediaId } }),
    ).resolves.toBe(0);
    await expect(
      prisma.characterVisualProfile.findMany({
        where: { characterId },
        select: { id: true, version: true, status: true },
      }),
    ).resolves.toEqual([
      { id: visualProfileId, version: 1, status: "active" },
    ]);
  });

  it("serializes identity feedback with Library metadata authority and never revives an archived asset", async () => {
    const userId = `${P}feedback-archive-user`;
    const jobId = `${P}feedback-archive-job`;
    const mediaId = `${P}feedback-archive-media`;
    await createUser({ id: userId });
    await prisma.generationJob.create({
      data: {
        id: jobId,
        userId,
        mode: "image",
        controls: {},
        presetIds: [],
        outputCount: 1,
        status: "completed",
      },
    });
    await prisma.mediaAsset.create({
      data: {
        id: mediaId,
        ownerId: userId,
        sourceJobId: jobId,
        type: "image",
        url: "/images/ourdream/card-sarah-mercer.webp",
        visibility: "private",
        safetyStatus: "passed",
        metadata: { provider: "comfyui" },
      },
    });

    let feedbackRequest:
      | ReturnType<typeof api>
      | undefined;
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`media-asset-authority:${mediaId}`}))`;
      await tx.mediaAsset.update({
        where: { id: mediaId },
        data: {
          metadata: {
            provider: "comfyui",
            platformAsset: { status: "archived" },
          },
        },
      });
      const pendingFeedback = api("POST", `media/${mediaId}/feedback`, {
        userId,
        ageGate: true,
        body: {
          feedbackType: "identity_match",
          sourceSurface: "gallery",
        },
      });
      feedbackRequest = pendingFeedback;
      const state = await Promise.race([
        pendingFeedback.then(() => "settled" as const),
        new Promise<"waiting">((resolve) => {
          setTimeout(() => resolve("waiting"), 75);
        }),
      ]);
      expect(state).toBe("waiting");
    });

    expect(feedbackRequest).toBeDefined();
    const response = await feedbackRequest!;
    expectOk(response);
    const asset = await prisma.mediaAsset.findUniqueOrThrow({
      where: { id: mediaId },
    });
    expect(asset.metadata).toMatchObject({
      provider: "comfyui",
      platformAsset: { status: "archived" },
      quality: {
        identityFeedback: {
          value: "match",
          revision: 1,
        },
      },
    });
  });

  it("changes only the display avatar when an active immutable identity already exists", async () => {
    const userId = `${P}promote-existing-user`;
    const characterId = `${P}promote-existing-char`;
    const mediaId = `${P}promote-existing-media`;
    const oldAnchorId = `${P}promote-existing-anchor`;
    await createUser({ id: userId });
    await createCharacter({
      id: characterId,
      creatorId: userId,
      name: "Nia Vale",
      description: "A companion with green eyes.",
      visibility: "private",
      status: "approved",
    });
    await prisma.characterVisualProfile.create({
      data: {
        id: `${P}promote-existing-cvp-v1`,
        characterId,
        version: 1,
        status: "active",
        style: "realistic",
        identityPrompt: "Nia Vale, adult woman, green eyes",
        negativeIdentityPrompt: "different face",
        faceTraits: { eyes: "green" },
        hairTraits: {},
        bodyTraits: {},
        signatureTraits: {},
        styleTraits: { style: "realistic" },
        anchorAssetIds: [oldAnchorId],
        referenceAssetIds: [mediaId],
        defaultSeed: `${P}promote-existing-seed`,
        adapterRefs: {},
        immutableHash: `${P}promote-existing-immutable`,
        evidenceState: "sealed",
        createdFrom: "test",
      },
    });
    await prisma.mediaAsset.create({
      data: {
        id: mediaId,
        ownerId: userId,
        type: "image",
        url: "/images/ourdream/card-sarah-mercer.webp",
        thumbnailUrl: "/images/ourdream/card-sarah-mercer.webp",
        storageKey: `${P}promote-existing/${mediaId}.webp`,
        visibility: "private",
        safetyStatus: "passed",
        metadata: {},
      },
    });

    const promoted = await api("POST", `media/${mediaId}/use-as-character-image`, {
      userId,
      ageGate: true,
      body: { characterId },
    });
    expectOk(promoted);

    const oldProfile = await prisma.characterVisualProfile.findUniqueOrThrow({
      where: { id: `${P}promote-existing-cvp-v1` },
    });
    const activeProfile = await prisma.characterVisualProfile.findFirstOrThrow({
      where: { characterId, status: "active" },
    });
    expect(oldProfile.status).toBe("active");
    expect(activeProfile.version).toBe(1);
    expect(activeProfile.anchorAssetIds).toEqual([oldAnchorId]);
    expect(activeProfile.referenceAssetIds).toEqual([mediaId]);
    expect(activeProfile.immutableHash).toBe(`${P}promote-existing-immutable`);
    await expect(
      prisma.character.findUniqueOrThrow({ where: { id: characterId } }),
    ).resolves.toMatchObject({ imageAssetId: mediaId });
  });

  it("adds generated media through a reference revision without changing identity version", async () => {
    const userId = `${P}reference-user`;
    const characterId = `${P}reference-char`;
    const mediaId = `${P}reference-media`;
    const projectId = `${P}reference-project`;
    const releaseId = `${P}reference-release`;
    await createUser({ id: userId });
    await createCharacter({
      id: characterId,
      creatorId: userId,
      name: "Sera Night",
      description: "A companion with violet eyes.",
      visibility: "private",
      status: "approved",
    });
    await prisma.characterVisualProfile.create({
      data: {
        id: `${P}reference-cvp-v1`,
        characterId,
        version: 1,
        status: "active",
        style: "realistic",
        identityPrompt: "Sera Night, adult woman, violet eyes, sleek black hair",
        negativeIdentityPrompt: "different face",
        faceTraits: { eyes: "violet" },
        hairTraits: { color: "black" },
        bodyTraits: {},
        signatureTraits: {},
        styleTraits: { style: "realistic" },
        anchorAssetIds: [`${P}reference-anchor`],
        referenceAssetIds: [],
        defaultSeed: `${P}reference-seed`,
        adapterRefs: {},
        immutableHash: `${P}reference-immutable`,
        evidenceState: "sealed",
        createdFrom: "test",
      },
    });
    await prisma.mediaAsset.createMany({
      data: [`${P}reference-anchor`, mediaId].map((id) => ({
        id,
        ownerId: userId,
        characterId,
        type: "image",
        url: "/images/ourdream/card-sarah-mercer.webp",
        thumbnailUrl: "/images/ourdream/card-sarah-mercer.webp",
        storageKey: `${P}reference/${id}.webp`,
        visibility: "private",
        safetyStatus: "passed",
        metadata: {},
      })),
    });
    await prisma.characterProject.create({
      data: {
        id: projectId,
        characterId,
        ownerId: userId,
        audience: {},
        successCriteria: [],
        activeKey: `user:${characterId}`,
      },
    });
    await prisma.characterRelease.create({
      data: {
        id: releaseId,
        projectId,
        revisionId: `${releaseId}-revision`,
        characterContentVersionId: `${releaseId}-content`,
        visualProfileId: `${P}reference-cvp-v1`,
        visualProfileVersion: 1,
        generationProvenance: {},
        releasePlacementManifest: {},
        snapshotHash: `${releaseId}-snapshot`,
        status: "in_review",
      },
    });

    const blocked = await api("POST", `media/${mediaId}/add-to-identity`, {
      userId,
      ageGate: true,
    });
    expectError(blocked, 409, "conflict");
    expect(await prisma.referenceSetRevision.count({
      where: { visualProfileId: `${P}reference-cvp-v1` },
    })).toBe(0);
    await prisma.characterRelease.delete({ where: { id: releaseId } });

    const added = await api("POST", `media/${mediaId}/add-to-identity`, {
      userId,
      ageGate: true,
    });
    expectOk(added);

    const oldProfile = await prisma.characterVisualProfile.findUniqueOrThrow({
      where: { id: `${P}reference-cvp-v1` },
    });
    const activeProfile = await prisma.characterVisualProfile.findFirstOrThrow({
      where: { characterId, status: "active" },
    });
    const media = await prisma.mediaAsset.findUniqueOrThrow({ where: { id: mediaId } });
    expect(oldProfile.status).toBe("active");
    expect(activeProfile.version).toBe(1);
    expect(activeProfile.referenceAssetIds).toEqual([]);
    expect(activeProfile.anchorAssetIds).toEqual([`${P}reference-anchor`]);
    expect(activeProfile.immutableHash).toBe(`${P}reference-immutable`);
    expect(added.data.referenceSetRevision.references).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          mediaAssetId: mediaId,
          role: "identity_reference",
        }),
      ]),
    );
    expect(media.metadata).toMatchObject({
      quality: {
        addedToReferences: true,
        visualProfileId: activeProfile.id,
        visualProfileVersion: 1,
      },
    });
  });

  it("pins an immutable reference-set manifest on every character generation job", async () => {
    const userId = `${P}manifest-user`;
    const characterId = `${P}manifest-char`;
    const anchorId = `${P}manifest-anchor`;
    const referenceId = `${P}manifest-reference`;
    await createUser({ id: userId });
    await createCharacter({
      id: characterId,
      creatorId: userId,
      name: "Iris Vale",
      description: "A companion with silver hair and amber eyes.",
      visibility: "private",
      status: "approved",
    });
    await prisma.characterVisualProfile.create({
      data: {
        id: `${P}manifest-cvp-v1`,
        characterId,
        version: 1,
        status: "active",
        style: "realistic",
        identityPrompt: "Iris Vale, adult woman, silver hair, amber eyes",
        negativeIdentityPrompt: "different face",
        faceTraits: { eyes: "amber" },
        hairTraits: { color: "silver" },
        bodyTraits: {},
        signatureTraits: {},
        styleTraits: { style: "realistic" },
        anchorAssetIds: [anchorId],
        referenceAssetIds: [],
        defaultSeed: `${P}manifest-seed`,
        adapterRefs: {},
        createdFrom: "test",
      },
    });
    await prisma.mediaAsset.createMany({
      data: [anchorId, referenceId].map((id) => ({
        id,
        ownerId: userId,
        characterId,
        type: "image",
        url: "/images/ourdream/card-sarah-mercer.webp",
        storageKey: `${P}manifest/${id}.webp`,
        visibility: "private",
        safetyStatus: "passed",
        metadata: {},
      })),
    });

    const promoted = await api("POST", `media/${referenceId}/add-to-identity`, {
      userId,
      ageGate: true,
    });
    expectOk(promoted);
    expect(promoted.data.referenceSetRevision).toMatchObject({
      revision: 1,
      status: "active",
      references: [
        { mediaAssetId: anchorId, role: "primary_face" },
        { mediaAssetId: referenceId, role: "identity_reference" },
      ],
    });
    await prisma.referenceSetRevision.update({
      where: { id: promoted.data.referenceSetRevision.id },
      data: { status: "superseded" },
    });
    const prunedReferenceSet = await createSealedReferenceSet({
      id: `${P}manifest-reference-set-r2`,
      visualProfileId: `${P}manifest-cvp-v1`,
      revision: 2,
      references: [
        {
          mediaAssetId: anchorId,
          role: "primary_face",
          weight: 1,
          selectionReason: "primary_identity_anchor",
        },
      ],
    });

    await grantCoins(userId, 100, "seed");
    const created = await api("POST", "generation/jobs", {
      userId,
      ageGate: true,
      body: {
        mode: "image",
        characterId,
        outputCount: 1,
      },
    });
    expectOk(created, 202);
    expect(created.data.job).toMatchObject({
      referenceAssetIds: [anchorId],
      referenceSetRevisionId: prunedReferenceSet.id,
      referenceManifest: [
        { mediaAssetId: anchorId, role: "primary_face" },
      ],
      controls: {
        visualIdentity: {
          referenceAssetIds: [anchorId],
          referenceManifest: [
            { mediaAssetId: anchorId, role: "primary_face" },
          ],
        },
      },
    });
    const queued = await jobQueue.getByDedupeKey(
      "ai.image.generate",
      `generation:${created.data.job.id}`,
    );
    expect(queued?.payload).toMatchObject({
      referenceImages: [
        {
          assetId: anchorId,
          role: "identity_anchor",
          weight: 1,
          selectionReason: "primary_identity_anchor",
        },
      ],
    });
    await prisma.mediaAsset.update({
      where: { id: anchorId },
      data: { safetyStatus: "blocked" },
    });
    const unavailableAuthority = await api("POST", "generation/jobs", {
      userId,
      ageGate: true,
      body: {
        mode: "image",
        characterId,
        outputCount: 1,
      },
    });
    expectError(unavailableAuthority, 409, "conflict");
    await prisma.mediaAsset.update({
      where: { id: anchorId },
      data: { safetyStatus: "passed" },
    });
    await prisma.mediaAsset.update({
      where: { id: anchorId },
      data: { metadata: { platformAsset: { status: "archived" } } },
    });
    const archivedAuthority = await api("POST", "generation/jobs", {
      userId,
      ageGate: true,
      body: {
        mode: "image",
        characterId,
        outputCount: 1,
      },
    });
    expectError(archivedAuthority, 409, "conflict");
    await prisma.mediaAsset.update({
      where: { id: anchorId },
      data: { metadata: {} },
    });
  });

  it("fails dispatch closed when a source-only image was archived before resolution", async () => {
    const userId = `${P}archived-source-dispatch-user`;
    const sourceAssetId = `${P}archived-source-dispatch-asset`;
    const jobId = `${P}archived-source-dispatch-job`;
    await createUser({ id: userId });
    await prisma.mediaAsset.create({
      data: {
        id: sourceAssetId,
        ownerId: userId,
        type: "image",
        url: "/images/ourdream/card-sarah-mercer.webp",
        visibility: "private",
        safetyStatus: "passed",
        metadata: { platformAsset: { status: "archived" } },
      },
    });
    const job = await prisma.generationJob.create({
      data: {
        id: jobId,
        userId,
        mode: "image",
        controls: {
          sourceImageAssetId: sourceAssetId,
          modelCapabilities: {
            textToImage: true,
            referenceImages: false,
            initImage: true,
          },
        },
        presetIds: [],
        model: "chat-image-edit",
        orientation: "4:5",
        outputCount: 1,
        status: "queued",
      },
    });

    await expect(enqueueGenerationAttempt(job)).rejects.toMatchObject({
      status: 409,
      details: {
        generationJobId: jobId,
        sourceImageAssetId: sourceAssetId,
      },
    });
    await expect(
      jobQueue.getByDedupeKey("ai.image.generate", `generation:${jobId}`),
    ).resolves.toBeNull();
  });

  it("fails dispatch closed when any pinned Reference Set image is unavailable", async () => {
    const userId = `${P}partial-reference-dispatch-user`;
    const blockedReferenceId = `${P}partial-reference-dispatch-blocked`;
    const availableReferenceId = `${P}partial-reference-dispatch-available`;
    const jobId = `${P}partial-reference-dispatch-job`;
    await createUser({ id: userId });
    await prisma.mediaAsset.createMany({
      data: [
        {
          id: blockedReferenceId,
          ownerId: userId,
          type: "image",
          url: "/images/ourdream/card-sarah-mercer.webp",
          storageKey: `${P}partial-reference-blocked.webp`,
          visibility: "private",
          safetyStatus: "blocked",
          metadata: {},
        },
        {
          id: availableReferenceId,
          ownerId: userId,
          type: "image",
          url: "/images/ourdream/card-sophie.webp",
          storageKey: `${P}partial-reference-available.webp`,
          visibility: "private",
          safetyStatus: "passed",
          metadata: {},
        },
      ],
    });
    const job = await prisma.generationJob.create({
      data: {
        id: jobId,
        userId,
        mode: "image",
        controls: {
          modelCapabilities: {
            textToImage: true,
            referenceImages: true,
            initImage: false,
          },
        },
        presetIds: [],
        model: "reference-capable",
        orientation: "4:5",
        outputCount: 1,
        status: "queued",
      },
    });
    const pinnedJob = {
      ...job,
      referenceAssetIds: [blockedReferenceId, availableReferenceId],
      referenceSetRevisionId: `${P}partial-reference-dispatch-r1`,
      referenceManifest: [
        { mediaAssetId: blockedReferenceId, role: "primary_face" },
        { mediaAssetId: availableReferenceId, role: "identity_reference" },
      ],
    };

    await expect(enqueueGenerationAttempt(pinnedJob)).rejects.toMatchObject({
      status: 409,
      details: {
        generationJobId: jobId,
        referenceSetRevisionId: pinnedJob.referenceSetRevisionId,
        unavailableReferenceAssetIds: [blockedReferenceId],
      },
    });
    await expect(
      jobQueue.getByDedupeKey("ai.image.generate", `generation:${jobId}`),
    ).resolves.toBeNull();

  });

  it("fails dispatch closed when a pinned More-like source loses profile init-image capability", async () => {
    const userId = `${P}source-runtime-dispatch-user`;
    const anchorId = `${P}source-runtime-dispatch-anchor`;
    const sourceId = `${P}source-runtime-dispatch-source`;
    const profileKey = `${P}source-runtime-dispatch-profile`;
    const jobId = `${P}source-runtime-dispatch-job`;
    await createUser({ id: userId });
    await prisma.generationModelProfile.create({
      data: {
        id: profileKey,
        profileKey,
        label: "Source variation dispatch profile",
        mode: "image",
        runner: "pipeline",
        pipelineModel: "qwen-image-edit",
        workflowKey: "qwen-image-edit-img2img",
        runnerConfig: {
          capabilities: {
            textToImage: false,
            stableSeed: true,
            referenceImages: true,
            initImage: false,
            lora: false,
          },
        },
        allowedOrientations: ["4:5"],
        version: 1,
        status: "active",
      },
    });
    await prisma.generationRouteQualification.create({
      data: {
        id: `${P}source-runtime-qualification`,
        routeFingerprint: `${P}source-runtime-route`,
        generationProfileKey: profileKey,
        generationProfileVersion: 1,
        workflowKey: "qwen-image-edit-img2img",
        workflowVersion: 1,
        style: "realistic",
        matrixKey: `${P}source-runtime-matrix`,
        sampleCount: 40,
        passCount: 40,
        identityMatch: 0.95,
        result: "qualified",
        evidence: {
          evaluatorVersion: "identity-match-v1",
          reviewerId: `${P}source-runtime-reviewer`,
        },
        policyVersion: "character-release-policy-v2",
      },
    });
    await prisma.mediaAsset.createMany({
      data: [
        {
          id: anchorId,
          ownerId: userId,
          type: "image",
          url: "/images/ourdream/card-sarah-mercer.webp",
          storageKey: `${P}source-runtime-anchor.webp`,
          visibility: "private",
          safetyStatus: "passed",
          metadata: {},
        },
        {
          id: sourceId,
          ownerId: userId,
          type: "image",
          url: "/images/ourdream/card-sophie.webp",
          storageKey: `${P}source-runtime-source.webp`,
          visibility: "private",
          safetyStatus: "passed",
          metadata: {},
        },
      ],
    });
    const job = await prisma.generationJob.create({
      data: {
        id: jobId,
        userId,
        mode: "image",
        controls: {
          generationRouteFingerprint: `${P}source-runtime-route`,
          workflowIdentity: {
            mode: "multi_reference",
            acceptedRoles: ["identity_anchor", "source_image"],
            maxReferences: 2,
            supportsSourceImageWithIdentity: true,
          },
        },
        presetIds: [],
        model: "qwen-image-edit-img2img",
        profileId: profileKey,
        profileVersion: 1,
        orientation: "4:5",
        outputCount: 1,
        status: "queued",
      },
    });
    const pinnedJob = {
      ...job,
      referenceAssetIds: [anchorId, sourceId],
      referenceSetRevisionId: `${P}source-runtime-r1`,
      referenceManifest: [
        { mediaAssetId: anchorId, role: "primary_face" },
        { mediaAssetId: sourceId, role: "source_image" },
      ],
    };

    await expect(enqueueGenerationAttempt(pinnedJob)).rejects.toMatchObject({
      status: 409,
      details: {
        generationJobId: jobId,
        sourceReferenceCount: 1,
        identityReferenceCount: 1,
      },
    });
    await expect(
      jobQueue.getByDedupeKey("ai.image.generate", `generation:${jobId}`),
    ).resolves.toBeNull();

    await prisma.generationModelProfile.update({
      where: { id: profileKey },
      data: {
        runnerConfig: {
          capabilities: {
            textToImage: false,
            stableSeed: true,
            referenceImages: true,
            initImage: true,
            lora: false,
          },
        },
      },
    });
    await expect(enqueueGenerationAttempt(pinnedJob)).rejects.toMatchObject({
      status: 409,
      details: {
        generationJobId: jobId,
        workflowKey: "qwen-image-edit-img2img",
        workflowVersion: 1,
      },
    });
    await expect(
      jobQueue.getByDedupeKey("ai.image.generate", `generation:${jobId}`),
    ).resolves.toBeNull();
  });

  it("does not let stale stored workflow hints truncate pinned references", async () => {
    const userId = `${P}filtered-reference-dispatch-user`;
    const anchorId = `${P}filtered-reference-dispatch-anchor`;
    const referenceId = `${P}filtered-reference-dispatch-reference`;
    const profileKey = `${P}filtered-reference-dispatch-profile`;
    await createUser({ id: userId });
    await prisma.generationModelProfile.create({
      data: {
        id: profileKey,
        profileKey,
        label: "Filtered Reference dispatch profile",
        mode: "image",
        runner: "comfyui",
        pipelineModel: "qwen-image-edit",
        workflowKey: "qwen-image-edit-multi-identity",
        runnerConfig: {
          capabilities: {
            textToImage: true,
            stableSeed: true,
            referenceImages: true,
            initImage: false,
            lora: false,
          },
        },
        allowedOrientations: ["4:5"],
        version: 1,
        status: "active",
      },
    });
    await prisma.mediaAsset.createMany({
      data: [
        {
          id: anchorId,
          ownerId: userId,
          type: "image",
          url: "/images/ourdream/card-sarah-mercer.webp",
          storageKey: `${P}filtered-reference-anchor.webp`,
          visibility: "private",
          safetyStatus: "passed",
          metadata: {},
        },
        {
          id: referenceId,
          ownerId: userId,
          type: "image",
          url: "/images/ourdream/card-sophie.webp",
          storageKey: `${P}filtered-reference-support.webp`,
          visibility: "private",
          safetyStatus: "passed",
          metadata: {},
        },
      ],
    });
    const cases = [
      {
        label: "accepted role",
        workflowIdentity: {
          acceptedRoles: ["identity_anchor"],
          maxReferences: 2,
        },
      },
      {
        label: "max references",
        workflowIdentity: {
          acceptedRoles: ["identity_anchor", "identity_reference"],
          maxReferences: 1,
        },
      },
    ] as const;

    for (const [index, scenario] of cases.entries()) {
      const jobId = `${P}filtered-reference-dispatch-job-${index}`;
      const job = await prisma.generationJob.create({
        data: {
          id: jobId,
          userId,
          mode: "image",
          controls: { workflowIdentity: scenario.workflowIdentity },
          presetIds: [],
          model: "reference-capable",
          profileId: profileKey,
          profileVersion: 1,
          orientation: "4:5",
          outputCount: 1,
          status: "queued",
        },
      });
      const pinnedJob = {
        ...job,
        referenceAssetIds: [anchorId, referenceId],
        referenceSetRevisionId: `${P}filtered-reference-dispatch-r1-${index}`,
        referenceManifest: [
          { mediaAssetId: anchorId, role: "primary_face" },
          { mediaAssetId: referenceId, role: "identity_reference" },
        ],
      };

      await expect(
        enqueueGenerationAttempt(pinnedJob),
        scenario.label,
      ).resolves.toBeUndefined();
      const queued = await jobQueue.getByDedupeKey(
        "ai.image.generate",
        `generation:${jobId}`,
      );
      expect(queued?.payload, scenario.label).toMatchObject({
        referenceImages: [
          expect.objectContaining({
            assetId: anchorId,
            role: "identity_anchor",
          }),
          expect.objectContaining({
            assetId: referenceId,
            role: "identity_reference",
          }),
        ],
      });
    }
  });

  it("stores a versioned MomentSpec snapshot instead of relying on prompt text alone", async () => {
    const userId = `${P}moment-user`;
    const characterId = `${P}moment-char`;
    const anchorId = `${P}moment-anchor`;
    const visualProfileId = `${P}moment-cvp`;
    await createUser({ id: userId });
    await createCharacter({
      id: characterId,
      creatorId: userId,
      name: "Nora Vale",
      description: "An adult companion with a calm presence.",
      visibility: "private",
      status: "approved",
    });
    await prisma.mediaAsset.create({
      data: {
        id: anchorId,
        ownerId: userId,
        characterId,
        type: "image",
        url: `/user-content/${anchorId}/content.webp`,
        thumbnailUrl: `/user-content/${anchorId}/content.webp`,
        storageKey: `${P}moment/identity-anchor.webp`,
        contentType: "image/webp",
        width: 1024,
        height: 1280,
        visibility: "private",
        safetyStatus: "passed",
        metadata: {},
      },
    });
    await prisma.characterVisualProfile.create({
      data: {
        id: visualProfileId,
        characterId,
        version: 1,
        status: "active",
        style: "realistic",
        identityPrompt: "Nora Vale, adult woman with a calm presence",
        faceTraits: {},
        hairTraits: {},
        bodyTraits: {},
        signatureTraits: {},
        styleTraits: { style: "realistic" },
        anchorAssetIds: [anchorId],
        referenceAssetIds: [],
        adapterRefs: {},
        createdFrom: "test",
      },
    });
    await createSealedReferenceSet({
      id: `${P}moment-reference-set`,
      visualProfileId,
      references: [
        {
          mediaAssetId: anchorId,
          role: "primary_face",
          weight: 1,
          selectionReason: "primary_identity_anchor",
        },
      ],
    });
    await grantCoins(userId, 100, "seed");

    const rawInput = "Reading by the rainy window, glancing up with a warm smile";
    const created = await api("POST", "generation/jobs", {
      userId,
      ageGate: true,
      body: {
        mode: "image",
        characterId,
        prompt: rawInput,
        outputCount: 1,
      },
    });

    expectOk(created, 202);
    expect(created.data.job.momentSpec).toMatchObject({
      schemaVersion: "1",
      parserVersion: "moment-direct-v1",
      rawInput,
      scene: rawInput,
      confidence: 1,
      continuitySources: ["user_prompt"],
    });
  });

  it("rejects Save as Look when relative media has only a providerKey projection", async () => {
    const userId = `${P}look-provider-key-only-user`;
    const characterId = `${P}look-provider-key-only-char`;
    const anchorId = `${P}look-provider-key-only-anchor`;
    const mediaId = `${P}look-provider-key-only-media`;
    const profileId = `${P}look-provider-key-only-cvp`;
    await createUser({ id: userId });
    await createCharacter({
      id: characterId,
      creatorId: userId,
      name: "Provider Key Look",
      description: "An adult companion with a sealed visual identity.",
      visibility: "private",
      status: "approved",
    });
    await prisma.mediaAsset.createMany({
      data: [
        {
          id: anchorId,
          ownerId: userId,
          characterId,
          type: "image",
          url: `/user-content/${anchorId}/content.webp`,
          storageKey: `${P}look-provider-key-only/anchor.webp`,
          visibility: "private",
          safetyStatus: "passed",
          metadata: {},
        },
        {
          id: mediaId,
          ownerId: userId,
          characterId,
          type: "image",
          url: `/user-content/${mediaId}/content.webp`,
          visibility: "private",
          safetyStatus: "passed",
          metadata: {
            providerKey: `${P}look-provider-key-only/projected.webp`,
          },
        },
      ],
    });
    await prisma.characterVisualProfile.create({
      data: {
        id: profileId,
        characterId,
        version: 1,
        status: "active",
        style: "realistic",
        identityPrompt: "Stable adult identity for provider-key rejection",
        faceTraits: {},
        hairTraits: {},
        bodyTraits: {},
        signatureTraits: {},
        styleTraits: {},
        anchorAssetIds: [anchorId],
        referenceAssetIds: [],
        adapterRefs: {},
        createdFrom: "test",
      },
    });
    await createSealedReferenceSet({
      id: `${P}look-provider-key-only-reference-set`,
      visualProfileId: profileId,
      references: [
        {
          mediaAssetId: anchorId,
          role: "primary_face",
          weight: 1,
          selectionReason: "primary_identity_anchor",
        },
      ],
    });

    const looksBefore = await prisma.characterLook.count({
      where: { characterId },
    });
    const saved = await api("POST", `media/${mediaId}/save-as-look`, {
      userId,
      ageGate: true,
      body: {
        label: "Projected bytes only",
        appearanceDelta: { outfit: "silver evening coat" },
      },
    });

    expectError(saved, 409, "conflict");
    expect(saved.error?.details).toMatchObject({ mediaAssetId: mediaId });
    await expect(
      prisma.characterLook.count({ where: { characterId } }),
    ).resolves.toBe(looksBefore);
  });

  it("creates reusable character Looks and snapshots the selected Look on a job", async () => {
    const userId = `${P}look-user`;
    const characterId = `${P}look-char`;
    const identityAnchorId = `${P}look-identity-anchor`;
    await createUser({ id: userId });
    await createCharacter({
      id: characterId,
      creatorId: userId,
      name: "Mina Hart",
      description: "An adult companion with dark curls.",
      visibility: "private",
      status: "approved",
    });
    await prisma.mediaAsset.create({
      data: {
        id: identityAnchorId,
        ownerId: userId,
        characterId,
        type: "image",
        url: "/images/ourdream/card-amelie-dubois.webp",
        storageKey: `${P}look-identity-anchor.webp`,
        visibility: "private",
        safetyStatus: "passed",
        metadata: {},
      },
    });
    await prisma.characterVisualProfile.create({
      data: {
        id: `${P}look-cvp`,
        characterId,
        version: 1,
        status: "active",
        style: "realistic",
        identityPrompt: "Mina Hart, adult woman, dark curls",
        negativeIdentityPrompt: "different face",
        faceTraits: {},
        hairTraits: { color: "dark", texture: "curly" },
        bodyTraits: {},
        signatureTraits: {},
        styleTraits: { style: "realistic" },
        anchorAssetIds: [identityAnchorId],
        referenceAssetIds: [],
        adapterRefs: {},
        createdFrom: "test",
      },
    });
    await createSealedReferenceSet({
      id: `${P}look-reference-set`,
      visualProfileId: `${P}look-cvp`,
      references: [
        {
          mediaAssetId: identityAnchorId,
          role: "primary_face",
          weight: 1,
          selectionReason: "primary_identity_anchor",
        },
      ],
    });

    const saved = await api("POST", `characters/${characterId}/looks`, {
      userId,
      ageGate: true,
      body: {
        label: "Rainy day",
        appearanceDelta: {
          outfit: "cream trench coat",
          hair: "dark curls pinned loosely",
          accessories: ["amber umbrella"],
        },
      },
    });
    expectOk(saved, 201);
    expect(saved.data.look).toMatchObject({
      characterId,
      label: "Rainy day",
      status: "active",
      appearanceDelta: { outfit: "cream trench coat" },
    });
    const rejectedIdentityChange = await api("POST", `characters/${characterId}/looks`, {
      userId,
      ageGate: true,
      body: { label: "Different face", appearanceDelta: { face: "change facial structure" } },
    });
    expectError(rejectedIdentityChange, 400, "bad_request");

    const listed = await api("GET", `characters/${characterId}/looks`, {
      userId,
      ageGate: true,
    });
    expectOk(listed);
    expect(listed.data.items).toHaveLength(1);

    const lookMediaId = `${P}look-media`;
    await prisma.mediaAsset.create({
      data: {
        id: lookMediaId,
        ownerId: userId,
        characterId,
        type: "image",
        url: "/images/ourdream/card-sarah-mercer.webp",
        storageKey: `${P}look-media.webp`,
        visibility: "private",
        safetyStatus: "passed",
        metadata: {},
      },
    });
    const savedFromMedia = await api("POST", `media/${lookMediaId}/save-as-look`, {
      userId,
      ageGate: true,
      body: {
        label: "Evening dress",
        appearanceDelta: { outfit: "midnight blue evening dress" },
      },
    });
    expectOk(savedFromMedia, 201);
    expect(savedFromMedia.data.look).toMatchObject({
      characterId,
      referenceAssetId: lookMediaId,
      label: "Evening dress",
    });

    await grantCoins(userId, 100, "seed");
    const lookGenerationBody = {
      mode: "image" as const,
      characterId,
      controls: { lookId: savedFromMedia.data.look.id as string },
      outputCount: 1,
    };
    const quotedLookGeneration = await api(
      "POST",
      "generation/quote",
      {
        userId,
        ageGate: true,
        body: lookGenerationBody,
      },
    );
    expectOk(quotedLookGeneration);
    const lookQuote =
      quotedLookGeneration.data.quote as ExactGenerationQuote & {
        maxCount: number;
        orientations: string[];
      };
    expect(lookQuote.maxCount).toBeGreaterThan(0);
    expect(lookQuote.orientations).toContain("4:5");
    const generated = await api("POST", "generation/jobs", {
      userId,
      ageGate: true,
      body: {
        ...lookGenerationBody,
        quoteAuthority: quoteAuthority(lookQuote),
      },
    });
    expectOk(generated, 202);
    const routedProfileId = generated.data.job.profileId as string;
    const routedProfileVersion = generated.data.job.profileVersion as number;
    expect(routedProfileId).toBeTruthy();
    expect(routedProfileVersion).toBeGreaterThan(0);
    expect(routedProfileId).toBe(lookQuote.profileId);
    expect(routedProfileVersion).toBe(lookQuote.profileVersion);
    expect(generated.data.job.costDreamcoins).toBe(
      lookQuote.costs[0]?.costDreamcoins,
    );
    expect(generated.data.job).toMatchObject({
      lookId: savedFromMedia.data.look.id,
      model: "qwen-image-edit-multi-identity",
      profileId: routedProfileId,
      profileVersion: routedProfileVersion,
      lookSnapshot: {
        label: "Evening dress",
        appearanceDelta: { outfit: "midnight blue evening dress" },
        referenceAssetId: lookMediaId,
      },
      controls: {
        lookId: savedFromMedia.data.look.id,
        lookReferenceAssetId: lookMediaId,
        generationProfileKey: routedProfileId,
        generationProfileVersion: routedProfileVersion,
        workflowKey: "qwen-image-edit-multi-identity",
        workflowVersion: 1,
      },
    });
    expect(generated.data.job.prompt).toContain("midnight blue evening dress");
    const generatedJobId = generated.data.job.id as string;
    const queuedLookGeneration = await jobQueue.getByDedupeKey(
      "ai.image.generate",
      `generation:${generatedJobId}`,
    );
    expect(queuedLookGeneration?.payload).toMatchObject({
      controls: {
        lookReferenceAssetId: lookMediaId,
        generationProfileKey: routedProfileId,
        workflowKey: "qwen-image-edit-multi-identity",
      },
      referenceImages: expect.arrayContaining([
        expect.objectContaining({
          assetId: identityAnchorId,
          role: "identity_anchor",
          storageKey: `${P}look-identity-anchor.webp`,
        }),
        expect.objectContaining({
          assetId: lookMediaId,
          role: "look_reference",
          storageKey: `${P}look-media.webp`,
        }),
      ]),
    });

    await jobQueue.removeByDedupePrefix(
      `generation:${generatedJobId}`,
      ["ai.image.generate"],
    );
    await prisma.generationJob.update({
      where: { id: generatedJobId },
      data: {
        status: "failed",
        errorCode: "look_retry_fixture",
      },
    });
    const retriedLookGeneration = await api(
      "POST",
      `generation/jobs/${generatedJobId}/retry`,
      {
        userId,
        ageGate: true,
        headers: {
          "idempotency-key": `${P}look-retry`,
        },
      },
    );
    expectOk(retriedLookGeneration, 202);
    expect(retriedLookGeneration.data.job).toMatchObject({
      derivedFromJobId: generatedJobId,
      lookId: savedFromMedia.data.look.id,
      model: "qwen-image-edit-multi-identity",
      profileId: routedProfileId,
      profileVersion: routedProfileVersion,
      lookSnapshot: {
        referenceAssetId: lookMediaId,
      },
      controls: {
        lookId: savedFromMedia.data.look.id,
        lookReferenceAssetId: lookMediaId,
        generationProfileKey: routedProfileId,
        generationProfileVersion: routedProfileVersion,
        workflowKey: "qwen-image-edit-multi-identity",
        workflowVersion: 1,
      },
    });
    const retriedJobId = retriedLookGeneration.data.job.id as string;
    const queuedLookRetry = await jobQueue.getByDedupeKey(
      "ai.image.generate",
      `generation:${retriedJobId}`,
    );
    expect(queuedLookRetry?.payload).toMatchObject({
      controls: {
        lookReferenceAssetId: lookMediaId,
        generationProfileKey: routedProfileId,
        workflowKey: "qwen-image-edit-multi-identity",
      },
      referenceImages: expect.arrayContaining([
        expect.objectContaining({
          assetId: identityAnchorId,
          role: "identity_anchor",
          storageKey: `${P}look-identity-anchor.webp`,
        }),
        expect.objectContaining({
          assetId: lookMediaId,
          role: "look_reference",
          storageKey: `${P}look-media.webp`,
        }),
      ]),
    });
    await jobQueue.removeByDedupePrefix(
      `generation:${retriedJobId}`,
      ["ai.image.generate"],
    );
    await prisma.generationJob.update({
      where: { id: retriedJobId },
      data: {
        status: "failed",
        errorCode: "look_retry_asserted",
      },
    });

    const identityReferenceId = `${P}look-identity-reference`;
    await prisma.mediaAsset.create({
      data: {
        id: identityReferenceId,
        ownerId: userId,
        characterId,
        type: "image",
        url: "/images/ourdream/card-sophie.webp",
        storageKey: `${P}look-identity-reference.webp`,
        visibility: "private",
        safetyStatus: "passed",
        metadata: {},
      },
    });
    const identityUpdate = await api("POST", `media/${identityReferenceId}/add-to-identity`, {
      userId,
      ageGate: true,
      body: { characterId },
    });
    expectOk(identityUpdate);
    const rebasedList = await api("GET", `characters/${characterId}/looks`, {
      userId,
      ageGate: true,
    });
    expectOk(rebasedList);
    expect(rebasedList.data.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: "Rainy day",
          visualProfileId: identityUpdate.data.visualProfile.id,
          id: saved.data.look.id,
          rebasedFromLookId: null,
          status: "active",
        }),
      ]),
    );
    const characterUpdate = await api("PATCH", `characters/${characterId}`, {
      userId,
      ageGate: true,
      body: { name: "Mina Hart V2" },
    });
    expectOk(characterUpdate);
    const activeProfileV2 = await prisma.characterVisualProfile.findFirstOrThrow({
      where: { characterId, status: "active" },
      orderBy: { version: "desc" },
    });
    expect(activeProfileV2.version).toBe(2);
    await expect(
      prisma.characterLook.findUniqueOrThrow({
        where: { id: saved.data.look.id as string },
      }),
    ).resolves.toMatchObject({
      visualProfileId: `${P}look-cvp`,
      status: "needs_rebase",
      activeKey: null,
    });

    const reactivated = await api(
      "PATCH",
      `characters/${characterId}/looks/${saved.data.look.id as string}`,
      {
        userId,
        ageGate: true,
        body: { status: "active" },
      },
    );
    expectOk(reactivated);
    expect(reactivated.data.look).toMatchObject({
      characterId,
      visualProfileId: activeProfileV2.id,
      status: "active",
      rebasedFromLookId: saved.data.look.id,
    });
    expect(reactivated.data.look.id).not.toBe(saved.data.look.id);

    await prisma.mediaAsset.update({
      where: { id: lookMediaId },
      data: { metadata: { platformAsset: { status: "archived" } } },
    });
    const unavailableRebase = await api(
      "PATCH",
      `characters/${characterId}/looks/${savedFromMedia.data.look.id as string}`,
      {
        userId,
        ageGate: true,
        body: { status: "active" },
      },
    );
    expectError(unavailableRebase, 409, "conflict");
    await expect(
      prisma.characterLook.findUniqueOrThrow({
        where: { id: savedFromMedia.data.look.id as string },
      }),
    ).resolves.toMatchObject({
      visualProfileId: `${P}look-cvp`,
      status: "needs_rebase",
    });

    const generatedWithRebasedLook = await api("POST", "generation/jobs", {
      userId,
      ageGate: true,
      body: {
        mode: "image",
        characterId,
        controls: { lookId: reactivated.data.look.id },
        outputCount: 1,
      },
    });
    expectOk(generatedWithRebasedLook, 202);
    expect(generatedWithRebasedLook.data.job).toMatchObject({
      lookId: reactivated.data.look.id,
      lookSnapshot: {
        visualProfileId: activeProfileV2.id,
      },
    });
  });

  it("rejects another user retrying a failed job for a public Character", async () => {
    const jobOwnerId = `${P}public-retry-job-owner`;
    const otherUserId = `${P}public-retry-other-user`;
    const failedJobId = `${P}public-retry-failed-job`;
    await createUser({ id: jobOwnerId });
    await createUser({ id: otherUserId });
    await prisma.generationJob.create({
      data: {
        id: failedJobId,
        userId: jobOwnerId,
        characterId: CHAR,
        mode: "image",
        controls: {},
        presetIds: [],
        outputCount: 1,
        status: "failed",
        errorCode: "public_retry_fixture",
      },
    });

    const response = await api(
      "POST",
      `generation/jobs/${failedJobId}/retry`,
      {
        userId: otherUserId,
        ageGate: true,
        headers: {
          "idempotency-key": `${P}public-retry-other-user`,
        },
      },
    );

    expectError(response, 404, "not_found");
    await expect(
      prisma.generationJob.count({
        where: { derivedFromJobId: failedJobId },
      }),
    ).resolves.toBe(0);
  });

  it("creates a more-like-this variation through the standard character identity pipeline", async () => {
    const userId = `${P}variation-user`;
    const characterId = `${P}variation-char`;
    const mediaId = `${P}variation-media`;
    const identityAnchorId = `${P}variation-identity-anchor`;
    await createUser({ id: userId });
    await createCharacter({
      id: characterId,
      creatorId: userId,
      name: "Vera Lune",
      description: "A companion with pearl-white hair.",
      visibility: "private",
      status: "approved",
    });
    await prisma.characterVisualProfile.create({
      data: {
        id: `${P}variation-cvp`,
        characterId,
        version: 1,
        status: "active",
        style: "realistic",
        identityPrompt: "Vera Lune, adult woman, pearl-white hair, grey eyes",
        negativeIdentityPrompt: "different face",
        faceTraits: { eyes: "grey" },
        hairTraits: { color: "pearl-white" },
        bodyTraits: {},
        signatureTraits: {},
        styleTraits: { style: "realistic" },
        anchorAssetIds: [identityAnchorId],
        referenceAssetIds: [identityAnchorId],
        defaultSeed: `${P}variation-seed`,
        adapterRefs: {},
        createdFrom: "test",
      },
    });
    await prisma.mediaAsset.create({
      data: {
        id: identityAnchorId,
        ownerId: userId,
        characterId,
        type: "image",
        url: "/images/ourdream/card-amelie-dubois.webp",
        thumbnailUrl: "/images/ourdream/card-amelie-dubois.webp",
        storageKey: `${P}variation/identity-anchor.webp`,
        contentType: "image/webp",
        width: 1024,
        height: 1280,
        visibility: "private",
        safetyStatus: "passed",
        metadata: {},
      },
    });
    await prisma.mediaAsset.create({
      data: {
        id: mediaId,
        ownerId: userId,
        characterId,
        type: "image",
        url: "/images/ourdream/card-sarah-mercer.webp",
        thumbnailUrl: "/images/ourdream/card-sarah-mercer.webp",
        storageKey: `${P}variation/source.webp`,
        contentType: "image/webp",
        width: 1024,
        height: 1024,
        prompt: "Requested scene: sitting in a lantern-lit library. clean composition",
        visibility: "private",
        safetyStatus: "passed",
        metadata: {},
      },
    });
    await createSealedReferenceSet({
      id: `${P}variation-reference-set`,
      visualProfileId: `${P}variation-cvp`,
      references: [
        {
          mediaAssetId: identityAnchorId,
          role: "primary_face",
          weight: 1,
          selectionReason: "primary_identity_anchor",
        },
      ],
    });
    await grantCoins(userId, 100, "seed");

    const quotedVariation = await api(
      "POST",
      `media/${mediaId}/variation/quote`,
      {
        userId,
        ageGate: true,
        body: { consistencyMode: "creative" },
      },
    );
    expectOk(quotedVariation);
    const variationQuote =
      quotedVariation.data.quote as ExactGenerationQuote & {
        defaultOrientation: string;
        maxCount: number;
        orientations: string[];
      };
    expect(variationQuote.maxCount).toBeGreaterThan(0);
    expect(variationQuote.orientations).toContain("4:5");
    const balanceBefore = await dreamcoinBalance(userId);

    const variationIdempotencyKey = `${P}variation-idempotency`;
    const variationBody = {
      outputCount: 1,
      consistencyMode: "creative" as const,
      orientation: variationQuote.defaultOrientation,
      quoteAuthority: quoteAuthority(variationQuote),
    };
    const variation = await api("POST", `media/${mediaId}/variation`, {
      userId,
      ageGate: true,
      headers: { "Idempotency-Key": variationIdempotencyKey },
      body: variationBody,
    });
    expectOk(variation, 202);

    const job = await prisma.generationJob.findUniqueOrThrow({
      where: { id: variation.data.job.id as string },
    });
    expect(job.sourceType).toBe("media_variation");
    expect(job.sourceMeta).toMatchObject({ sourceMediaId: mediaId });
    expect(job.characterId).toBe(characterId);
    expect(job.visualProfileId).toBe(`${P}variation-cvp`);
    expect(job.consistencyMode).toBe("creative");
    expect(job.orientation).toBe(variationQuote.defaultOrientation);
    expect(job.profileId).toBe(variationQuote.profileId);
    expect(job.profileVersion).toBe(variationQuote.profileVersion);
    expect(job.costDreamcoins).toBe(
      variationQuote.costs[0]?.costDreamcoins,
    );
    expect(job.controls).toMatchObject({
      generationQuoteAuthority: {
        schemaVersion: "generation-quote-authority-v1",
        profileId: variationQuote.profileId,
        profileVersion: variationQuote.profileVersion,
        routeFingerprint: variationQuote.routeFingerprint,
        pricing: {
          ruleId: variationQuote.pricing.ruleId,
          ruleKey: variationQuote.pricing.ruleKey,
          version: variationQuote.pricing.version,
          effectiveFrom: variationQuote.pricing.effectiveFrom,
          fingerprint: variationQuote.pricing.fingerprint,
        },
        outputCount: 1,
        costDreamcoins: variationQuote.costs[0]?.costDreamcoins,
      },
    });
    await expect(dreamcoinBalance(userId)).resolves.toBe(
      balanceBefore - job.costDreamcoins,
    );
    const balanceAfterCreate = await dreamcoinBalance(userId);
    await prisma.mediaAsset.update({
      where: { id: mediaId },
      data: { deletedAt: new Date() },
    });
    const replayAfterSourceDeletion = await api(
      "POST",
      `media/${mediaId}/variation`,
      {
        userId,
        ageGate: true,
        headers: { "Idempotency-Key": variationIdempotencyKey },
        body: {
          ...variationBody,
          quoteAuthority: {
            ...variationBody.quoteAuthority,
            pricingFingerprint: "f".repeat(64),
          },
        },
      },
    );
    expectOk(replayAfterSourceDeletion, 202);
    expect(replayAfterSourceDeletion.data.job.id).toBe(job.id);
    await expect(dreamcoinBalance(userId)).resolves.toBe(balanceAfterCreate);
    await expect(
      prisma.generationJob.count({
        where: { userId, idempotencyKey: variationIdempotencyKey },
      }),
    ).resolves.toBe(1);
    const conflictingVariation = await api(
      "POST",
      `media/${mediaId}/variation`,
      {
        userId,
        ageGate: true,
        headers: { "Idempotency-Key": variationIdempotencyKey },
        body: {
          ...variationBody,
          consistencyMode: "balanced",
        },
      },
    );
    expectError(conflictingVariation, 409, "conflict");
    expect(conflictingVariation.error?.message).toContain(
      "different generation request",
    );
    await expect(dreamcoinBalance(userId)).resolves.toBe(balanceAfterCreate);
    await expect(
      prisma.generationJob.count({
        where: { userId, idempotencyKey: variationIdempotencyKey },
      }),
    ).resolves.toBe(1);
    expect(job.prompt).toContain("Locked identity");
    expect(job.prompt).toContain("pearl-white hair");
    expect(job.prompt).toContain("lantern-lit library");
    const queued = await jobQueue.getByDedupeKey("ai.image.generate", `generation:${job.id}`);
    const queuedPayload = queued?.payload as { controls?: Record<string, unknown>; referenceImages?: unknown[] } | undefined;
    expect(queuedPayload?.controls).toMatchObject({
      sourceImageAssetId: mediaId,
      modelCapabilities: {
        referenceImages: true,
        initImage: true,
      },
    });
    expect(queuedPayload?.referenceImages).toEqual([
      expect.objectContaining({
        assetId: mediaId,
        role: "source_image",
        storageKey: `${P}variation/source.webp`,
        weight: 0.7,
      }),
      expect.objectContaining({
        assetId: identityAnchorId,
        role: "identity_anchor",
        storageKey: `${P}variation/identity-anchor.webp`,
        selectionReason: "primary_identity_anchor",
      }),
    ]);
    await runQueuedGenerationJobs(4);
  });

  it("quotes and creates a non-premium source-only variation with the same trusted source intent", async () => {
    const userId = `${P}freeplay-variation-user`;
    const mediaId = `${P}freeplay-variation-media`;
    await createUser({ id: userId });
    await prisma.mediaAsset.create({
      data: {
        id: mediaId,
        ownerId: userId,
        type: "image",
        url: "/images/ourdream/card-sarah-mercer.webp",
        thumbnailUrl: "/images/ourdream/card-sarah-mercer.webp",
        storageKey: `${P}freeplay-variation/source.webp`,
        contentType: "image/webp",
        width: 1024,
        height: 1280,
        prompt: "A lantern-lit library with warm cinematic shadows.",
        visibility: "private",
        safetyStatus: "passed",
        metadata: {},
      },
    });
    await grantCoins(userId, 100, "seed");

    const quoted = await api(
      "POST",
      `media/${mediaId}/variation/quote`,
      {
        userId,
        ageGate: true,
        body: { consistencyMode: "balanced" },
      },
    );
    expectOk(quoted);
    const quote =
      quoted.data.quote as ExactGenerationQuote & {
        maxCount: number;
        orientations: string[];
      };
    expect(quote.maxCount).toBeGreaterThan(0);
    expect(quote.orientations).toContain("4:5");

    const created = await api(
      "POST",
      `media/${mediaId}/variation`,
      {
        userId,
        ageGate: true,
        body: {
          outputCount: 1,
          consistencyMode: "balanced",
          quoteAuthority: quoteAuthority(quote),
        },
      },
    );
    expectOk(created, 202);
    expect(created.data.job).toMatchObject({
      characterId: null,
      sourceType: "media_variation",
      profileId: quote.profileId,
      profileVersion: quote.profileVersion,
      costDreamcoins: quote.costs[0]?.costDreamcoins,
    });
    await runQueuedGenerationJobs(4);
  });

  it("keeps a no-profile Character variation quote read-only and bootstraps only after exact authority is accepted", async () => {
    const userId = `${P}no-profile-variation-user`;
    const characterId = `${P}no-profile-variation-character`;
    const mediaId = `${P}no-profile-variation-media`;
    await createUser({ id: userId });
    await createCharacter({
      id: characterId,
      creatorId: userId,
      visibility: "private",
      status: "approved",
    });
    await prisma.mediaAsset.create({
      data: {
        id: mediaId,
        ownerId: userId,
        characterId,
        type: "image",
        url: "/images/ourdream/card-sarah-mercer.webp",
        thumbnailUrl: "/images/ourdream/card-sarah-mercer.webp",
        storageKey: `${P}no-profile-variation/source.webp`,
        contentType: "image/webp",
        width: 1024,
        height: 1280,
        prompt: "A sunlit conservatory portrait.",
        visibility: "private",
        safetyStatus: "passed",
        metadata: {},
      },
    });
    await grantCoins(userId, 100, "seed");
    const balanceBefore = await dreamcoinBalance(userId);

    const quoted = await api(
      "POST",
      `media/${mediaId}/variation/quote`,
      {
        userId,
        ageGate: true,
        body: { consistencyMode: "balanced" },
      },
    );
    expectOk(quoted);
    const quote =
      quoted.data.quote as ExactGenerationQuote;
    await expect(
      prisma.characterVisualProfile.count({ where: { characterId } }),
    ).resolves.toBe(0);

    const forged = await api(
      "POST",
      `media/${mediaId}/variation`,
      {
        userId,
        ageGate: true,
        body: {
          outputCount: 1,
          consistencyMode: "balanced",
          quoteAuthority: {
            ...quoteAuthority(quote),
            routeFingerprint: "0".repeat(64),
          },
        },
      },
    );
    expectError(forged, 409, "conflict");
    const selectedProfile =
      await prisma.generationModelProfile.findFirstOrThrow({
        where: {
          profileKey: quote.profileId,
          version: quote.profileVersion,
        },
      });
    const selectedWorkflowKey =
      selectedProfile.workflowKey ?? selectedProfile.pipelineModel;
    const originalWorkflowResolver =
      generationCatalog.generationWorkflowDescriptor;
    const quotedWorkflow = await originalWorkflowResolver(
      selectedWorkflowKey,
    );
    expect(quotedWorkflow).not.toBeNull();
    const workflowSpy = vi
      .spyOn(generationCatalog, "generationWorkflowDescriptor")
      .mockImplementation(async (workflowKey) => {
        const descriptor = await originalWorkflowResolver(workflowKey);
        return workflowKey === selectedWorkflowKey && descriptor
          ? { ...descriptor, version: descriptor.version + 1 }
          : descriptor;
      });
    try {
      const workflowDrift = await api(
        "POST",
        `media/${mediaId}/variation`,
        {
          userId,
          ageGate: true,
          body: {
            outputCount: 1,
            consistencyMode: "balanced",
            quoteAuthority: quoteAuthority(quote),
          },
        },
      );
      expectError(workflowDrift, 409, "conflict");
    } finally {
      workflowSpy.mockRestore();
    }
    await prisma.generationModelProfile.update({
      where: { id: selectedProfile.id },
      data: {
        costMultiplier: selectedProfile.costMultiplier + 0.25,
      },
    });
    try {
      const stale = await api(
        "POST",
        `media/${mediaId}/variation`,
        {
          userId,
          ageGate: true,
          body: {
            outputCount: 1,
            consistencyMode: "balanced",
            quoteAuthority: quoteAuthority(quote),
          },
        },
      );
      expectError(stale, 409, "conflict");
    } finally {
      await prisma.generationModelProfile.update({
        where: { id: selectedProfile.id },
        data: {
          costMultiplier: selectedProfile.costMultiplier,
        },
      });
    }
    await expect(
      prisma.characterVisualProfile.count({ where: { characterId } }),
    ).resolves.toBe(0);
    await expect(
      prisma.generationJob.count({ where: { userId } }),
    ).resolves.toBe(0);
    await expect(dreamcoinBalance(userId)).resolves.toBe(balanceBefore);

    const created = await api(
      "POST",
      `media/${mediaId}/variation`,
      {
        userId,
        ageGate: true,
        body: {
          outputCount: 1,
          consistencyMode: "balanced",
          quoteAuthority: quoteAuthority(quote),
        },
      },
    );
    expectOk(created, 202);
    await expect(
      prisma.characterVisualProfile.count({ where: { characterId } }),
    ).resolves.toBe(1);
    expect(created.data.job).toMatchObject({
      characterId,
      profileId: quote.profileId,
      profileVersion: quote.profileVersion,
      costDreamcoins: quote.costs[0]?.costDreamcoins,
    });
    await runQueuedGenerationJobs(4);
  });
});
