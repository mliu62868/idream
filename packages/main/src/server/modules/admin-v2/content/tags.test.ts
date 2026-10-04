import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";
import { adminV2 as adminV2Api } from "@/server/test/admin-v2-http";
import { createCharacter, createUser, purgeTestData } from "@/server/test/helpers";

// SPEC: 标签治理 —— 经 Admin v2 Route Handler 驱动 list / patch / merge。
// 覆盖 patch 成功+审计、confirmation 不符 400、权限 403、合并迁移+删源、列表 characterCount。
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

    const response = await adminV2Api("PATCH", `/api/v2/admin/content/tags/${tag.id}`, {
      userId: admin,
      role: "admin",
      body: { isSensitive: true, reason: "reclassify as sensitive", confirmation: tag.slug },
    });
    expect(response.status, JSON.stringify(response.json)).toBe(200);
    expect(response.ok).toBe(true);
    expect(response.data.tag.isSensitive).toBe(true);

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

  // SPEC: Taxonomy 能直接建标签；slug 由 label 派生，确认串必须等于该 slug，重复 409。
  it("creates a tag with a derived slug and audits it", async () => {
    const admin = await setupActor("admin", "create");
    const body = { label: "zt tags Created", category: "mood", reason: "add missing tag", confirmation: `${P}created` };

    const response = await adminV2Api("POST", "/api/v2/admin/content/tags", { userId: admin, role: "admin", body });
    expect(response.status, JSON.stringify(response.json)).toBe(200);
    expect(response.data.tag).toMatchObject({ slug: `${P}created`, label: "zt tags Created", category: "mood", isSensitive: false });

    const audit = await prisma.adminAuditLog.findFirst({ where: { action: "content.tag.create", targetId: response.data.tag.id } });
    expect((audit?.after as { slug?: string })?.slug).toBe(`${P}created`);

    const duplicate = await adminV2Api("POST", "/api/v2/admin/content/tags", { userId: admin, role: "admin", body });
    expect(duplicate.status).toBe(409);
  });

  it("rejects tag creation with a mismatched confirmation or without content.tag.write", async () => {
    const admin = await setupActor("admin", "create-guard");
    const mismatch = await adminV2Api("POST", "/api/v2/admin/content/tags", {
      userId: admin,
      role: "admin",
      body: { label: "zt tags guard", reason: "wrong confirmation", confirmation: "CREATE" },
    });
    expect(mismatch.status).toBe(400);

    const analyst = await setupActor("analyst", "create-guard");
    const forbidden = await adminV2Api("POST", "/api/v2/admin/content/tags", {
      userId: analyst,
      role: "analyst",
      body: { label: "zt tags guard", reason: "should be blocked", confirmation: `${P}guard` },
    });
    expect(forbidden.status).toBe(403);
    expect(await prisma.tag.findUnique({ where: { slug: `${P}guard` } })).toBeNull();
  });

  it("rejects tag metadata edits when confirmation does not match the tag", async () => {
    const admin = await setupActor("admin", "patch-confirm");
    const tag = await createTag("patch-confirm", { isSensitive: false });

    const response = await adminV2Api("PATCH", `/api/v2/admin/content/tags/${tag.id}`, {
      userId: admin,
      role: "admin",
      body: {
        isSensitive: true,
        reason: "wrong tag confirmation",
        confirmation: "wrong-slug",
      },
    });
    expect(response.status).toBe(400);

    const persisted = await prisma.tag.findUnique({ where: { id: tag.id } });
    expect(persisted?.isSensitive).toBe(false);
  });

  it("rejects a patch that changes no tag field", async () => {
    const admin = await setupActor("admin", "patch-empty");
    const tag = await createTag("patch-empty");

    const response = await adminV2Api("PATCH", `/api/v2/admin/content/tags/${tag.id}`, {
      userId: admin,
      role: "admin",
      body: { reason: "no field supplied", confirmation: tag.slug },
    });
    expect(response.status).toBe(400);
  });

  it("rejects writes from actors without content.tag.write", async () => {
    const analyst = await setupActor("analyst", "perm");
    const tag = await createTag("perm");

    const response = await adminV2Api("PATCH", `/api/v2/admin/content/tags/${tag.id}`, {
      userId: analyst,
      role: "analyst",
      body: { label: "Nope", reason: "should be blocked", confirmation: tag.slug },
    });
    expect(response.status).toBe(403);

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

    const response = await adminV2Api("POST", "/api/v2/admin/content/tags/merge", {
      userId: admin,
      role: "admin",
      body: {
        sourceId: source.id,
        targetId: target.id,
        reason: "consolidate duplicate tags",
        confirmation: `${source.id}:${target.id}`,
      },
    });
    expect(response.status, JSON.stringify(response.json)).toBe(200);
    expect(response.data).toMatchObject({ merged: true, movedCount: 1 });

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

  it("rejects merge when confirmation does not match source and target", async () => {
    const admin = await setupActor("admin", "confirm");
    const source = await createTag("confirm-src");
    const target = await createTag("confirm-dst");

    const response = await adminV2Api("POST", "/api/v2/admin/content/tags/merge", {
      userId: admin,
      role: "admin",
      body: {
        sourceId: source.id,
        targetId: target.id,
        reason: "missing exact target confirmation",
        confirmation: "MERGE",
      },
    });
    expect(response.status).toBe(400);

    // Source untouched because the guard fires before any mutation.
    expect(await prisma.tag.findUnique({ where: { id: source.id } })).not.toBeNull();
  });

  it("lists tags with character counts and honors search filter", async () => {
    const admin = await setupActor("admin", "list");
    const tag = await createTag("list-unique", { category: `${P}cat` });
    const char = await createCharacter({ id: `${P}char-list`, creatorId: admin });
    await prisma.characterTag.create({ data: { characterId: char.id, tagId: tag.id } });

    const response = await adminV2Api(
      "GET",
      "/api/v2/admin/content/tags?search=list-unique",
      { userId: admin, role: "admin" },
    );
    expect(response.status, JSON.stringify(response.json)).toBe(200);
    const found = response.data.items.find((item: { id: string }) => item.id === tag.id);
    expect(found).toMatchObject({ characterCount: 1, category: `${P}cat` });
  });

  it("keeps all 501 tags reachable through listing, category search, editing and merging", async () => {
    const admin = await setupActor("admin", "large-vocabulary");
    const category = `${P}large-cat`;
    const rows = Array.from({ length: 501 }, (_, index) => ({
      id: `${P}large-${String(index).padStart(3, "0")}`,
      slug: `${P}large-${String(index).padStart(3, "0")}`,
      label: `Large vocabulary tag ${index}`,
      category,
    }));
    await prisma.tag.createMany({ data: rows });
    const actor = { userId: admin, role: "admin" as const };
    const last = rows.at(-1)!;

    const all = await adminV2Api("GET", "/api/v2/admin/content/tags", actor);
    expect(all.status, JSON.stringify(all.json)).toBe(200);
    expect(all.data.items.filter((item: { category: string | null }) => item.category === category)).toHaveLength(501);

    const filtered = await adminV2Api("GET", `/api/v2/admin/content/tags?category=${category}&search=${P}large-`, actor);
    expect(filtered.status, JSON.stringify(filtered.json)).toBe(200);
    expect(filtered.data.items.map((item: { id: string }) => item.id)).toEqual(rows.map((row) => row.id));

    const edited = await adminV2Api("PATCH", `/api/v2/admin/content/tags/${last.id}`, {
      ...actor, body: { label: "Last tag renamed", confirmation: last.slug, reason: "rename tail vocabulary entry" },
    });
    expect(edited.status, JSON.stringify(edited.json)).toBe(200);
    expect((await prisma.tag.findUniqueOrThrow({ where: { id: last.id } })).label).toBe("Last tag renamed");

    const character = await createCharacter({ id: `${P}large-character`, creatorId: admin });
    await prisma.characterTag.create({ data: { characterId: character.id, tagId: last.id } });
    const merged = await adminV2Api("POST", "/api/v2/admin/content/tags/merge", {
      ...actor, body: { sourceId: last.id, targetId: rows[0].id, confirmation: `${last.id}:${rows[0].id}`, reason: "merge tail vocabulary entry" },
    });
    expect(merged.status, JSON.stringify(merged.json)).toBe(200);
    expect(merged.data).toMatchObject({ merged: true, movedCount: 1 });
    expect(await prisma.tag.findUnique({ where: { id: last.id } })).toBeNull();
    expect(await prisma.characterTag.findUnique({ where: { characterId_tagId: { characterId: character.id, tagId: rows[0].id } } })).not.toBeNull();
  });
});
