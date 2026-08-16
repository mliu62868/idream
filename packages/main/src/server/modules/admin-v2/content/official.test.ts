// SPEC: 官方角色 CMS 回归。经 Admin v2 Route Handler 驱动 list / create / update / state，
//       覆盖：权限 403、创建成功 source=official+status=draft、age<18 契约拒、moderation blocked→403、
//       update 非 official 角色 404、state 发布 / 暂停 / 恢复。
// INVARIANTS: dev auth headers（x-idream-user-id/role）仅因 APP_ENV=test 生效。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";
import { env } from "@/server/lib/env";
import {
  createCharacter,
  createMedia,
  createUser,
  purgeTestData,
} from "@/server/test/helpers";
import { characterSoulQaEvidence } from "@/server/test/character-soul-evidence";
import {
  characterReleaseSnapshotHash,
  characterVisualProfileSnapshotHash,
  referenceSetSnapshotHash,
} from "@/server/modules/admin-v2/characters/release-snapshot";
import { CHARACTER_RELEASE_POLICY_VERSION } from "@/server/modules/admin-v2/characters/release-validation";
import { canonicalSha256 } from "@/server/modules/admin-v2/shared/canonical-json";
import { adminV2 as adminV2Api, type AdminV2Result as AdminV2ApiResult } from "@/server/test/admin-v2-http";

const P = "zt-official-";
const createdOfficialCharacterIds = new Set<string>();

type CallResult = {
  status: number;
  ok: boolean;
  data: Record<string, unknown> | undefined;
  errorCode: string | undefined;
  errorDetails: unknown;
};

type OfficialCall = {
  method: "GET" | "POST" | "PATCH";
  path: string;
  opts: { userId: string; role: string; body?: unknown };
};

function makeRequest(
  method: OfficialCall["method"],
  path: string,
  opts: { userId: string; role: string; body?: unknown },
): OfficialCall {
  return { method, path: `/api/v2/admin/content/official${path}`, opts };
}

function officialApi(call: OfficialCall) {
  return adminV2Api(call.method, call.path, call.opts);
}

async function call(pending: Promise<AdminV2ApiResult>): Promise<CallResult> {
  const response = await pending;
  const character = response.data?.character;
  if (
    character &&
    typeof character === "object" &&
    "id" in character &&
    typeof character.id === "string"
  ) {
    createdOfficialCharacterIds.add(character.id);
  }
  return {
    status: response.status,
    ok: response.ok,
    data: response.data,
    errorCode: response.error?.code,
    errorDetails: response.error?.details,
  };
}

beforeAll(async () => {
  await purgeTestData(P);
});

afterAll(async () => {
  for (const id of createdOfficialCharacterIds) {
    await purgeTestData(id);
  }
  await purgeTestData(P);
  await prisma.$disconnect();
});

async function seedActor(role: "admin" | "ops", suffix: string) {
  const id = `${P}${role}-${suffix}`;
  await createUser({ id, role });
  return id;
}

