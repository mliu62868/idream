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
import { createCharacter, createMedia, createUser, purgeTestData } from "@/server/test/helpers";
import { createCharacterVisualProfile, listCharacterVisualProfiles } from "./visual-profiles";

const P = "zt-vprofile-";

type CallResult = {
  status: number;
  ok: boolean;
  data: Record<string, unknown> | undefined;
  errorCode: string | undefined;
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
    return { status: res.status, ok: Boolean(json?.ok), data: json?.data, errorCode: undefined };
  } catch (error) {
    if (error instanceof AppError) {
      return { status: error.status, ok: false, data: undefined, errorCode: error.code };
    }
    if (error instanceof ZodError) {
      return { status: 400, ok: false, data: undefined, errorCode: "bad_request" };
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
      ].sort(),
    );
    // adapterRefs 有意不在响应里 —— 面板不展示生成模型接线细节（LoRA/adapter）。
    expect(items[0]).not.toHaveProperty("adapterRefs");
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

    const audit = await prisma.adminAuditLog.findFirst({
      where: { action: "content.visual_profile.create", targetId: characterId },
    });
    expect(audit).not.toBeNull();
    expect(audit?.reason).toBe("bootstrap passport");
  });

  it("mints v(prev+1) active, archives the prior active, and carries forward unspecified traits/pool", async () => {
    const admin = await seedActor("admin", "version");
    const characterId = `${P}char-version`;
    await createCharacter({ id: characterId, name: "Version Target" });
    await seedVisualProfile({
      characterId,
      version: 1,
      status: "active",
      identityPrompt: "original identity prompt",
      anchorAssetIds: [`${P}anchor-1`],
      referenceAssetIds: [`${P}ref-1`],
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
    expect(item.anchorAssetIds).toEqual([`${P}anchor-1`]);
    expect(item.referenceAssetIds).toEqual([`${P}ref-1`]);

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
});
