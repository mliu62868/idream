import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { creatorStudioSummarySchema, type CreatorLevelDefinition } from "@/lib/creator-studio";
import { packDetailSchema, type PackDetail, type PackManifest } from "@idream/shared/packs";
import { prisma } from "@/server/lib/db";
import { providers } from "@/server/providers";
import { api, createCharacter, createMedia, createUser, expectError, expectOk, publishCharacterForPublicAudience } from "@/server/test/helpers";
import { requirePublicCreatorForAnonymous } from "@/server/public-route-existence";
import { CREATOR_LEVELS_ACTIVE_KEY, creatorLevelDefinitionKey } from "./creator-levels";
import { projectServingToCharacter } from "../admin-v2/characters/serving-projection";
import { operationalCharacterWhere } from "../metric-data-scope";

vi.mock("next/headers", () => ({ cookies: async () => ({ has: () => false }) }));

const prefix = "zt-creator-studio-";
const owner = `${prefix}owner`, reader = `${prefix}reader`, internal = `${prefix}internal`, suspended = `${prefix}suspended`;
const followers = Array.from({ length: 5 }, (_, index) => `${prefix}follower-${index}`);
const packOnly = `${prefix}pack-only`;
const authors = [owner, reader, internal, suspended, packOnly, ...followers];
const publishedSql = readFileSync("../../db/sql/2026-10-02-creator-levels-definition.sql", "utf8");
const authored = { userId: owner, ageGate: true };
const packIds: string[] = [], blobKeys: string[] = [];
let publicPack: PackDetail;
const v1: CreatorLevelDefinition = { schemaVersion: 1, definitionVersion: 1, levels: [
  { level: 0, label: "Creator", publicWorks: 0, followers: 0 },
  { level: 1, label: "Published creator", publicWorks: 1, followers: 0 },
  { level: 2, label: "Community creator", publicWorks: 1, followers: 5 },
] };
async function clearDefinitions() {
  await prisma.appSetting.deleteMany({ where: { OR: [{ key: CREATOR_LEVELS_ACTIVE_KEY }, { key: { startsWith: "creator.levels.definition:" } }] } });
}
async function publishDefinition(expected: number, definition = v1, json = JSON.stringify(definition)) {
  return prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT set_config('idream.creator_levels.expected_pointer_version', ${String(expected)}, true)`;
    await tx.$queryRaw`SELECT set_config('idream.creator_levels.definition_version', ${String(definition.definitionVersion)}, true)`;
    await tx.$queryRaw`SELECT set_config('idream.creator_levels.definition_json', ${json}, true)`;
    await tx.$executeRawUnsafe(publishedSql);
  });
}
async function image(label: string, ownerId = owner) {
  const id = `${prefix}${label}`, key = `test-fixtures/${id}`;
  blobKeys.push(key);
  await providers.blob.putPrivate({ key, body: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), contentType: "image/png" });
  await createMedia({ id, ownerId, storageKey: key, contentType: "image/png", prompt: "PRIVATE_STUDIO_GENERATION_PROMPT" });
  return id;
}
async function pack(label: string, visibility: PackManifest["visibility"] = "public", creator = owner, claimUntil: string | null = null) {
  const mediaAssetId = await image(`${label}-image`, creator);
  const result = await api("POST", "packs", { userId: creator, ageGate: true, body: {
    title: `${prefix}${label}`, description: "Exact free release", visibility, coverAssetId: null, claimUntil, items: [{ mediaAssetId, caption: "Saved item" }],
  } });
  expectOk(result, 201); const draft = packDetailSchema.parse(result.data); packIds.push(draft.id); return draft;
}
async function publishPack(draft: PackDetail, creator = owner) {
  const result = await api("POST", `packs/${draft.id}/publish`, { userId: creator, ageGate: true, body: { version: draft.version } });
  expectOk(result); return packDetailSchema.parse(result.data);
}
async function claim(pack: PackDetail, userId = reader) {
  const result = await api("POST", `packs/${pack.id}/claim`, { userId, ageGate: true, body: { releaseId: pack.release!.id, version: pack.release!.version } });
  expectOk(result); return packDetailSchema.parse(result.data);
}
async function draft(label: string, extra: { ownerId?: string; editsCharacterId?: string; submittedCharacterId?: string } = {}, updatedAt = new Date()) {
  return prisma.characterDraft.create({ data: { id: `${prefix}${label}`, ownerId: extra.ownerId ?? owner, name: `Draft ${label}`, step: 2,
    appearance: {}, hair: {}, body: {}, tags: [], advancedDetails: { age: 25, description: "PRIVATE_STUDIO_DRAFT_CONTENT", ...(extra.submittedCharacterId ? { submittedCharacterId: extra.submittedCharacterId } : {}) },
    editsCharacterId: extra.editsCharacterId, updatedAt } });
}
async function summary(userId = owner) {
  const result = await api("GET", "creator-studio", { userId }); expectOk(result);
  expect(result.headers.get("cache-control")).toBe("private, no-store, max-age=0");
  return creatorStudioSummarySchema.parse(result.data);
}
async function sideEffects() {
  return { jobs: await prisma.generationJob.count(), previews: await prisma.characterPreviewJob.count(), releases: await prisma.characterRelease.count(), events: await prisma.mainOutboxEvent.count(), ledger: await prisma.dreamcoinLedger.count() };
}

beforeAll(async () => {
  for (const id of authors) await createUser({ id, dataClass: id === internal ? "internal" : "customer", status: id === suspended ? "suspended" : "active" });
  for (const followerId of [owner, internal, suspended, ...followers]) await prisma.follow.create({ data: { followerId, followeeId: owner } });
  // The editorial publication helper requires explicit official fixtures.
  for (const label of ["live", "paused", "private", "unlisted"]) {
    const id = `${prefix}${label}`; await createCharacter({ id, creatorId: owner, source: "official" }); await publishCharacterForPublicAudience({ characterId: id, ownerId: owner });
  }
  await prisma.$transaction(async tx => {
    await tx.characterServing.update({ where: { characterId: `${prefix}paused` }, data: { state: "paused", version: { increment: 1 } } });
    await projectServingToCharacter(tx, { characterId: `${prefix}paused`, state: "paused" });
  });
  expect(await prisma.character.findUniqueOrThrow({ where: { id: `${prefix}paused` }, select: { status: true, visibility: true } })).toEqual({ status: "archived", visibility: "public" });
  await prisma.character.update({ where: { id: `${prefix}private` }, data: { visibility: "private" } });
  await prisma.character.update({ where: { id: `${prefix}unlisted` }, data: { visibility: "unlisted" } });
  await createCharacter({ id: `${prefix}awaiting`, creatorId: owner, source: "user", name: "Iris", status: "approved", visibility: "public" });
  await createCharacter({ id: `${prefix}archived`, creatorId: owner, source: "user", status: "archived" });
  await createCharacter({ id: `${prefix}deleted`, creatorId: owner, source: "user" });
  await prisma.character.update({ where: { id: `${prefix}deleted` }, data: { deletedAt: new Date() } });
  for (let index = 0; index < 8; index++) await draft(`draft-${index}`, {}, new Date(`2026-01-${String(index + 1).padStart(2, "0")}T00:00:00Z`));
  await draft("submitted", { submittedCharacterId: `${prefix}awaiting` });
  await draft("edit", { editsCharacterId: `${prefix}awaiting` });
  await draft("foreign", { ownerId: reader });
  const historical = await draft("historical");
  await prisma.characterContentVersion.create({ data: { characterId: `${prefix}awaiting`, version: 1, contentHash: "historically-submitted-studio-draft", personaSnapshot: {}, openingSnapshot: {}, appearanceSnapshot: {}, sourceType: "user", sourceId: historical.id } });
  const comicImage = await image("comic-page");
  for (const [label, visibility, status, mediaAssetId] of [
    ["comic-public", "public", "published", comicImage], ["comic-private", "private", "published", comicImage], ["comic-unlisted", "unlisted", "published", comicImage],
    ["comic-unavailable", "public", "published", null], ["comic-draft", "public", "draft", comicImage],
  ] as const) await prisma.comic.create({ data: { id: `${prefix}${label}`, creatorId: owner, title: label, visibility, status,
    episodes: { create: { ordinal: 0, title: "Arrival", pages: { create: { ordinal: 0, mediaAssetId, sourceProvenance: {} } } } } } });
  publicPack = await publishPack(await pack("public")); await publishPack(await pack("private", "private"));
  const unlistedPack = await publishPack(await pack("unlisted", "unlisted")); await pack("draft");
  const first = await claim(publicPack); expect((await claim(publicPack)).grant!.id).toBe(first.grant!.id);
  await claim(unlistedPack); await claim(publicPack, owner);
  for (const userId of [internal, suspended]) await prisma.packGrant.create({ data: { userId, releaseId: publicPack.release!.id } });
});
beforeEach(clearDefinitions);
afterAll(async () => {
  await clearDefinitions();
  // Release/qualification evidence remains immutable until the isolated test DB is reset.
  await prisma.pack.updateMany({ where: { id: { in: packIds } }, data: { status: "withdrawn" } });
  await prisma.character.updateMany({ where: { creatorId: { in: authors } }, data: { visibility: "private", status: "archived", deletedAt: new Date() } });
  await prisma.user.updateMany({ where: { id: { in: authors } }, data: { dataClass: "audit" } });
  for (const key of blobKeys) await providers.blob.delete({ key });
  expect(await prisma.character.count({ where: operationalCharacterWhere({ creatorId: { in: authors }, deletedAt: null }) })).toBe(0);
});

describe("Creator Studio owner facts and explicit level publication", () => {
  it("reads actual owned inventory and current publication authority without prompts or side effects", async () => {
    const before = await sideEffects(), data = await summary();
    expect(data.counts).toEqual({ drafts: 8, characters: 6, publicCharacters: 1, comics: { total: 5, publicAvailable: 1, byStatus: { published: 4, draft: 1 } },
      packs: { total: 4, publicAvailable: 1, byStatus: { published: 3, draft: 1 } }, followers: 5, packClaims: 2, packClaimants: 1 });
    expect(data.publicCharacterQualification).toEqual({ available: 1, awaiting: 1, paused: 1 });
    const statuses = Object.fromEntries(data.recent.characters.map(item => [item.id, item.status]));
    expect(statuses).toMatchObject({ [`${prefix}awaiting`]: "awaiting_publication", [`${prefix}live`]: "available", [`${prefix}unlisted`]: "available_by_link", [`${prefix}private`]: "private", [`${prefix}paused`]: "paused", [`${prefix}archived`]: "archived" });
    expect(data.recent.drafts).toHaveLength(8);
    expect(data.recent.drafts.at(-1)?.href).toBe(`/create?draft=${prefix}draft-0`);
    expect(JSON.stringify(data)).not.toMatch(/PRIVATE_STUDIO|storageKey|mediaAssetId|appearance|advancedDetails/);
    expect(await sideEffects()).toEqual(before);
  });
  it("distinguishes paused Serving from retirement without overriding rejection or privacy", async () => {
    const id = `${prefix}paused`, before = await summary();
    const original = await prisma.character.findUniqueOrThrow({ where: { id }, select: { status: true, visibility: true, updatedAt: true } });
    const serving = await prisma.characterServing.findUniqueOrThrow({ where: { characterId: id }, select: { state: true, version: true, updatedAt: true } });
    try {
      for (const [visibility, status, state, expected] of [
        ["public", "archived", "paused", "paused"],
        ["unlisted", "archived", "paused", "paused"],
        ["public", "archived", "retired", "archived"],
        ["unlisted", "archived", "retired", "archived"],
        ["public", "rejected", "paused", "rejected"],
        ["unlisted", "removed", "paused", "removed"],
        ["private", "approved", "paused", "private"],
        ["private", "archived", "paused", "archived"],
      ] as const) {
        await prisma.$transaction(async tx => {
          await tx.characterServing.update({ where: { characterId: id }, data: { state, version: { increment: 1 } } });
          await tx.character.update({ where: { id }, data: { visibility, status, updatedAt: original.updatedAt } });
        });
        const data = await summary();
        expect(data.recent.characters.find(row => row.id === id)?.status, `${visibility}/${status}/${state}`).toBe(expected);
        expect(data.publicCharacterQualification.paused).toBe(visibility === "public" && expected === "paused" ? 1 : 0);
        expect(data.counts).toEqual(before.counts);
      }
    } finally {
      await prisma.$transaction(async tx => {
        await tx.characterServing.update({ where: { characterId: id }, data: serving });
        await tx.character.update({ where: { id }, data: original });
      });
    }
    const restored = await summary();
    expect(restored.recent.characters).toEqual(before.recent.characters);
    expect(restored.counts).toEqual(before.counts);
    expect(restored.publicCharacterQualification).toEqual(before.publicCharacterQualification);
    expect(restored.program).toEqual(before.program);
  });
  it("requires the confirmed owner and never substitutes another account's totals", async () => {
    expectError(await api("GET", "creator-studio"), 401);
    expectError(await api("GET", "creator-studio", { userId: reader, headers: { "x-idream-viewer-scope": `user:${owner}` } }), 409);
    const data = await summary(reader);
    expect(data.viewerId).toBe(reader); expect(data.counts).toMatchObject({ drafts: 1, characters: 0, publicCharacters: 0, followers: 0, packClaims: 0 });
    expect(data.recent.drafts.map(row => row.id)).toEqual([`${prefix}foreign`]);
  });
  it("restores an exact old draft after refresh and retains its optimistic write contract", async () => {
    const before = await sideEffects();
    const read = await api("GET", `character-drafts/${prefix}draft-0`, authored); expectOk(read);
    expect(read.headers.get("cache-control")).toBe("private, no-store, max-age=0");
    expect(read.data.draft).toMatchObject({ id: `${prefix}draft-0`, name: "Draft draft-0", step: 2 });
    expect(read.data.previewJob).toBeNull(); expect(read.data.asset).toBeNull();
    const refresh = await api("GET", `character-drafts/${prefix}draft-0`, authored); expectOk(refresh); expect(refresh.data).toEqual(read.data);
    const saved = await api("PATCH", `character-drafts/${prefix}draft-0`, { ...authored, body: { expectedUpdatedAt: read.data.draft.updatedAt, name: "Continued exact old draft" } }); expectOk(saved);
    expectError(await api("PATCH", `character-drafts/${prefix}draft-0`, { ...authored, body: { expectedUpdatedAt: read.data.draft.updatedAt, name: "Stale tab overwrite" } }), 409);
    expect((await api("GET", `character-drafts/${prefix}draft-0`, authored)).data.draft.name).toBe("Continued exact old draft");
    expect(await sideEffects()).toEqual(before);
  });
  it("rejects foreign, edit, submitted and historically submitted exact drafts instead of loading latest", async () => {
    for (const id of ["foreign", "edit", "submitted", "historical", "missing"]) expectError(await api("GET", `character-drafts/${prefix}${id}`, authored), 404);
    expectError(await api("GET", `character-drafts/${prefix}draft-1`, { userId: reader, ageGate: true }), 404);
    expectError(await api("GET", `character-drafts/${prefix}draft-1`, { ageGate: true }), 401);
  });
  it("reports levels as unavailable until an explicitly published definition exists", async () => {
    const data = await summary(); expect(data.program).toMatchObject({ state: "unavailable", definitionVersion: null, level: null, nextLevel: null, publicWorks: 3, followers: 5 });
    expect(await prisma.appSetting.findUnique({ where: { key: CREATOR_LEVELS_ACTIVE_KEY } })).toBeNull();
  });
  it("publishes the declared v1 rule and computes current and next levels from actual facts", async () => {
    await publishDefinition(0);
    const data = await summary(); expect(data.program).toMatchObject({ state: "published", definitionVersion: 1, level: { level: 2, label: "Community creator" }, nextLevel: null });
    const readerData = await summary(reader); expect(readerData.program).toMatchObject({ state: "published", level: { level: 0 }, nextLevel: { level: 1, publicWorks: 1, followers: 0, remainingPublicWorks: 1, remainingFollowers: 0 } });
    expect((await summary(internal)).program).toMatchObject({ state: "ineligible", level: null, nextLevel: null });
  });
  it("rejects an old pointer and same-version rule mutation without publishing any partial definition", async () => {
    await publishDefinition(0);
    const changed: CreatorLevelDefinition = { ...v1, levels: v1.levels.map(rule => rule.level === 2 ? { ...rule, followers: 19 } : rule) };
    await expect(publishDefinition(1, changed)).rejects.toThrow(/cannot be overwritten/);
    await expect(publishDefinition(0, { ...changed, definitionVersion: 2 })).rejects.toThrow(/pointer conflict/);
    expect(await prisma.appSetting.findUnique({ where: { key: creatorLevelDefinitionKey(2) } })).toBeNull();
    expect(await prisma.appSetting.findUnique({ where: { key: creatorLevelDefinitionKey(1) } })).toMatchObject({ value: v1, version: 1 });
    expect(await prisma.appSetting.findUnique({ where: { key: CREATOR_LEVELS_ACTIVE_KEY } })).toMatchObject({ value: { definitionVersion: 1 }, version: 1 });
  });
  it("moves only the CAS pointer to a new immutable definition and uses that version's conditions", async () => {
    await publishDefinition(0);
    const v2: CreatorLevelDefinition = { ...v1, definitionVersion: 2, levels: v1.levels.map(rule => rule.level === 2 ? { ...rule, publicWorks: 7, followers: 19 } : rule) };
    await publishDefinition(1, v2);
    expect((await summary()).program).toMatchObject({ definitionVersion: 2, level: { level: 1 }, nextLevel: { publicWorks: 7, followers: 19, remainingPublicWorks: 4, remainingFollowers: 14 } });
    expect(await prisma.appSetting.findUnique({ where: { key: creatorLevelDefinitionKey(1) } })).toMatchObject({ value: v1 });
    expect(await prisma.appSetting.findUnique({ where: { key: CREATOR_LEVELS_ACTIVE_KEY } })).toMatchObject({ version: 2 });
  });
  it("rejects malformed operational rules and accepts equivalent integer JSON representations", async () => {
    await expect(publishDefinition(0, v1, JSON.stringify({ ...v1, levels: [{ ...v1.levels[0], followers: 0.5 }] }))).rejects.toThrow(/Invalid Creator/);
    await expect(publishDefinition(0, v1, JSON.stringify({ ...v1, hiddenThreshold: 3 }))).rejects.toThrow(/Invalid Creator/);
    expect(await prisma.appSetting.count({ where: { key: { startsWith: "creator.levels." } } })).toBe(0);
    await publishDefinition(0, v1, JSON.stringify(v1).replace('"schemaVersion":1', '"schemaVersion":1.0').replace('"level":0', '"level":0.0'));
    expect((await summary()).program.definitionVersion).toBe(1);
  });
  it("recomputes level progress when active followers or distribution change while retaining existing claims", async () => {
    await publishDefinition(0);
    try {
      await prisma.user.update({ where: { id: followers[4]! }, data: { status: "suspended" } });
      expect((await summary()).program).toMatchObject({ level: { level: 1 }, nextLevel: { remainingFollowers: 1 } });
      const withdrawn = await api("POST", `packs/${publicPack.id}/withdraw`, { ...authored, body: { version: publicPack.version } }); expectOk(withdrawn);
      await prisma.characterServing.update({ where: { characterId: `${prefix}live` }, data: { state: "paused" } });
      await prisma.comic.update({ where: { id: `${prefix}comic-public` }, data: { status: "withdrawn" } });
      const data = await summary(); expect(data.counts).toMatchObject({ publicCharacters: 0, packs: { publicAvailable: 0 }, comics: { publicAvailable: 0 }, packClaims: 2, packClaimants: 1 });
      expect(data.program).toMatchObject({ level: { level: 0 }, nextLevel: { remainingPublicWorks: 1 }, publicWorks: 0 });
    } finally {
      await prisma.user.update({ where: { id: followers[4]! }, data: { status: "active" } });
      await prisma.pack.update({ where: { id: publicPack.id }, data: { status: "published", version: publicPack.version } });
      await prisma.characterServing.update({ where: { characterId: `${prefix}live` }, data: { state: "live" } });
      await prisma.comic.update({ where: { id: `${prefix}comic-public` }, data: { status: "published" } });
    }
  });
  it("allows a Pack-only creator's public profile and idempotent Follow using current release authority", async () => {
    const draft = await pack("pack-only", "public", packOnly);
    expectError(await api("GET", `creators/${packOnly}`, { ageGate: true }), 404);
    expectError(await api("POST", `users/${packOnly}/follow`, { userId: reader }), 404);
    const published = await publishPack(draft, packOnly);
    await requirePublicCreatorForAnonymous(packOnly);
    const profile = await api("GET", `creators/${packOnly}`, { ageGate: true }); expectOk(profile); expect(profile.data.creator.stats.characters).toBe(0);
    for (let index = 0; index < 2; index++) expectOk(await api("POST", `users/${packOnly}/follow`, { userId: reader }));
    expect(await prisma.follow.count({ where: { followerId: reader, followeeId: packOnly } })).toBe(1);
    const data = await summary(packOnly); expect(data.counts).toMatchObject({ publicCharacters: 0, packs: { publicAvailable: 1 }, followers: 1 });
    for (const status of ["withdrawn", "blocked"]) {
      await prisma.pack.update({ where: { id: published.id }, data: { status } });
      expectError(await api("GET", `creators/${packOnly}`, { ageGate: true }), 404);
      expectError(await api("POST", `users/${packOnly}/follow`, { userId: followers[0] }), 404);
      await expect(requirePublicCreatorForAnonymous(packOnly)).rejects.toThrow();
    }
  });
  it("excludes an expired free offer from Pack-only creator qualification", async () => {
    const deadline = new Date(Date.now() + 2_000);
    const published = await publishPack(await pack("expiring-only", "public", packOnly, deadline.toISOString()), packOnly);
    expectOk(await api("GET", `creators/${packOnly}`, { ageGate: true }));
    await new Promise(resolve => setTimeout(resolve, Math.max(0, deadline.getTime() - Date.now()) + 20));
    expect((await summary(packOnly)).counts.packs.publicAvailable).toBe(0);
    expectError(await api("GET", `creators/${packOnly}`, { ageGate: true }), 404);
    expectError(await api("POST", `users/${packOnly}/follow`, { userId: followers[0] }), 404);
    expectError(await api("POST", `packs/${published.id}/claim`, { userId: reader, ageGate: true, body: { releaseId: published.release!.id, version: published.release!.version } }), 409);
  });
});