describe("official character CMS", () => {
  it("gates every handler behind content.official.write (403 for ops)", async () => {
    const ops = await seedActor("ops", "gate");
    const result = await call(
      officialApi(
        makeRequest("POST", "", {
          userId: ops,
          role: "ops",
          body: {
            name: `${P}Nope`,
            age: 24,
            gender: "female",
            style: "realistic",
            description: "should not be created",
            reason: "blocked by permission",
          },
        }),
      ),
    );
    expect(result.status).toBe(403);
    expect(result.errorCode).toBe("forbidden");

    const listResult = await call(
      officialApi(
        makeRequest("GET", "", { userId: ops, role: "ops" }),
      ),
    );
    expect(listResult.status).toBe(403);
  });

  it("creates an official character as a private draft with source=official", async () => {
    const admin = await seedActor("admin", "create");
    const result = await call(
      officialApi(
        makeRequest("POST", "", {
          userId: admin,
          role: "admin",
          body: {
            name: `${P}Aria`,
            age: 27,
            gender: "female",
            style: "anime",
            description: "A cheerful official companion.",
            tags: ["Bubbly", "Bubbly", "Sci Fi"],
            reason: "seed official roster",
          },
        }),
      ),
    );
    expect(result.ok).toBe(true);
    const character = result.data?.character as {
      id: string;
      status: string;
      visibility: string;
      tags: string[];
      visualProfile: { id: string; version: number } | null;
    };
    expect(character.status).toBe("draft");
    expect(character.visibility).toBe("private");
    expect(character.visualProfile).toBeNull();
    // `source` 与 systemPrompt 不在 CMS 契约里 —— 它们是内部权威，直接对库断言。
    await expect(prisma.character.findUniqueOrThrow({
      where: { id: character.id },
      select: { source: true },
    })).resolves.toEqual({ source: "official" });
    await expect(prisma.character.findUniqueOrThrow({
      where: { id: character.id },
      select: { systemPrompt: true },
    })).resolves.not.toEqual({ systemPrompt: null });
    // 去重 + slug：Bubbly 只连一次，"Sci Fi" → "sci-fi"。
    const links = await prisma.characterTag.findMany({
      where: { characterId: character.id },
      include: { tag: { select: { slug: true } } },
    });
    expect(links.map((link) => link.tag.slug).sort()).toEqual(["bubbly", "sci-fi"]);

    const audit = await prisma.adminAuditLog.findFirst({
      where: { action: "character.project.created" },
    });
    expect(audit).not.toBeNull();
    const project = await prisma.characterProject.findFirstOrThrow({ where: { characterId: character.id } });
    expect(await prisma.characterProject.count({ where: { characterId: character.id } })).toBe(1);
    expect(await prisma.characterContentVersion.count({ where: { characterId: character.id } })).toBe(1);
    expect(await prisma.characterRevision.count({ where: { projectId: project.id } })).toBe(1);
    expect(await prisma.characterServing.count({ where: { characterId: character.id } })).toBe(1);

    // 出现在 list 中。
    const listResult = await call(
      officialApi(
        makeRequest("GET", "?search=Aria", { userId: admin, role: "admin" }),
      ),
    );
    const items = (listResult.data?.items ?? []) as {
      id: string;
      visualProfile: { version: number; status: string } | null;
    }[];
    const listed = items.find((c) => c.id === character.id);
    expect(listed?.visualProfile).toBeNull();
  });

  it("versions immutable draft content without fabricating a qualified Visual Identity", async () => {
    const admin = await seedActor("admin", "visual-version");
    const created = await call(
      officialApi(
        makeRequest("POST", "", {
          userId: admin,
          role: "admin",
          body: {
            name: `${P}Versioned`,
            age: 28,
            gender: "female",
            style: "realistic",
            description: "An official companion with silver hair.",
            reason: "seed visual profile",
          },
        }),
      ),
    );
    const id = (created.data?.character as { id: string }).id;

    const updated = await call(
      officialApi(
        makeRequest("PATCH", `/${id}`, {
          userId: admin,
          role: "admin",
          body: {
            description:
              "An official companion with silver hair and amber eyes.",
            reason: "refresh visual identity",
          },
        }),
      ),
    );
    expect(updated.ok).toBe(true);

    const project = await prisma.characterProject.findFirstOrThrow({ where: { characterId: id } });
    expect(await prisma.characterContentVersion.count({ where: { characterId: id } })).toBe(2);
    expect(await prisma.characterRevision.count({ where: { projectId: project.id } })).toBe(2);
    expect(await prisma.characterVisualProfile.count({ where: { characterId: id } })).toBe(0);
    const latest = await prisma.characterContentVersion.findFirstOrThrow({
      where: { characterId: id },
      orderBy: { version: "desc" },
    });
    expect(latest.personaSnapshot).toMatchObject({
      soul: {
        identity: {
          characterPromise: "An official companion with silver hair and amber eyes.",
        },
      },
    });
  });

  it("rejects age < 18 at the zod boundary (400)", async () => {
    const admin = await seedActor("admin", "underage");
    const result = await call(
      officialApi(
        makeRequest("POST", "", {
          userId: admin,
          role: "admin",
          body: {
            name: `${P}TooYoung`,
            age: 17,
            gender: "female",
            style: "realistic",
            description: "must be rejected",
            reason: "age boundary",
          },
        }),
      ),
    );
    expect(result.status).toBe(400);
    expect(result.errorCode).toBe("bad_request");
  });

  it("blocks moderation-flagged content (403)", async () => {
    const admin = await seedActor("admin", "moderation");
    const result = await call(
      officialApi(
        makeRequest("POST", "", {
          userId: admin,
          role: "admin",
          body: {
            name: `${P}Bad`,
            age: 24,
            gender: "female",
            style: "realistic",
            // mock moderation 命中 "underage" 关键词 → blocked。
            description: "this description references underage content",
            reason: "should be blocked",
          },
        }),
      ),
    );
    expect(result.status).toBe(403);
    expect(result.errorCode).toBe("forbidden");
  });

  it("returns 404 when updating a non-official (user) character", async () => {
    const admin = await seedActor("admin", "update404");
    const userChar = `${P}user-char`;
    await createCharacter({
      id: userChar,
      source: "user",
      name: "User Character",
      visibility: "public",
      status: "approved",
    });

    const result = await call(
      officialApi(
        makeRequest("PATCH", `/${userChar}`, {
          userId: admin,
          role: "admin",
          body: {
            description: "trying to hijack a user character",
            reason: "should 404",
          },
        }),
      ),
    );
    expect(result.status).toBe(404);
    expect(result.errorCode).toBe("not_found");

    // setState 同样 404。
    const stateResult = await call(
      officialApi(
        makeRequest("POST", `/${userChar}/state`, {
          userId: admin,
          role: "admin",
          body: { status: "archived", reason: "should 404" },
        }),
      ),
    );
    expect(stateResult.status).toBe(404);
  });

  it("archives then re-publishes an official character and audits each transition", async () => {
    const admin = await seedActor("admin", "publish");
    const created = await call(
      officialApi(
        makeRequest("POST", "", {
          userId: admin,
          role: "admin",
          body: {
            name: `${P}Toggle`,
            age: 26,
            gender: "female",
            style: "realistic",
            description:
              "An official companion used to verify publish/archive.",
            reason: "seed for state toggle",
          },
        }),
      ),
    );
    const id = (created.data?.character as { id: string }).id;

    const incomplete = await call(
      officialApi(
        makeRequest("POST", `/${id}/state`, {
          userId: admin,
          role: "admin",
          body: {
            status: "approved",
            reason: "should not release incomplete draft",
          },
        }),
      ),
    );
    expect(incomplete.status).toBe(400);

    const referenceMedia = await createMedia({
      id: `${P}release-reference-media`,
      ownerId: admin,
      visibility: "public",
    });
    const releaseAssetFixtures = [
      {
        slotKey: "character_avatar",
        purpose: "character_cover",
        assetId: `${P}release-cover-media`,
        runId: `${P}release-cover-run`,
        itemId: `${P}release-cover-item`,
        jobId: `${P}release-cover-job`,
        decisionId: `${P}release-cover-decision`,
      },
      {
        slotKey: "character_hero",
        purpose: "character_hero",
        assetId: `${P}release-hero-media`,
        runId: `${P}release-hero-run`,
        itemId: `${P}release-hero-item`,
        jobId: `${P}release-hero-job`,
        decisionId: `${P}release-hero-decision`,
      },
      {
        slotKey: "character_chat",
        purpose: "character_chat",
        assetId: `${P}release-chat-media`,
        runId: `${P}release-chat-run`,
        itemId: `${P}release-chat-item`,
        jobId: `${P}release-chat-job`,
        decisionId: `${P}release-chat-decision`,
      },
    ] as const;
    for (const fixture of releaseAssetFixtures) {
      await createMedia({
        id: fixture.assetId,
        ownerId: admin,
        visibility: "private",
      });
    }
    await prisma.mediaAsset.updateMany({
      where: {
        id: {
          in: [
            referenceMedia.id,
            ...releaseAssetFixtures.map((fixture) => fixture.assetId),
          ],
        },
      },
      data: { characterId: id, safetyStatus: "passed" },
    });
    await officialApi(
      makeRequest("PATCH", `/${id}`, {
        userId: admin,
        role: "admin",
        body: {
          appearance: {
            identityAnchor: "Warm cinematic portrait with a stable silhouette.",
            stableTraits: ["stable silhouette", "warm portrait lighting"],
            referenceDirection: "Canonical front-facing identity reference",
          },
          advancedDetails: {
            personality: "composed, observant",
            relationshipArchetype: "trusted confidante",
            values: ["honesty"],
            wants: ["build mutual trust"],
            fears: ["breaking a confidence"],
            contradictions: ["careful but spontaneously playful"],
            backstory: "She learned dependable companionship through years of community work.",
            tone: "Warm and concise.",
            cadence: "Measured sentences with occasional dry humor.",
            vocabulary: ["grounded", "specific"],
            voiceHabits: ["asks one focused follow-up"],
            voiceAvoid: ["generic reassurance"],
            interaction: {
              initiative: "Offer a concrete next step.",
              curiosity: "Ask about motives, not just events.",
              pacing: "Let emotional turns breathe.",
              affection: "Show care through attentive recall.",
              conflict: "Name disagreement without escalating.",
              repair: "Acknowledge impact and propose repair.",
            },
            canon: {
              facts: ["She works with local community groups."],
              unknowns: ["The user's private history unless disclosed."],
            },
            firstMessage: "You made it. Sit down and tell me what happened.",
            exampleDialogue: ["I hear the decision. What part feels hardest to carry?"],
            negativeDialogue: [{
              assistant: "Everything will be fine.",
              reason: "Generic reassurance ignores the user's actual concern.",
            }],
            visualBrief: "Warm cinematic portrait with a stable silhouette.",
          },
          reason: "complete release fields",
        },
      }),
    );
    const activeProfile = await prisma.characterVisualProfile.create({
      data: {
        characterId: id,
        version: 1,
        status: "active",
        style: "realistic",
        identityPrompt: "Warm cinematic portrait with a stable silhouette.",
        faceTraits: {},
        hairTraits: {},
        bodyTraits: {},
        signatureTraits: {},
        styleTraits: {},
        anchorAssetIds: [referenceMedia.id],
        adapterRefs: {},
        createdFrom: "test_qualified_identity",
        evidenceState: "qualified",
      },
    });
    const visualProfileHash = characterVisualProfileSnapshotHash(activeProfile);
    await prisma.characterVisualProfile.update({
      where: { id: activeProfile.id },
      data: {
        anchorAssetIds: [referenceMedia.id],
        immutableHash: visualProfileHash,
        evidenceState: "qualified",
      },
    });
    await prisma.character.update({
      where: { id },
      data: { imageAssetId: referenceMedia.id },
    });

    const project = await prisma.characterProject.findFirstOrThrow({ where: { characterId: id } });
    const revision = await prisma.characterRevision.findFirstOrThrow({
      where: { projectId: project.id },
      orderBy: { revision: "desc" },
    });
    const contentVersion = await prisma.characterContentVersion.findUniqueOrThrow({
      where: { id: revision.characterContentVersionId },
    });
    const soulQaEvidence = characterSoulQaEvidence({
      characterContentVersionId: contentVersion.id,
      personaSnapshot: contentVersion.personaSnapshot,
    });
    const referenceSetHash = referenceSetSnapshotHash({
      visualProfileId: activeProfile.id,
      revision: 1,
      selectorVersion: "v2",
      references: [
        {
          mediaAssetId: referenceMedia.id,
          position: 0,
          role: "primary_face",
          weight: 1,
        },
      ],
    });
    const referenceSet = await prisma.referenceSetRevision.create({
      data: {
        id: `${P}publish-reference-set`,
        visualProfileId: activeProfile.id,
        revision: 1,
        status: "active",
        selectorVersion: "v2",
        snapshotHash: referenceSetHash,
        createdFrom: "test",
        references: {
          create: {
            mediaAssetId: referenceMedia.id,
            position: 0,
            role: "primary_face",
            selectionReason: "test evidence",
          },
        },
      },
    });
    const routeFingerprint = `${P}publish-route`;
    const generationProfileKey = `${P}publish-profile`;
    const workflowKey = "qwen-image-edit-img2img";
    const qaRunId = `${P}publish-qa-run`;
    const qaEvidenceHash = `${P}publish-qa-evidence`;
    await prisma.generationModelProfile.create({
      data: {
        id: `${P}publish-model-profile`,
        profileKey: generationProfileKey,
        label: "Official publish reference route",
        mode: "image",
        runner: "comfyui",
        pipelineModel: workflowKey,
        workflowKey,
        runnerConfig: {
          capabilities: {
            textToImage: true,
            referenceImages: true,
          },
        },
        allowedOrientations: ["4:5"],
        version: 1,
        status: "active",
        enabled: true,
        rolloutPercent: 100,
      },
    });
    await prisma.generationRouteQualification.create({
      data: {
        routeFingerprint,
        generationProfileKey,
        generationProfileVersion: 1,
        workflowKey,
        workflowVersion: 1,
        style: "realistic",
        matrixKey: "default-character",
        sampleCount: 40,
        passCount: 38,
        identityMatch: 0.95,
        result: "qualified",
        evidence: {
          reviewer: admin,
          evaluatorVersion: env.GENERATION_ROUTE_EVALUATOR_VERSION,
        },
        policyVersion: CHARACTER_RELEASE_POLICY_VERSION,
      },
    });
    const jobReferenceManifest = [{
      mediaAssetId: referenceMedia.id,
      position: 0,
      role: "primary_face",
      weight: 1,
      selectorVersion: "v2",
      selectionReason: "Official publish identity authority",
      referenceSetRevisionId: referenceSet.id,
      referenceSetRevision: 1,
      snapshotHash: referenceSetHash,
    }];
    const referenceManifestHash = canonicalSha256(jobReferenceManifest);
    const draftAssetPack = {
      character_cover: {
        assetId: releaseAssetFixtures[0].assetId,
        runId: releaseAssetFixtures[0].runId,
        itemId: releaseAssetFixtures[0].itemId,
        reviewDecisionId: releaseAssetFixtures[0].decisionId,
        generationJobId: releaseAssetFixtures[0].jobId,
        bootstrapIdentity: false,
      },
      character_hero: {
        assetId: releaseAssetFixtures[1].assetId,
        runId: releaseAssetFixtures[1].runId,
        itemId: releaseAssetFixtures[1].itemId,
        reviewDecisionId: releaseAssetFixtures[1].decisionId,
        generationJobId: releaseAssetFixtures[1].jobId,
        bootstrapIdentity: false,
      },
      character_chat: {
        assetId: releaseAssetFixtures[2].assetId,
        runId: releaseAssetFixtures[2].runId,
        itemId: releaseAssetFixtures[2].itemId,
        reviewDecisionId: releaseAssetFixtures[2].decisionId,
        generationJobId: releaseAssetFixtures[2].jobId,
        bootstrapIdentity: false,
      },
    };
    const draftAssetPackHash = canonicalSha256(draftAssetPack);
    await prisma.characterProject.update({
      where: { id: project.id },
      data: {
        draftImageAssetId: releaseAssetFixtures[0].assetId,
        draftAssetPack,
      },
    });
    for (const fixture of releaseAssetFixtures) {
      await prisma.contentProductionBatch.create({
        data: {
          id: fixture.runId,
          title: fixture.purpose,
          purpose: fixture.purpose,
          targetType: "character",
          targetId: id,
          presetIds: [],
          count: 1,
          totalItems: 1,
          completedItems: 1,
          approvedItems: 1,
          status: "reviewing",
          lifecycleState: "active",
          workflowStage: "placement",
          verificationState: "pending",
          createdById: admin,
        },
      });
      await prisma.contentProductionItem.create({
        data: {
          id: fixture.itemId,
          batchId: fixture.runId,
          mediaAssetId: fixture.assetId,
          itemIndex: 0,
          status: "approved",
          tags: [],
        },
      });
      await prisma.creativeReviewDecision.create({
        data: {
          id: fixture.decisionId,
          runItemId: fixture.itemId,
          artifactId: fixture.assetId,
          decision: "approved",
          identityConsistency: "passed",
          score: 92,
          evidence: {
            artifactFree: true,
            singleSubject: true,
            intentMatch: true,
            noVisibleText: true,
          },
          reason: "Approved official strict Release asset",
          reviewerId: admin,
        },
      });
      await prisma.generationJob.create({
        data: {
          id: fixture.jobId,
          userId: admin,
          characterId: id,
          visualProfileId: activeProfile.id,
          visualProfileVersion: activeProfile.version,
          consistencyMode: "strict",
          referenceAssetIds: [referenceMedia.id],
          referenceSetRevisionId: referenceSet.id,
          referenceManifest: jobReferenceManifest,
          mode: "image",
          controls: {},
          presetIds: [],
          model: workflowKey,
          profileId: generationProfileKey,
          profileVersion: 1,
          orientation: "4:5",
          outputCount: 1,
          deliveredOutputCount: 1,
          status: "completed",
          provider: "comfyui",
          sourceType: "content_production_item",
          sourceId: fixture.itemId,
          sourceMeta: {
            batchId: fixture.runId,
            purpose: fixture.purpose,
            targetType: "character",
            targetId: id,
            bootstrapIdentity: false,
            referenceSetRevisionId: referenceSet.id,
            generationRouteFingerprint: routeFingerprint,
          },
          completedAt: new Date(),
          finishedAt: new Date(),
        },
      });
      await prisma.generationAttempt.create({
        data: {
          id: `${fixture.jobId}-attempt`,
          requestId: fixture.jobId,
          attemptNo: 1,
          provider: "comfyui",
          profileKey: generationProfileKey,
          profileVersion: 1,
          workflowKey,
          workflowVersion: 1,
          status: "succeeded",
          creativeRunItemId: fixture.itemId,
          finishedAt: new Date(),
        },
      });
      await prisma.contentProductionItem.update({
        where: { id: fixture.itemId },
        data: { jobId: fixture.jobId },
      });
      await prisma.mediaAsset.update({
        where: { id: fixture.assetId },
        data: { sourceJobId: fixture.jobId },
      });
    }
    await prisma.characterQaRun.create({
      data: {
        id: qaRunId,
        characterId: id,
        projectId: project.id,
        characterContentVersionId: contentVersion.id,
        projectVersion: project.version,
        visualProfileId: activeProfile.id,
        visualProfileVersion: activeProfile.version,
        visualProfileHash,
        referenceSetRevisionId: referenceSet.id,
        referenceSetRevision: referenceSet.revision,
        referenceSetHash,
        draftAssetPackHash,
        ownerId: admin,
        status: "passed",
        checks: [],
        behaviorEvaluation: soulQaEvidence.behaviorEvaluation,
        liveCanaries: soulQaEvidence.liveCanaries,
        evidenceHash: qaEvidenceHash,
      },
    });
    const generationProvenance = {
      schemaVersion: "character-release-generation-provenance-v2",
      policyVersion: CHARACTER_RELEASE_POLICY_VERSION,
      requiredReleaseRoute: {
        routeFingerprint,
        matrixKey: "default-character",
        generationProfileKey,
        generationProfileVersion: 1,
        workflowKey,
        workflowVersion: 1,
      },
      characterQa: {
        status: "passed",
        qaRunId,
        evidenceHash: qaEvidenceHash,
        characterId: id,
        projectId: project.id,
        characterContentVersionId: contentVersion.id,
        projectVersion: project.version,
        visualProfileId: activeProfile.id,
        visualProfileVersion: activeProfile.version,
        visualProfileHash,
        referenceSetRevisionId: referenceSet.id,
        referenceSetRevision: referenceSet.revision,
        referenceSetHash,
        draftAssetPackHash,
      },
      placements: releaseAssetFixtures.map((fixture) => ({
        slotKey: fixture.slotKey,
        assetId: fixture.assetId,
        generationJobId: fixture.jobId,
        attemptId: `${fixture.jobId}-attempt`,
        attemptNo: 1,
        provider: "comfyui",
        generationProfileKey,
        generationProfileVersion: 1,
        workflowKey,
        workflowVersion: 1,
        visualProfileId: activeProfile.id,
        visualProfileVersion: activeProfile.version,
        referenceSetRevisionId: referenceSet.id,
        referenceManifestHash,
        bootstrapIdentity: false,
      })),
    };
    const releasePlacementManifest = {
      schemaVersion: 2,
      placements: releaseAssetFixtures.map((fixture) => ({
        slotKey: fixture.slotKey,
        slotVersion: 1,
        assetId: fixture.assetId,
        runId: fixture.runId,
        itemId: fixture.itemId,
        reviewDecisionId: fixture.decisionId,
        generationJobId: fixture.jobId,
        bootstrapIdentity: false,
      })),
    };
    const releaseSnapshot = {
      projectId: project.id,
      revisionId: revision.id,
      characterContentVersionId: contentVersion.id,
      visualProfileId: activeProfile.id,
      visualProfileVersion: activeProfile.version,
      referenceSetRevisionId: referenceSet.id,
      generationProvenance,
      releasePlacementManifest,
    };
    const release = await prisma.characterRelease.create({
      data: {
        id: `${P}publish-release`,
        ...releaseSnapshot,
        snapshotHash: characterReleaseSnapshotHash(releaseSnapshot),
        status: "approved",
        readiness: "ready",
        legacy: false,
      },
    });
    await prisma.characterServing.update({
      where: { characterId: id },
      data: {
        state: "inactive",
        scheduledReleaseId: release.id,
        scheduledAt: new Date(),
      },
    });

    // draft -> approved (first public release)
    const published = await call(
      officialApi(
        makeRequest("POST", `/${id}/state`, {
          userId: admin,
          role: "admin",
          body: { status: "approved", reason: "ready for first release" },
        }),
      ),
    );
    expect(published.ok, JSON.stringify(published.errorDetails)).toBe(true);
    expect(published.data?.character).toMatchObject({
      status: "approved",
      visibility: "public",
    });

    // approved -> archived (disappears from public feed)
    const archived = await call(
      officialApi(
        makeRequest("POST", `/${id}/state`, {
          userId: admin,
          role: "admin",
          body: { status: "archived", reason: "take offline for QA" },
        }),
      ),
    );
    expect(archived.ok).toBe(true);
    expect((archived.data?.character as { status: string }).status).toBe(
      "archived",
    );

    await prisma.character.update({
      where: { id },
      data: { imageAssetId: null },
    });
    const resumedFromAuthority = await call(
      officialApi(
        makeRequest("POST", `/${id}/state`, {
          userId: admin,
          role: "admin",
          body: {
            status: "approved",
            reason: "resume the pinned release snapshot",
          },
        }),
      ),
    );
    expect(resumedFromAuthority.ok).toBe(true);
    expect(
      (resumedFromAuthority.data?.character as { status: string }).status,
    ).toBe("approved");
    expect(
      (await prisma.character.findUniqueOrThrow({ where: { id } }))
        .imageAssetId,
    ).toBe(releaseAssetFixtures[0].assetId);

    const audits = await prisma.adminAuditLog.count({
      where: {
        actorId: admin,
        action: {
          in: [
            "character.release.publish.executed",
            "character.serving.pause.executed",
            "character.serving.resume.executed",
          ],
        },
      },
    });
    expect(audits).toBe(3);
  });
});
