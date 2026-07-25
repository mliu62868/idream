// SPEC: Visual Passport 编辑器（P2 Task 8）后端回归。覆盖：权限拆分（content.read 可读 list，
//       content.official.write 才能创建新版本）、list 按 version desc 且字段形状与契约一致、
//       未知 character → 404（list + create）、reason<3 → 400、confirmation 不匹配 → 400、
//       create 归档旧 active 并铸 v(prev+1) active + 写审计、无 active 时从 character.imageAssetId
//       兜底 anchorAssetIds（bootstrap 分支）。
// INVARIANTS: dev-auth 头（x-idream-user-id/role）仅在 APP_ENV=test 生效；前缀 P 隔离测试数据。
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { prisma } from "@/server/lib/db";
import { AppError } from "@/server/lib/errors";
import { traitsHashOf } from "@/server/modules/ourdream/identity-assembler";
import { createCharacter, createMedia, createUser, purgeTestData } from "@/server/test/helpers";
import { createCharacterVisualProfile, listCharacterVisualProfiles } from "./visual-profiles";

const P = "zt-vprofile-";

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
  opts: { userId: string; role: string; body?: unknown; idempotencyKey?: string },
): Request {
  const headers: Record<string, string> = {
    "x-idream-user-id": opts.userId,
    "x-idream-role": opts.role,
    "x-request-id": crypto.randomUUID(),
  };
  if (method === "POST") headers["idempotency-key"] = opts.idempotencyKey ?? crypto.randomUUID();
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  return new Request(`http://localhost/api/v1/admin/content/characters${path}`, {
    method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
}

// 直调 handler：成功回 Response，失败抛 AppError/ZodError —— 统一归一成 CallResult（镜像 official.test.ts）。
async function call(handler: Promise<Response>): Promise<CallResult> {
  try {
    const res = await handler;
    const text = await res.text();
    const json = text ? (JSON.parse(text) as { ok?: boolean; data?: Record<string, unknown> }) : null;
    return { status: res.status, ok: Boolean(json?.ok), data: json?.data, errorCode: undefined, errorDetails: undefined };
  } catch (error) {
    if (error instanceof AppError) {
      return { status: error.status, ok: false, data: undefined, errorCode: error.code, errorDetails: error.details };
    }
    if (error instanceof ZodError) {
      return { status: 400, ok: false, data: undefined, errorCode: "bad_request", errorDetails: undefined };
    }
    throw error;
  }
}

beforeAll(async () => {
  await purgeTestData(P);
});

afterAll(async () => {
  await purgeTestData(P);
  await prisma.$disconnect();
});

async function seedActor(role: "admin" | "support", suffix: string) {
  const id = `${P}${role}-${suffix}`;
  await createUser({ id, role });
  return id;
}

function confirmationFor(characterId: string) {
  return `${characterId}:visual-profile`;
}

async function seedVisualProfile(input: {
  characterId: string;
  version: number;
  status: "draft" | "active" | "archived";
  identityPrompt?: string;
  anchorAssetIds?: string[];
  referenceAssetIds?: string[];
}) {
  return prisma.characterVisualProfile.create({
    data: {
      characterId: input.characterId,
      version: input.version,
      status: input.status,
      style: "realistic",
      identityPrompt: input.identityPrompt ?? `identity v${input.version}`,
      negativeIdentityPrompt: "generic negative prompt",
      faceTraits: { eyes: "green" },
      hairTraits: { color: "black" },
      bodyTraits: {},
      signatureTraits: {},
      styleTraits: {},
      anchorAssetIds: input.anchorAssetIds ?? [],
      referenceAssetIds: input.referenceAssetIds ?? [],
      defaultSeed: `seed-v${input.version}`,
      adapterRefs: {},
      createdFrom: "seed",
    },
  });
}

describe("Visual Passport (character visual profiles)", () => {
  it("content.read can list versions; content.official.write is required to create one", async () => {
    const support = await seedActor("support", "permsplit");
    const characterId = `${P}char-permsplit`;
    await createCharacter({ id: characterId, name: "Perm Split" });

    const listResult = await call(
      listCharacterVisualProfiles(
        makeRequest("GET", `/${characterId}/visual-profiles`, { userId: support, role: "support" }),
        characterId,
      ),
    );
    expect(listResult.status).toBe(200);
    expect(listResult.data?.items).toEqual([]);

    const createResult = await call(
      createCharacterVisualProfile(
        makeRequest("POST", `/${characterId}/visual-profiles`, {
          userId: support,
          role: "support",
          body: {
            identityPrompt: "should not be created",
            reason: "should be blocked by permission",
            confirmation: confirmationFor(characterId),
          },
        }),
        characterId,
      ),
    );
    expect(createResult.status).toBe(403);
    expect(createResult.errorCode).toBe("forbidden");
  });

  it("rejects creating an unanchored first identity and routes the operator to Character Assets", async () => {
    const admin = await seedActor("admin", "unanchored-first-version");
    const characterId = `${P}char-unanchored-first-version`;
    await createCharacter({ id: characterId, name: "Needs reviewed portrait" });

    const result = await call(
      createCharacterVisualProfile(
        makeRequest("POST", `/${characterId}/visual-profiles`, {
          userId: admin,
          role: "admin",
          body: {
            identityPrompt: "text alone cannot establish image authority",
            reason: "attempt unanchored identity",
            confirmation: confirmationFor(characterId),
          },
        }),
        characterId,
      ),
    );

    expect(result.status).toBe(409);
    expect(result.errorDetails).toMatchObject({
      deepLink: `/admin/characters/${characterId}?tab=assets`,
    });
    expect(await prisma.characterVisualProfile.count({ where: { characterId } })).toBe(0);
  });

  it("lists versions in desc order with the documented field shape", async () => {
    const admin = await seedActor("admin", "list");
    const characterId = `${P}char-list`;
    await createCharacter({ id: characterId, name: "List Target" });
    await seedVisualProfile({ characterId, version: 1, status: "archived", identityPrompt: "v1 prompt" });
    await seedVisualProfile({ characterId, version: 2, status: "active", identityPrompt: "v2 prompt" });

    const result = await call(
      listCharacterVisualProfiles(
        makeRequest("GET", `/${characterId}/visual-profiles`, { userId: admin, role: "admin" }),
        characterId,
      ),
    );
    expect(result.status).toBe(200);
    const items = result.data?.items as Array<Record<string, unknown>>;
    expect(items.map((item) => item.version)).toEqual([2, 1]);
    expect(items[0]).toMatchObject({ status: "active", identityPrompt: "v2 prompt" });
    expect(items[1]).toMatchObject({ status: "archived", identityPrompt: "v1 prompt" });
    expect(Object.keys(items[0]).sort()).toEqual(
      [
        "id",
        "version",
        "status",
        "style",
        "identityPrompt",
        "negativeIdentityPrompt",
        "faceTraits",
        "hairTraits",
        "bodyTraits",
        "signatureTraits",
        "styleTraits",
        "defaultSeed",
        "anchorAssetIds",
        "referenceAssetIds",
        "qualityScore",
        "consistencyScore",
        "createdFrom",
        "createdAt",
        "identitySource",
        "identityStale",
      ].sort(),
    );
    // adapterRefs 有意不在响应里 —— 面板不展示生成模型接线细节（LoRA/adapter）。
    expect(items[0]).not.toHaveProperty("adapterRefs");
    // seedVisualProfile 写的是恒 {} 的 adapterRefs（无 identity 标记）——视为 manual、恒不 stale。
    expect(items[0]).toMatchObject({ identitySource: "manual", identityStale: false });
  });

  it("keeps an active identity with no anchors, evidence, or scores explicitly incomplete", async () => {
    const admin = await seedActor("admin", "active-empty-evidence");
    const characterId = `${P}char-active-empty-evidence`;
    await createCharacter({ id: characterId, name: "Incomplete Active Identity" });
    await seedVisualProfile({
      characterId,
      version: 1,
      status: "active",
      anchorAssetIds: [],
      referenceAssetIds: [],
    });

    const result = await call(
      listCharacterVisualProfiles(
        makeRequest("GET", `/${characterId}/visual-profiles`, { userId: admin, role: "admin" }),
        characterId,
      ),
    );
    const items = result.data?.items as Array<Record<string, unknown>>;
    expect(items).toEqual([
      expect.objectContaining({
        status: "active",
        anchorAssetIds: [],
        referenceAssetIds: [],
        qualityScore: null,
        consistencyScore: null,
      }),
    ]);
  });

  it("404s listing versions for an unknown character", async () => {
    const admin = await seedActor("admin", "list404");
    const missingId = `${P}char-missing-list`;
    const result = await call(
      listCharacterVisualProfiles(
        makeRequest("GET", `/${missingId}/visual-profiles`, { userId: admin, role: "admin" }),
        missingId,
      ),
    );
    expect(result.status).toBe(404);
    expect(result.errorCode).toBe("not_found");
  });

  it("creates version 1 seeded from character.imageAssetId when no profile exists yet", async () => {
    const admin = await seedActor("admin", "bootstrap");
    const characterId = `${P}char-bootstrap`;
    const imageAssetId = `${P}image-bootstrap`;
    await createMedia({ id: imageAssetId, ownerId: admin });
    await createCharacter({ id: characterId, name: "Bootstrap Target", imageAssetId });

    const result = await call(
      createCharacterVisualProfile(
        makeRequest("POST", `/${characterId}/visual-profiles`, {
          userId: admin,
          role: "admin",
          body: {
            identityPrompt: "hand-authored identity prompt",
            reason: "bootstrap passport",
            confirmation: confirmationFor(characterId),
          },
        }),
        characterId,
      ),
    );
    expect(result.ok).toBe(true);
    const item = result.data?.item as {
      version: number;
      status: string;
      identityPrompt: string;
      anchorAssetIds: string[];
    };
    expect(item.version).toBe(1);
    expect(item.status).toBe("active");
    expect(item.identityPrompt).toBe("hand-authored identity prompt");
    expect(item.anchorAssetIds).toEqual([imageAssetId]);
    await expect(prisma.mediaAsset.findUniqueOrThrow({ where: { id: imageAssetId } })).resolves.toMatchObject({
      characterId,
    });

    const audit = await prisma.adminAuditLog.findFirst({
      where: { action: "content.visual_profile.create", targetId: characterId },
    });
    expect(audit).not.toBeNull();
    expect(audit?.reason).toBe("bootstrap passport");
  });

  it("rejects a shared legacy Character image instead of claiming ambiguous identity authority", async () => {
    const admin = await seedActor("admin", "shared-bootstrap");
    const characterId = `${P}char-shared-bootstrap-a`;
    const otherCharacterId = `${P}char-shared-bootstrap-b`;
    const imageAssetId = `${P}image-shared-bootstrap`;
    await createMedia({ id: imageAssetId, ownerId: admin });
    await createCharacter({ id: characterId, name: "Shared A", imageAssetId });
    await createCharacter({ id: otherCharacterId, name: "Shared B", imageAssetId });

    const result = await call(createCharacterVisualProfile(
      makeRequest("POST", `/${characterId}/visual-profiles`, {
        userId: admin,
        role: "admin",
        body: {
          identityPrompt: "ambiguous shared identity",
          reason: "attempt shared legacy repair",
          confirmation: confirmationFor(characterId),
        },
      }),
      characterId,
    ));

    expect(result.status).toBe(409);
    expect(result.errorDetails).toMatchObject({
      deepLink: `/admin/characters/${characterId}?tab=assets`,
    });
    expect(await prisma.characterVisualProfile.count({ where: { characterId } })).toBe(0);
    await expect(prisma.mediaAsset.findUniqueOrThrow({ where: { id: imageAssetId } })).resolves.toMatchObject({
      characterId: null,
    });
  });

  it("rejects a current image that already belongs to another Character", async () => {
    const admin = await seedActor("admin", "foreign-bootstrap");
    const characterId = `${P}char-foreign-bootstrap-target`;
    const foreignCharacterId = `${P}char-foreign-bootstrap-owner`;
    const imageAssetId = `${P}image-foreign-bootstrap`;
    await createMedia({ id: imageAssetId, ownerId: admin });
    await createCharacter({
      id: foreignCharacterId,
      name: "Foreign identity owner",
    });
    await prisma.mediaAsset.update({
      where: { id: imageAssetId },
      data: { characterId: foreignCharacterId },
    });
    await createCharacter({
      id: characterId,
      name: "Foreign image target",
      imageAssetId,
    });

    const result = await call(createCharacterVisualProfile(
      makeRequest("POST", `/${characterId}/visual-profiles`, {
        userId: admin,
        role: "admin",
        body: {
          identityPrompt: "must not steal foreign identity",
          reason: "reject cross-Character image ownership",
          confirmation: confirmationFor(characterId),
        },
      }),
      characterId,
    ));

    expect(result.status).toBe(409);
    expect(result.errorDetails).toMatchObject({
      assetIds: [imageAssetId],
      deepLink: `/admin/characters/${characterId}?tab=assets`,
    });
    expect(await prisma.characterVisualProfile.count({ where: { characterId } })).toBe(0);
    await expect(prisma.mediaAsset.findUniqueOrThrow({
      where: { id: imageAssetId },
    })).resolves.toMatchObject({ characterId: foreignCharacterId });
  });

  it("waits for Library authority and rejects a current image archived before bootstrap", async () => {
    const admin = await seedActor("admin", "archived-bootstrap");
    const characterId = `${P}char-archived-bootstrap`;
    const imageAssetId = `${P}image-archived-bootstrap`;
    await createMedia({ id: imageAssetId, ownerId: admin });
    await createCharacter({
      id: characterId,
      name: "Archived identity target",
      imageAssetId,
    });

    let createRequest: Promise<CallResult> | undefined;
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`media-asset-authority:${imageAssetId}`}))`;
      await tx.mediaAsset.update({
        where: { id: imageAssetId },
        data: {
          metadata: {
            platformAsset: { status: "archived" },
          },
        },
      });
      const pendingCreate = call(createCharacterVisualProfile(
        makeRequest("POST", `/${characterId}/visual-profiles`, {
          userId: admin,
          role: "admin",
          body: {
            identityPrompt: "must not revive archived media",
            reason: "reject archived identity bootstrap",
            confirmation: confirmationFor(characterId),
          },
        }),
        characterId,
      ));
      createRequest = pendingCreate;
      const state = await Promise.race([
        pendingCreate.then(() => "settled" as const),
        new Promise<"waiting">((resolve) => {
          setTimeout(() => resolve("waiting"), 75);
        }),
      ]);
      expect(state).toBe("waiting");
    });

    expect(createRequest).toBeDefined();
    const result = await createRequest!;
    expect(result.status).toBe(409);
    expect(result.errorDetails).toMatchObject({
      assetIds: [imageAssetId],
      deepLink: `/admin/characters/${characterId}?tab=assets`,
    });
    expect(
      await prisma.characterVisualProfile.count({ where: { characterId } }),
    ).toBe(0);
    await expect(prisma.mediaAsset.findUniqueOrThrow({
      where: { id: imageAssetId },
    })).resolves.toMatchObject({
      characterId: null,
      metadata: {
        platformAsset: { status: "archived" },
      },
    });
  });

  it("repairs an unanchored active profile by carrying forward the current Character image", async () => {
    const admin = await seedActor("admin", "repair-current-image");
    const characterId = `${P}char-repair-current-image`;
    const imageAssetId = `${P}image-repair-current-image`;
    await createMedia({ id: imageAssetId, ownerId: admin });
    await createCharacter({ id: characterId, name: "Repair Current Image", imageAssetId });
    const legacy = await seedVisualProfile({
      characterId,
      version: 1,
      status: "active",
      identityPrompt: "Legacy text-only profile",
      anchorAssetIds: [],
      referenceAssetIds: [],
    });

    const result = await call(
      createCharacterVisualProfile(
        makeRequest("POST", `/${characterId}/visual-profiles`, {
          userId: admin,
          role: "admin",
          body: {
            identityPrompt: "Reviewed identity carried from the current Character image",
            reason: "repair the unanchored legacy identity",
            confirmation: confirmationFor(characterId),
          },
        }),
        characterId,
      ),
    );

    expect(result.ok).toBe(true);
    expect(result.data?.item).toMatchObject({
      version: 2,
      status: "active",
      anchorAssetIds: [imageAssetId],
    });
    await expect(prisma.characterVisualProfile.findUniqueOrThrow({
      where: { id: legacy.id },
    })).resolves.toMatchObject({ status: "archived" });
  });

  it("replays the same visual profile command once and rejects key reuse for another payload", async () => {
    const admin = await seedActor("admin", "idempotency");
    const characterId = `${P}char-idempotency`;
    const imageAssetId = `${P}image-idempotency`;
    const idempotencyKey = `${P}visual-profile-key`;
    await createMedia({ id: imageAssetId, ownerId: admin });
    await createCharacter({ id: characterId, name: "Idempotent Target", imageAssetId });
    const body = {
      identityPrompt: "stable identity authority",
      reason: "create one stable identity version",
      confirmation: confirmationFor(characterId),
    };

    const first = await call(createCharacterVisualProfile(
      makeRequest("POST", `/${characterId}/visual-profiles`, {
        userId: admin,
        role: "admin",
        body,
        idempotencyKey,
      }),
      characterId,
    ));
    const replay = await call(createCharacterVisualProfile(
      makeRequest("POST", `/${characterId}/visual-profiles`, {
        userId: admin,
        role: "admin",
        body,
        idempotencyKey,
      }),
      characterId,
    ));
    const collision = await call(createCharacterVisualProfile(
      makeRequest("POST", `/${characterId}/visual-profiles`, {
        userId: admin,
        role: "admin",
        body: { ...body, identityPrompt: "different identity authority" },
        idempotencyKey,
      }),
      characterId,
    ));

    expect(first.ok).toBe(true);
    expect(first.data?.replayed).toBe(false);
    expect(replay.ok).toBe(true);
    expect(replay.data?.replayed).toBe(true);
    expect(collision.status).toBe(409);
    expect(await prisma.characterVisualProfile.count({ where: { characterId } })).toBe(1);
    expect(await prisma.adminAuditLog.count({
      where: { action: "content.visual_profile.create", targetId: characterId },
    })).toBe(1);
  });

  it("mints v(prev+1) active, archives the prior active, and carries forward unspecified traits/pool", async () => {
    const admin = await seedActor("admin", "version");
    const characterId = `${P}char-version`;
    const anchorAssetId = `${P}anchor-1`;
    const referenceAssetId = `${P}ref-1`;
    await createCharacter({ id: characterId, name: "Version Target" });
    await createMedia({ id: anchorAssetId, ownerId: admin });
    await createMedia({ id: referenceAssetId, ownerId: admin });
    await prisma.mediaAsset.updateMany({
      where: { id: { in: [anchorAssetId, referenceAssetId] } },
      data: { characterId },
    });
    await seedVisualProfile({
      characterId,
      version: 1,
      status: "active",
      identityPrompt: "original identity prompt",
      anchorAssetIds: [anchorAssetId],
      referenceAssetIds: [referenceAssetId],
    });

    const result = await call(
      createCharacterVisualProfile(
        makeRequest("POST", `/${characterId}/visual-profiles`, {
          userId: admin,
          role: "admin",
          body: {
            identityPrompt: "revised identity prompt",
            reason: "refresh identity prompt",
            confirmation: confirmationFor(characterId),
          },
        }),
        characterId,
      ),
    );
    expect(result.ok).toBe(true);
    const item = result.data?.item as {
      version: number;
      status: string;
      identityPrompt: string;
      anchorAssetIds: string[];
      referenceAssetIds: string[];
    };
    expect(item.version).toBe(2);
    expect(item.status).toBe("active");
    expect(item.identityPrompt).toBe("revised identity prompt");
    // Pool carried forward unchanged — not editable from this endpoint.
    expect(item.anchorAssetIds).toEqual([anchorAssetId]);
    expect(item.referenceAssetIds).toEqual([referenceAssetId]);

    const profiles = await prisma.characterVisualProfile.findMany({
      where: { characterId },
      orderBy: { version: "asc" },
    });
    expect(profiles.map((profile) => [profile.version, profile.status])).toEqual([
      [1, "archived"],
      [2, "active"],
    ]);
  });

  it("404s creating a version for an unknown character", async () => {
    const admin = await seedActor("admin", "create404");
    const missingId = `${P}char-missing-create`;
    const result = await call(
      createCharacterVisualProfile(
        makeRequest("POST", `/${missingId}/visual-profiles`, {
          userId: admin,
          role: "admin",
          body: {
            identityPrompt: "should 404",
            reason: "should 404",
            confirmation: confirmationFor(missingId),
          },
        }),
        missingId,
      ),
    );
    expect(result.status).toBe(404);
    expect(result.errorCode).toBe("not_found");
  });

  it("rejects a reason shorter than 3 characters (400)", async () => {
    const admin = await seedActor("admin", "shortreason");
    const characterId = `${P}char-shortreason`;
    await createCharacter({ id: characterId, name: "Short Reason Target" });

    const result = await call(
      createCharacterVisualProfile(
        makeRequest("POST", `/${characterId}/visual-profiles`, {
          userId: admin,
          role: "admin",
          body: {
            identityPrompt: "valid prompt",
            reason: "ab",
            confirmation: confirmationFor(characterId),
          },
        }),
        characterId,
      ),
    );
    expect(result.status).toBe(400);
    expect(result.errorCode).toBe("bad_request");
  });

  it("rejects a mismatched confirmation token (400)", async () => {
    const admin = await seedActor("admin", "badconfirm");
    const characterId = `${P}char-badconfirm`;
    await createCharacter({ id: characterId, name: "Bad Confirm Target" });

    const result = await call(
      createCharacterVisualProfile(
        makeRequest("POST", `/${characterId}/visual-profiles`, {
          userId: admin,
          role: "admin",
          body: {
            identityPrompt: "valid prompt",
            reason: "valid reason",
            confirmation: "wrong-token",
          },
        }),
        characterId,
      ),
    );
    expect(result.status).toBe(400);
    expect(result.errorCode).toBe("bad_request");
  });

  it("explicit identityPrompt is stored as-is and marked manual", async () => {
    const admin = await seedActor("admin", "manual");
    const characterId = `${P}char-manual`;
    const imageAssetId = `${P}image-manual`;
    await createMedia({ id: imageAssetId, ownerId: admin });
    await createCharacter({ id: characterId, name: "Manual Target", imageAssetId });

    const result = await call(
      createCharacterVisualProfile(
        makeRequest("POST", `/${characterId}/visual-profiles`, {
          userId: admin,
          role: "admin",
          body: {
            identityPrompt: "hand-authored, never derived",
            reason: "manual mint",
            confirmation: confirmationFor(characterId),
          },
        }),
        characterId,
      ),
    );
    expect(result.ok).toBe(true);
    const item = result.data?.item as { identityPrompt: string; identitySource: string; identityStale: boolean };
    expect(item.identityPrompt).toBe("hand-authored, never derived");
    expect(item.identitySource).toBe("manual");
    expect(item.identityStale).toBe(false);
  });

  it("omitting identityPrompt derives it from traits and marks the version derived", async () => {
    const admin = await seedActor("admin", "derived");
    const characterId = `${P}char-derived`;
    const imageAssetId = `${P}image-derived`;
    await createMedia({ id: imageAssetId, ownerId: admin });
    await createCharacter({ id: characterId, name: "Derived Target", imageAssetId });

    const result = await call(
      createCharacterVisualProfile(
        makeRequest("POST", `/${characterId}/visual-profiles`, {
          userId: admin,
          role: "admin",
          body: {
            faceTraits: { eyes: "green" },
            hairTraits: { color: "black" },
            reason: "derive from traits",
            confirmation: confirmationFor(characterId),
          },
        }),
        characterId,
      ),
    );
    expect(result.ok).toBe(true);
    const item = result.data?.item as {
      identityPrompt: string;
      identitySource: string;
      identityStale: boolean;
    };
    expect(item.identityPrompt).toContain("Appearance face eyes: green");
    expect(item.identityPrompt).toContain("Appearance hair color: black");
    expect(item.identitySource).toBe("derived");
    expect(item.identityStale).toBe(false);
  });

  it("promotes only a reviewed identity-calibration candidate into a new immutable identity", async () => {
    const admin = await seedActor("admin", "candidate-promotion");
    const characterId = `${P}char-candidate-promotion`;
    const originalAssetId = `${P}image-candidate-original`;
    const candidateAssetId = `${P}image-candidate-promoted`;
    const runId = `${P}run-candidate-promotion`;
    const itemId = `${P}item-candidate-promotion`;
    const jobId = `${P}job-candidate-promotion`;
    const decisionId = `${P}decision-candidate-promotion`;
    await createMedia({ id: originalAssetId, ownerId: admin });
    await createMedia({ id: candidateAssetId, ownerId: admin });
    await createCharacter({
      id: characterId,
      name: "Candidate Promotion",
      imageAssetId: originalAssetId,
    });
    await prisma.mediaAsset.updateMany({
      where: { id: { in: [originalAssetId, candidateAssetId] } },
      data: { characterId },
    });
    const original = await seedVisualProfile({
      characterId,
      version: 1,
      status: "active",
      identityPrompt: "Original identity",
      anchorAssetIds: [originalAssetId],
      referenceAssetIds: [originalAssetId],
    });
    await prisma.contentProductionBatch.create({
      data: {
        id: runId,
        title: "Identity calibration candidate",
        purpose: "identity_calibration",
        targetType: "character",
        targetId: characterId,
        presetIds: [],
        count: 1,
        totalItems: 1,
        completedItems: 1,
        approvedItems: 1,
        status: "completed",
        lifecycleState: "closed",
        workflowStage: "completed",
        verificationState: "passed",
        createdById: admin,
      },
    });
    await prisma.contentProductionItem.create({
      data: {
        id: itemId,
        batchId: runId,
        mediaAssetId: candidateAssetId,
        itemIndex: 0,
        status: "approved",
        tags: [],
      },
    });
    await prisma.generationJob.create({
      data: {
        id: jobId,
        userId: admin,
        characterId,
        mode: "image",
        controls: {},
        presetIds: [],
        outputCount: 1,
        deliveredOutputCount: 1,
        seed: "42",
        status: "completed",
        sourceType: "content_production_item",
        sourceId: itemId,
        sourceMeta: {
          batchId: runId,
          purpose: "identity_calibration",
          targetType: "character",
          targetId: characterId,
          identityExperiment: {
            mode: "text_to_image",
            positivePrompt: "A controlled candidate portrait",
          },
        },
        model: "identity-candidate-test",
        provider: "comfyui",
        completedAt: new Date(),
      },
    });
    await prisma.contentProductionItem.update({
      where: { id: itemId },
      data: { jobId },
    });
    await prisma.mediaAsset.update({
      where: { id: candidateAssetId },
      data: { sourceJobId: jobId },
    });
    await prisma.creativeReviewDecision.create({
      data: {
        id: decisionId,
        runItemId: itemId,
        artifactId: candidateAssetId,
        decision: "approved",
        identityConsistency: "unscored",
        score: 97,
        evidence: {
          quality: {
            artifactFree: true,
            singleSubject: true,
            intentMatch: true,
            noVisibleText: true,
          },
        },
        reason: "This candidate is the chosen identity definition",
        reviewerId: admin,
      },
    });

    const candidateAuthority = {
      runId,
      itemId,
      assetId: candidateAssetId,
      reviewDecisionId: decisionId,
    };
    const legacyAttempt = await call(createCharacterVisualProfile(
      makeRequest("POST", `/${characterId}/visual-profiles`, {
        userId: admin,
        role: "admin",
        body: {
          identityPrompt:
            "Preserve the exact person shown in the canonical portrait.",
          faceTraits: {
            canonicalPortraitAuthority: true,
            stableTraits: ["oval face", "blue eyes"],
          },
          hairTraits: { stableTraits: ["dark wavy hair"] },
          bodyTraits: { stableTraits: ["balanced adult proportions"] },
          reason: "Activate the reviewed calibration candidate",
          confirmation: confirmationFor(characterId),
          candidateAuthority,
        },
      }),
      characterId,
    ));
    expect(legacyAttempt).toMatchObject({
      status: 409,
      ok: false,
      errorDetails: { code: "identity_candidate_evidence_incomplete" },
    });

    const automaticComposition = {
      schemaVersion: "1",
      evaluatorVersion: "generated-image-sanity-v2",
      composition: {
        status: "passed",
        reason: "single_continuous_frame_detected",
      },
    };
    await prisma.mediaAsset.update({
      where: { id: candidateAssetId },
      data: { metadata: { quality: automaticComposition } },
    });
    await prisma.creativeReviewDecision.update({
      where: { id: decisionId },
      data: {
        evidence: {
          quality: {
            artifactFree: true,
            singleSubject: true,
            intentMatch: true,
            noVisibleText: true,
          },
          automaticComposition,
        },
      },
    });

    const result = await call(createCharacterVisualProfile(
      makeRequest("POST", `/${characterId}/visual-profiles`, {
        userId: admin,
        role: "admin",
        body: {
          identityPrompt:
            "Preserve the exact person shown in the canonical portrait.",
          faceTraits: {
            canonicalPortraitAuthority: true,
            stableTraits: ["oval face", "blue eyes"],
          },
          hairTraits: { stableTraits: ["dark wavy hair"] },
          bodyTraits: { stableTraits: ["balanced adult proportions"] },
          reason: "Activate the reviewed calibration candidate",
          confirmation: confirmationFor(characterId),
          candidateAuthority,
        },
      }),
      characterId,
    ));

    expect(result.ok).toBe(true);
    expect(result.data?.item).toMatchObject({
      version: 2,
      status: "active",
      anchorAssetIds: [candidateAssetId],
      referenceAssetIds: [candidateAssetId],
      defaultSeed: "42",
    });
    await expect(prisma.characterVisualProfile.findUniqueOrThrow({
      where: { id: original.id },
    })).resolves.toMatchObject({ status: "archived" });
    const promoted = await prisma.characterVisualProfile.findFirstOrThrow({
      where: { characterId, status: "active" },
      include: {
        referenceSetRevisions: {
          include: { references: true },
        },
        referenceCandidates: true,
      },
    });
    expect(promoted).toMatchObject({
      evidenceState: "reviewed_bootstrap",
      createdFrom: `identity_calibration:${jobId}`,
    });
    expect(promoted.referenceSetRevisions[0]?.references[0]).toMatchObject({
      mediaAssetId: candidateAssetId,
      role: "primary_face",
      qualityScore: 97,
    });
    expect(promoted.referenceCandidates[0]).toMatchObject({
      mediaAssetId: candidateAssetId,
      sourceJobId: jobId,
      status: "promoted",
    });
  });

  it("flags a derived version as stale when its stored traits no longer match its stored hash", async () => {
    const admin = await seedActor("admin", "stale");
    const characterId = `${P}char-stale`;
    await createCharacter({ id: characterId, name: "Stale Target" });

    const staleTraits = {
      face: { eyes: "blue" },
      hair: {},
      body: {},
      signature: {},
      style: { style: "realistic", gender: "female", age: "20", name: "Stale Target", description: "" },
    };
    await prisma.characterVisualProfile.create({
      data: {
        characterId,
        version: 1,
        status: "active",
        style: "realistic",
        identityPrompt: "stale derived prompt",
        negativeIdentityPrompt: null,
        faceTraits: staleTraits.face,
        hairTraits: staleTraits.hair,
        bodyTraits: staleTraits.body,
        signatureTraits: staleTraits.signature,
        styleTraits: staleTraits.style,
        anchorAssetIds: [],
        referenceAssetIds: [],
        defaultSeed: "seed-stale",
        // Hash was computed for a DIFFERENT traits snapshot than what's currently stored above —
        // simulates drift (e.g. an assembler version bump) without needing a real edit path.
        adapterRefs: {
          identity: { traitsHash: traitsHashOf({ ...staleTraits, face: { eyes: "green" } }), assemblerVersion: 1, source: "derived" },
        },
        createdFrom: "seed",
      },
    });

    const result = await call(
      listCharacterVisualProfiles(
        makeRequest("GET", `/${characterId}/visual-profiles`, { userId: admin, role: "admin" }),
        characterId,
      ),
    );
    expect(result.status).toBe(200);
    const items = result.data?.items as Array<{ identitySource: string; identityStale: boolean }>;
    expect(items[0]).toMatchObject({ identitySource: "derived", identityStale: true });
  });
});
