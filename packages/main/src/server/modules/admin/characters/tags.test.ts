import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";
import { createCharacter, createUser, purgeTestData } from "@/server/test/helpers";
import { listAdminTags, mergeTags, patchTag } from "./tags";

// SPEC: 标签治理服务层单测 —— 直接驱动 listAdminTags/patchTag/mergeTags（dispatch 接缝由编排者接线，
//       本测试不经过路由）。覆盖 patch 成功+审计、权限 403、合并迁移+删源、confirmation 不符 400。
// INVARIANTS: dev-auth 头（x-idream-*）仅在 APP_ENV=test 生效；前缀 P 隔离测试数据。

const P = "zt-tags-";

beforeAll(async () => {
  await purgeTestData(P);
});

afterAll(async () => {
  await purgeTestData(P);
  await prisma.$disconnect();
});

type Role = "admin" | "moderator" | "support" | "ops" | "analyst" | "user";

/** Build a Request carrying dev-auth headers, mirroring the route handler. */
function adminRequest(
  method: string,
  path: string,
  options: { userId: string; role: Role; body?: unknown } = { userId: "", role: "user" },
) {
  const headers: Record<string, string> = {
    "x-idream-user-id": options.userId,
    "x-idream-role": options.role,
  };
  if (options.body !== undefined) headers["content-type"] = "application/json";
  return new Request(`http://localhost/api/v1/${path}`, {
    method,
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
}

async function readJson(response: Response) {
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

async function setupActor(role: Role, suffix: string) {
  const id = `${P}${role}-${suffix}`;
  await createUser({ id, role });
  return id;
}

async function createTag(suffix: string, overrides: Record<string, unknown> = {}) {
  return prisma.tag.create({
    data: {
      id: `${P}tag-${suffix}`,
      slug: `${P}slug-${suffix}`,
      label: `Label ${suffix}`,
      ...overrides,
    },
  });
}

describe("admin tag taxonomy governance", () => {
  it("patches tag metadata and records before/after in audit", async () => {
    const admin = await setupActor("admin", "patch");
    const tag = await createTag("patch", { isSensitive: false });

    const response = await patchTag(
      adminRequest("PATCH", `admin/content/tags/${tag.id}`, {
        userId: admin,
        role: "admin",
        body: { isSensitive: true, reason: "reclassify as sensitive" },
      }),
      tag.id,
    );
    const json = await readJson(response);
    expect(response.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.data.tag.isSensitive).toBe(true);

    const persisted = await prisma.tag.findUnique({ where: { id: tag.id } });
    expect(persisted?.isSensitive).toBe(true);

    const audit = await prisma.adminAuditLog.findFirst({
      where: { action: "content.tag.update", targetId: tag.id },
      orderBy: { createdAt: "desc" },
    });
    expect(audit).not.toBeNull();
    expect(audit?.targetType).toBe("tag");
    expect((audit?.before as { isSensitive?: boolean })?.isSensitive).toBe(false);
    expect((audit?.after as { isSensitive?: boolean })?.isSensitive).toBe(true);
  });

  it("rejects writes from actors without content.tag.write", async () => {
    const analyst = await setupActor("analyst", "perm");
    const tag = await createTag("perm");

    await expect(
      patchTag(
        adminRequest("PATCH", `admin/content/tags/${tag.id}`, {
          userId: analyst,
          role: "analyst",
          body: { label: "Nope", reason: "should be blocked" },
        }),
        tag.id,
      ),
    ).rejects.toMatchObject({ status: 403 });

    const persisted = await prisma.tag.findUnique({ where: { id: tag.id } });
    expect(persisted?.label).toBe("Label perm");
  });

  it("merges source CharacterTags into target and deletes the source tag", async () => {
    const admin = await setupActor("admin", "merge");
    const source = await createTag("merge-src");
    const target = await createTag("merge-dst");

    const charA = await createCharacter({ id: `${P}char-a`, creatorId: admin });
    const charB = await createCharacter({ id: `${P}char-b`, creatorId: admin });

    // charA tagged with both source+target (overlap → dedup); charB only source (moves).
    await prisma.characterTag.createMany({
      data: [
        { characterId: charA.id, tagId: source.id },
        { characterId: charA.id, tagId: target.id },
        { characterId: charB.id, tagId: source.id },
      ],
    });

    const response = await mergeTags(
      adminRequest("POST", "admin/content/tags/merge", {
        userId: admin,
        role: "admin",
        body: {
          sourceId: source.id,
          targetId: target.id,
          reason: "consolidate duplicate tags",
          confirmation: "MERGE",
        },
      }),
    );
    const json = await readJson(response);
    expect(response.status).toBe(200);
    expect(json.data).toMatchObject({ merged: true, movedCount: 1 });

    // Source gone; target now linked to both characters exactly once each.
    expect(await prisma.tag.findUnique({ where: { id: source.id } })).toBeNull();
    expect(await prisma.characterTag.count({ where: { tagId: source.id } })).toBe(0);
    const targetLinks = await prisma.characterTag.findMany({ where: { tagId: target.id } });
    expect(targetLinks.map((link) => link.characterId).sort()).toEqual([charA.id, charB.id].sort());

    const audit = await prisma.adminAuditLog.findFirst({
      where: { action: "content.tag.merge", targetId: target.id },
      orderBy: { createdAt: "desc" },
    });
    expect((audit?.before as { sourceId?: string })?.sourceId).toBe(source.id);
  });

  it("rejects merge when confirmation does not equal MERGE", async () => {
    const admin = await setupActor("admin", "confirm");
    const source = await createTag("confirm-src");
    const target = await createTag("confirm-dst");

    await expect(
      mergeTags(
        adminRequest("POST", "admin/content/tags/merge", {
          userId: admin,
          role: "admin",
          body: {
            sourceId: source.id,
            targetId: target.id,
            reason: "missing confirmation token",
            confirmation: "merge",
          },
        }),
      ),
    ).rejects.toMatchObject({ status: 400 });

    // Source untouched because the guard fires before any mutation.
    expect(await prisma.tag.findUnique({ where: { id: source.id } })).not.toBeNull();
  });

  it("lists tags with character counts and honors search filter", async () => {
    const admin = await setupActor("admin", "list");
    const tag = await createTag("list-unique", { category: `${P}cat` });
    const char = await createCharacter({ id: `${P}char-list`, creatorId: admin });
    await prisma.characterTag.create({ data: { characterId: char.id, tagId: tag.id } });

    const response = await listAdminTags(
      adminRequest("GET", `admin/content/tags?search=list-unique`, {
        userId: admin,
        role: "admin",
      }),
    );
    const json = await readJson(response);
    expect(response.status).toBe(200);
    const found = json.data.items.find((item: { id: string }) => item.id === tag.id);
    expect(found).toMatchObject({ characterCount: 1, category: `${P}cat` });
  });
});
