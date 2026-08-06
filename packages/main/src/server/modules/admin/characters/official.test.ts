// SPEC: 官方角色 CMS 服务层回归（Feature A）。直接调用 handler（dispatch 由编排者统一接线），
//       覆盖：权限 403、创建成功 source=official+status=approved、age<18 zod 拒、moderation blocked→403、
//       update 非 official 角色 404。
// INVARIANTS: dev auth headers（x-idream-user-id/role）仅因 APP_ENV=test 生效。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { prisma } from "@/server/lib/db";
import { env } from "@/server/lib/env";
import { AppError } from "@/server/lib/errors";
import {
  createCharacter,
  createMedia,
  createUser,
  purgeTestData,
} from "@/server/test/helpers";
import {
  characterReleaseSnapshotHash,
  characterVisualProfileSnapshotHash,
  referenceSetSnapshotHash,
} from "@/server/modules/admin-v2/characters/release-snapshot";
import { CHARACTER_RELEASE_POLICY_VERSION } from "@/server/modules/admin-v2/characters/release-executor";
import { canonicalSha256 } from "@/server/modules/admin-v2/shared/canonical-json";
import {
  createOfficialCharacter,
  listOfficialCharacters,
  setOfficialState,
  updateOfficialCharacter,
} from "./official";

const P = "zt-official-";
const createdOfficialCharacterIds = new Set<string>();

type CallResult = {
  status: number;
  ok: boolean;
  data: Record<string, unknown> | undefined;
  errorCode: string | undefined;
  errorDetails: unknown;
};

function makeRequest(
  method: string,
  path: string,
  opts: { userId: string; role: string; body?: unknown },
): Request {
  const headers: Record<string, string> = {
    "x-idream-user-id": opts.userId,
    "x-idream-role": opts.role,
  };
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  if (method === "POST") headers["idempotency-key"] = crypto.randomUUID();
  return new Request(`http://localhost/api/v1/admin/content/official${path}`, {
    method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
}

// 直调 handler：成功回 Response，失败抛 AppError/ZodError —— 统一归一成 CallResult。
async function call(handler: Promise<Response>): Promise<CallResult> {
  try {
    const res = await handler;
    const text = await res.text();
    const json = text
      ? (JSON.parse(text) as { ok?: boolean; data?: Record<string, unknown> })
      : null;
    const character = json?.data?.character;
    if (
      character &&
      typeof character === "object" &&
      "id" in character &&
      typeof character.id === "string"
    ) {
      createdOfficialCharacterIds.add(character.id);
    }
    return {
      status: res.status,
      ok: Boolean(json?.ok),
      data: json?.data,
      errorCode: undefined,
      errorDetails: undefined,
    };
  } catch (error) {
    if (error instanceof AppError) {
      return {
        status: error.status,
        ok: false,
        data: undefined,
        errorCode: error.code,
        errorDetails: error.details,
      };
    }
    if (error instanceof ZodError) {
      return {
        status: 400,
        ok: false,
        data: undefined,
        errorCode: "bad_request",
        errorDetails: error.issues,
      };
    }
    throw error;
  }
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
      createOfficialCharacter(
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
      listOfficialCharacters(
        makeRequest("GET", "", { userId: ops, role: "ops" }),
      ),
    );
    expect(listResult.status).toBe(403);
  });

  it("creates an official character as a private draft with source=official", async () => {
    const admin = await seedActor("admin", "create");
    const result = await call(
      createOfficialCharacter(
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
      source: string;
      status: string;
      visibility: string;
      systemPrompt: string | null;
      tags: { tag: { slug: string } }[];
      visualProfiles: {
        id: string;
        version: number;
        status: string;
        createdFrom: string;
      }[];
    };
    expect(character.source).toBe("official");
    expect(character.status).toBe("draft");
    expect(character.visibility).toBe("private");
    expect(character.systemPrompt).toBeTruthy();
    expect(character.visualProfiles).toHaveLength(0);
    // 去重 + slug：Bubbly 只连一次，"Sci Fi" → "sci-fi"。
    const slugs = character.tags.map((t) => t.tag.slug).sort();
    expect(slugs).toEqual(["bubbly", "sci-fi"]);

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
      listOfficialCharacters(
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
      createOfficialCharacter(
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
      updateOfficialCharacter(
        makeRequest("PATCH", `/${id}`, {
          userId: admin,
          role: "admin",
          body: {
            description:
              "An official companion with silver hair and amber eyes.",
            reason: "refresh visual identity",
          },
        }),
        id,
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
      createOfficialCharacter(
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
      createOfficialCharacter(
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
      updateOfficialCharacter(
        makeRequest("PATCH", `/${userChar}`, {
          userId: admin,
          role: "admin",
          body: {
            description: "trying to hijack a user character",
            reason: "should 404",
          },
        }),
        userChar,
      ),
    );
    expect(result.status).toBe(404);
    expect(result.errorCode).toBe("not_found");

    // setState 同样 404。
    const stateResult = await call(
      setOfficialState(
        makeRequest("POST", `/${userChar}/state`, {
          userId: admin,
          role: "admin",
          body: { status: "archived", reason: "should 404" },
        }),
        userChar,
      ),
    );
    expect(stateResult.status).toBe(404);
  });

  it("archives then re-publishes an official character and audits each transition", async () => {
    const admin = await seedActor("admin", "publish");
    const created = await call(
      createOfficialCharacter(
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
      setOfficialState(
        makeRequest("POST", `/${id}/state`, {
          userId: admin,
          role: "admin",
          body: {
            status: "approved",
            reason: "should not release incomplete draft",
          },
        }),
        id,
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
    await updateOfficialCharacter(
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
      id,
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
      setOfficialState(
        makeRequest("POST", `/${id}/state`, {
          userId: admin,
          role: "admin",
          body: { status: "approved", reason: "ready for first release" },
        }),
        id,
      ),
    );
    expect(published.ok, JSON.stringify(published.errorDetails)).toBe(true);
    expect(published.data?.character).toMatchObject({
      status: "approved",
      visibility: "public",
    });

    // approved -> archived (disappears from public feed)
    const archived = await call(
      setOfficialState(
        makeRequest("POST", `/${id}/state`, {
          userId: admin,
          role: "admin",
          body: { status: "archived", reason: "take offline for QA" },
        }),
        id,
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
      setOfficialState(
        makeRequest("POST", `/${id}/state`, {
          userId: admin,
          role: "admin",
          body: {
            status: "approved",
            reason: "resume the pinned release snapshot",
          },
        }),
        id,
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
