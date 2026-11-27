import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CHARACTER_DEFAULT_REFERENCE_DIRECTION } from "@idream/shared/admin";
import { prisma } from "@/server/lib/db";
import { adminV2 as adminV2Api } from "@/server/test/admin-v2-http";
import { createUser } from "@/server/test/helpers";
import { createCharacterProject } from "./creation";
import { createCharacterImageSource, listCharacterImageSources } from "./image-sources";

const suffix = randomUUID();
const adminId = `dup-admin-${suffix}`;
const scopedId = `dup-scoped-${suffix}`;
const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);

const duplicate = (id: string, options: { userId?: string; role?: string; idempotencyKey?: string } = {}) =>
  adminV2Api("POST", `/api/v2/admin/characters/${id}/duplicate`, {
    userId: options.userId ?? adminId,
    role: options.role ?? "admin",
    body: {},
    idempotencyKey: options.idempotencyKey ?? randomUUID(),
  });

describe("Character duplicate", () => {
  let sourceId: string;
  let uploadedId: string;

  beforeAll(async () => {
    await prisma.user.create({ data: { id: adminId, email: `${adminId}@example.test`, role: "admin" } });
    await createUser({ id: scopedId, role: "analyst" });
    const created = await createCharacterProject({
      actor: { id: adminId, role: "admin" },
      idempotencyKey: randomUUID(),
      requestId: randomUUID(),
      request: {
        persona: {
          name: `Mara ${suffix.slice(0, 8)}`, age: 30, gender: "female",
          characterPromise: "A dry night-shift nurse", detailsMarkdown: "## Voice", firstMessage: "Long shift?",
        },
        visualDirection: {
          identityAnchor: "Night-shift nurse", stableTraits: ["Dark hair"], style: "realistic", referenceDirection: "Warm low light",
        },
        reason: { code: "test", summary: "Seed a source Character" },
        confirmation: "CREATE CHARACTER",
      },
    });
    sourceId = created.characterId;
    const upload = await createCharacterImageSource({
      characterId: sourceId,
      actor: { id: adminId, role: "admin" },
      idempotencyKey: randomUUID(),
      requestId: randomUUID(),
      form: {
        purpose: "character_library",
        image: {
          body: PNG, contentType: "image/png", extension: ".png", filename: "mara-portrait.png",
          sha256: "a".repeat(64), width: 512, height: 512,
        },
      } as never,
    });
    uploadedId = upload.asset.id;
    const tag = await prisma.tag.create({ data: { slug: `dup-${suffix}`, label: "Duplicate Test" } });
    await prisma.characterTag.create({ data: { characterId: sourceId, tagId: tag.id } });
    await prisma.character.update({ where: { id: sourceId }, data: { visibility: "public", status: "approved" } });
  });

  afterAll(async () => {
    // INVARIANT: 目录类测试（probe-public-catalog、public-content-cleanup）按全库计数，公开夹具不能留下。
    await prisma.character.update({ where: { id: sourceId }, data: { visibility: "private", status: "archived" } });
    await prisma.$disconnect();
  });

  it("creates an independent private draft that survives the source image being archived", async () => {
    const result = await duplicate(sourceId);
    expect(result.status).toBe(201);
    const data = result.data as { characterId: string; deepLink: string; copiedImageCount: number; skippedImageCount: number; identityCopied: boolean };
    expect(data.deepLink).toContain(data.characterId);
    expect(data.copiedImageCount).toBe(1);
    expect(data.skippedImageCount).toBe(0);

    const copy = await prisma.character.findUniqueOrThrow({
      where: { id: data.characterId },
      include: { serving: true, tags: true },
    });
    expect(copy).toMatchObject({ visibility: "private", status: "draft", imageAssetId: null, source: "official" });
    expect(copy.name).toContain("(copy)");
    expect(copy.serving).toMatchObject({ state: "inactive", currentReleaseId: null });
    expect(copy.tags).toHaveLength(1);
    const project = await prisma.characterProject.findFirstOrThrow({ where: { characterId: copy.id } });
    await expect(prisma.characterRelease.count({ where: { projectId: project.id } })).resolves.toBe(0);
    expect(project.draftImageAssetId).toBeNull();

    const [copied] = (await listCharacterImageSources({ characterId: copy.id, purpose: "character_library" })).items;
    expect(copied?.id).not.toBe(uploadedId);
    const row = await prisma.mediaAsset.findUniqueOrThrow({ where: { id: copied!.id } });
    const sourceRow = await prisma.mediaAsset.findUniqueOrThrow({ where: { id: uploadedId } });
    expect(row.visibility).toBe("private");
    expect(row.storageKey).not.toBe(sourceRow.storageKey);
    expect(row.metadata).toMatchObject({ duplicateLineage: { sourceAssetId: uploadedId, sourceCharacterId: sourceId } });

    // Taking the source image down leaves the copy's own row and file untouched.
    await prisma.mediaAsset.update({ where: { id: uploadedId }, data: { deletedAt: new Date() } });
    const after = await listCharacterImageSources({ characterId: copy.id, purpose: "character_library" });
    expect(after.items.map((item) => item.id)).toEqual([row.id]);
    await prisma.mediaAsset.update({ where: { id: uploadedId }, data: { deletedAt: null } });
  });

  it("replays one copy for one idempotency key", async () => {
    const idempotencyKey = randomUUID();
    const first = await duplicate(sourceId, { idempotencyKey });
    const second = await duplicate(sourceId, { idempotencyKey });
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect((second.data as { characterId: string }).characterId).toBe((first.data as { characterId: string }).characterId);
    expect((second.data as { replayed: boolean }).replayed).toBe(true);
  });

  it("uses the same global rule as creating a Character", async () => {
    const denied = await duplicate(sourceId, { userId: scopedId, role: "analyst" });
    expect(denied.status).toBe(403);
    await prisma.adminUserPermission.create({
      data: { userId: scopedId, permissionKey: "character.project.write", effect: "grant", reason: "duplicate test", createdById: adminId },
    });
    const granted = await duplicate(sourceId, { userId: scopedId, role: "analyst" });
    expect(granted.status).toBe(201);
    await prisma.adminUserPermission.deleteMany({ where: { userId: scopedId } });
  });

  // Older official Characters predate the wizard's required visual fields.
  async function legacyCharacter(label: string, appearanceSnapshot: Record<string, unknown>) {
    const created = await createCharacterProject({
      actor: { id: adminId, role: "admin" },
      idempotencyKey: randomUUID(),
      requestId: randomUUID(),
      request: {
        persona: {
          name: `${label} ${suffix.slice(0, 8)}`, age: 34, gender: "male",
          characterPromise: "A retired lighthouse keeper with a long memory", detailsMarkdown: "", firstMessage: "Storm's coming.",
        },
        visualDirection: {
          identityAnchor: "Weathered lighthouse keeper", stableTraits: ["Grey beard"], style: "realistic", referenceDirection: "Overcast light",
        },
        reason: { code: "test", summary: "Seed a legacy Character" },
        confirmation: "CREATE CHARACTER",
      },
    });
    const first = await prisma.characterContentVersion.findFirstOrThrow({ where: { characterId: created.characterId } });
    await prisma.characterContentVersion.create({ data: {
      characterId: created.characterId, version: 2, contentHash: `legacy-${randomUUID()}`,
      personaSnapshot: first.personaSnapshot as never, openingSnapshot: first.openingSnapshot as never,
      appearanceSnapshot: appearanceSnapshot as never, sourceType: "test",
    } });
    return created.characterId;
  }

  it("fills a legacy Character's look from its first fixed feature, never from its description", async () => {
    const legacyId = await legacyCharacter("Keeper", { style: "realistic", stableTraits: ["Grey beard", "Wool cap"] });
    const result = await duplicate(legacyId);
    expect(result.status).toBe(201);
    const { characterId } = result.data as { characterId: string };
    const content = await prisma.characterContentVersion.findFirstOrThrow({ where: { characterId }, orderBy: { version: "desc" } });
    expect(content.appearanceSnapshot).toMatchObject({
      identityAnchor: "Grey beard",
      stableTraits: ["Grey beard", "Wool cap"],
      referenceDirection: CHARACTER_DEFAULT_REFERENCE_DIRECTION,
    });
    expect(JSON.stringify(content.appearanceSnapshot)).not.toContain("lighthouse keeper with a long memory");
  });

  it("uses a legacy Character's one-line look as its fixed feature when it has no features", async () => {
    const legacyId = await legacyCharacter("Anchor keeper", { style: "realistic", identityAnchor: "Weathered keeper in a wool coat" });
    const result = await duplicate(legacyId);
    expect(result.status).toBe(201);
    const { characterId } = result.data as { characterId: string };
    const content = await prisma.characterContentVersion.findFirstOrThrow({ where: { characterId }, orderBy: { version: "desc" } });
    expect(content.appearanceSnapshot).toMatchObject({
      identityAnchor: "Weathered keeper in a wool coat",
      stableTraits: ["Weathered keeper in a wool coat"],
    });
    expect(JSON.stringify(content.appearanceSnapshot)).not.toContain("lighthouse keeper with a long memory");
  });

  it("refuses to copy a legacy Character without any appearance and says what to add", async () => {
    const legacyId = await legacyCharacter("Bare keeper", { style: "realistic" });
    const before = await prisma.character.count({ where: { name: { contains: "Bare keeper" } } });
    const result = await duplicate(legacyId);
    expect(result.status).toBe(409);
    expect(result.error).toMatchObject({ details: {
      reason: "visual_traits_missing", deepLink: `/admin/characters/${legacyId}?tab=soul`,
    } });
    await expect(prisma.character.count({ where: { name: { contains: "Bare keeper" } } })).resolves.toBe(before);
  });

  it("404s for an unknown Character", async () => {
    await expect(duplicate(`missing-${suffix}`)).resolves.toMatchObject({ status: 404 });
  });
});
