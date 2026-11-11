import { createHash, randomUUID } from "node:crypto";
import sharp from "sharp";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { characterMediaLibraryQuerySchema, type CharacterMediaLibraryCreateRequest } from "@idream/shared/admin";
import { prisma } from "@/server/lib/db";
import { Errors } from "@/server/lib/errors";
import { logger } from "@/server/lib/logger";
import { OPERATOR_UPLOAD_AUTHORITY_SCHEMA } from "@/server/lib/media-asset-authority";
import { providers } from "@/server/providers";
import { characterVisualProfileSnapshotHash } from "@/server/modules/admin-v2/characters/release-snapshot";
import { GET as getContent } from "@/app/api/v2/admin/characters/[id]/media-library/[entryId]/content/route";
import {
  createCharacterMediaLibraryEntry, describeCharacterMediaLibraryAsset, listCharacterMediaLibrary,
  previewCharacterMediaLibrarySearch, readCharacterMediaLibraryContent, updateCharacterMediaLibraryEntry,
} from "./admin-service";
import { libraryDescriptorHash } from "./service";
import * as models from "./media-models";

const prefix = `zt-library-admin-${randomUUID()}`;
const actor = { id: `${prefix}-publisher`, role: "admin" as const };
const editor = { id: `${prefix}-editor`, role: "user" as const };
const keys = new Set<string>();
const realPut = providers.blob.putPrivate.bind(providers.blob);

beforeAll(async () => {
  await prisma.user.createMany({ data: [actor, editor].map(user => ({ ...user, email: `${user.id}@example.test`, dataClass: "fixture" })) });
  await prisma.adminUserPermission.createMany({ data: ["character.project.write", "creative.run.write"].map(permissionKey => ({
    userId: editor.id, permissionKey, effect: "grant", reason: "Fixture author without publication permission", createdById: actor.id,
  })) });
});
beforeEach(() => {
  vi.stubEnv("MEDIA_LIBRARY_EMBEDDING_URL", "http://embedding.test.invalid/v1");
  vi.stubEnv("MEDIA_LIBRARY_EMBEDDING_MODEL", "fixture-embedding");
  vi.stubEnv("MEDIA_LIBRARY_EMBEDDING_DIMENSIONS", "2");
  vi.stubEnv("MEDIA_LIBRARY_VISION_URL", "http://vision.test.invalid/v1");
  vi.stubEnv("MEDIA_LIBRARY_VISION_MODEL", "fixture-vision");
  vi.stubEnv("MEDIA_LIBRARY_RERANK_URL", "");
  vi.stubEnv("MEDIA_LIBRARY_RERANK_MODEL", "");
  vi.stubEnv("ADMIN_BFF_SIGNING_SECRET", "");
  vi.spyOn(models, "embedMediaText").mockResolvedValue({ model: "fixture-embedding", dimensions: 2, vector: [1, 0] });
  vi.spyOn(models, "describeMediaFrames").mockResolvedValue({ description: "A blue image without text", facts: ["Blue"], absentFacts: ["text"], nudity: "none", model: "fixture-vision" });
  vi.spyOn(providers.blob, "putPrivate").mockImplementation(async input => { keys.add(input.key); return realPut(input); });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
afterAll(async () => {
  await prisma.characterMediaLibraryEntry.deleteMany({ where: { characterId: { startsWith: prefix } } });
  await prisma.controlPlaneCommand.deleteMany({ where: { actorId: { in: [actor.id, editor.id] } } });
  await prisma.adminAuditLog.deleteMany({ where: { actorId: { in: [actor.id, editor.id] } } });
  await prisma.characterServing.deleteMany({ where: { characterId: { startsWith: prefix } } });
  await prisma.characterRelease.deleteMany({ where: { id: { startsWith: prefix } } });
  await prisma.characterVisualProfile.deleteMany({ where: { characterId: { startsWith: prefix } } });
  await prisma.mediaAsset.deleteMany({ where: { characterId: { startsWith: prefix } } });
  await prisma.character.deleteMany({ where: { id: { startsWith: prefix } } });
  await prisma.adminUserPermission.deleteMany({ where: { userId: editor.id } });
  await prisma.user.deleteMany({ where: { id: { in: [actor.id, editor.id] } } });
  for (const key of keys) await providers.blob.delete({ key });
});

async function fixture() {
  const characterId = `${prefix}-${randomUUID()}`;
  await prisma.character.create({ data: { id: characterId, name: "Library fixture", age: 28, description: "A controlled library fixture", source: "official", status: "approved", appearance: {}, advancedDetails: {} } });
  const bytes = await sharp({ create: { width: 32, height: 48, channels: 3, background: "#244fbb" } }).png().toBuffer();
  const digest = createHash("sha256").update(bytes).digest("hex");
  const sourceAssetId = `${characterId}-source`;
  const sourceKey = `${characterId}/source.png`;
  const stored = await providers.blob.putPrivate({ key: sourceKey, body: bytes, contentType: "image/png" });
  if (!stored.ok) throw new Error("Source fixture could not be written");
  await prisma.mediaAsset.create({ data: { id: sourceAssetId, ownerId: actor.id, characterId, type: "image", url: `/user-content/${sourceAssetId}/source.png`, storageKey: sourceKey,
    contentType: "image/png", visibility: "private", safetyStatus: "passed", metadata: {
      source: "admin_asset_upload", synthetic: false, sha256: digest, purpose: "character_library",
      uploadAuthority: { schemaVersion: OPERATOR_UPLOAD_AUTHORITY_SCHEMA, kind: "operator_upload", assetId: sourceAssetId, uploadedById: actor.id, sha256: digest },
      platformAsset: { purpose: "character_library", status: "generated" },
    } } });
  const values = { characterId, version: 1, status: "active", style: "realistic", identityPrompt: "Stable adult identity",
    negativeIdentityPrompt: null, faceTraits: {}, hairTraits: {}, bodyTraits: {}, signatureTraits: {}, styleTraits: {}, anchorAssetIds: [sourceAssetId], adapterRefs: {}, createdFrom: "test", evidenceState: "qualified" };
  const visual = await prisma.characterVisualProfile.create({ data: { ...values, immutableHash: characterVisualProfileSnapshotHash(values) } });
  const body: CharacterMediaLibraryCreateRequest = { sourceAssetId, expectedVisualProfileId: visual.id, expectedVisualProfileVersion: visual.version,
    description: "A blue image without text", facts: ["BLUE", "blue"], absentFacts: ["text"], nudity: "none", status: "draft" };
  return { characterId, sourceAssetId, sourceKey, bytes, digest, visual, visualValues: values, body };
}
function mutation(characterId: string, who: { id: string; role: "admin" | "user" } = actor) { return { characterId, actor: who, idempotencyKey: randomUUID(), requestId: randomUUID() }; }
async function stored(entryId: string) { return prisma.characterMediaLibraryEntry.findUniqueOrThrow({ where: { id: entryId } }); }
function previewRequest(range?: string) { return new Request("http://admin.test/content", { headers: range ? { range } : undefined }); }

describe("Admin Character chat library persistence", () => {
  it("creates and replays one owned copy, then revisions and reindexes published descriptions", async () => {
    const f = await fixture();
    const input = { ...mutation(f.characterId, editor), body: f.body };
    const put = vi.mocked(providers.blob.putPrivate); put.mockClear();
    const first = await createCharacterMediaLibraryEntry(input);
    const replay = await createCharacterMediaLibraryEntry({ ...input, requestId: randomUUID() });
    expect(replay).toEqual({ ...first, replayed: true });
    expect(put).toHaveBeenCalledTimes(2);
    expect(first.entry).toMatchObject({ revision: 1, status: "draft", facts: ["blue"], sourceSha256: f.digest });
    expect(first.entry.url).toBe(`/api/v2/admin/characters/${f.characterId}/media-library/${first.entry.id}/content`);
    const row = await stored(first.entry.id);
    expect(row.storageKey).not.toBe(f.sourceKey);
    expect(row.embeddingHash).toBe(libraryDescriptorHash(row));
    expect(await prisma.characterMediaLibraryEntry.count({ where: { characterId: f.characterId } })).toBe(1);

    const draftUpdate = await updateCharacterMediaLibraryEntry({ ...mutation(f.characterId, editor), entryId: row.id, body: { expectedRevision: 1, description: "A verified blue field without text" } });
    expect(draftUpdate.entry.revision).toBe(2);
    const publication = { ...mutation(f.characterId), entryId: row.id, body: { expectedRevision: 2, status: "published" as const } };
    const published = await updateCharacterMediaLibraryEntry(publication);
    expect(published.entry).toMatchObject({ status: "published", revision: 3 });
    expect((await stored(row.id)).publishedAt).not.toBeNull();
    expect(await updateCharacterMediaLibraryEntry(publication)).toEqual({ ...published, replayed: true });
    const beforeEdit = await stored(row.id);
    const edited = await updateCharacterMediaLibraryEntry({ ...mutation(f.characterId), entryId: row.id, body: { expectedRevision: 3, description: "An accurately reviewed blue background", facts: ["blue background"] } });
    const afterEdit = await stored(row.id);
    expect(edited.entry.revision).toBe(4);
    expect(afterEdit.embeddingHash).not.toBe(beforeEdit.embeddingHash);
    expect(afterEdit.embeddingHash).toBe(libraryDescriptorHash(afterEdit));
    await expect(updateCharacterMediaLibraryEntry({ ...mutation(f.characterId), entryId: row.id, body: { expectedRevision: 3, description: "A stale overwrite" } }))
      .rejects.toMatchObject({ status: 409, code: "conflict" });
    const list = await listCharacterMediaLibrary({ characterId: f.characterId, query: characterMediaLibraryQuerySchema.parse({ status: "published", mediaType: "image" }) });
    expect(list.items.map(item => item.id)).toEqual([row.id]);
    expect(list.capabilities).toEqual({ describe: true, search: true });
  });

  it("enforces publication permission for initial publication, live edits and withdrawal", async () => {
    const f = await fixture();
    await expect(createCharacterMediaLibraryEntry({ ...mutation(f.characterId, editor), body: { ...f.body, status: "published" } })).rejects.toMatchObject({ status: 403 });
    const { entry } = await createCharacterMediaLibraryEntry({ ...mutation(f.characterId), body: { ...f.body, status: "published" } });
    for (const body of [{ expectedRevision: 1, description: "A changed live description" }, { expectedRevision: 1, status: "withdrawn" as const }]) {
      await expect(updateCharacterMediaLibraryEntry({ ...mutation(f.characterId, editor), entryId: entry.id, body })).rejects.toMatchObject({ status: 403 });
    }
    expect((await stored(entry.id)).revision).toBe(1);
    expect((await stored(entry.id)).status).toBe("published");
  });

  it("withdraws without embedding or source availability and keeps later edits publication-protected", async () => {
    const f = await fixture();
    const { entry } = await createCharacterMediaLibraryEntry({ ...mutation(f.characterId), body: { ...f.body, status: "published" } });
    vi.mocked(models.embedMediaText).mockClear().mockRejectedValue(Errors.unavailable("Embedding offline"));
    await providers.blob.delete({ key: f.sourceKey });
    await prisma.mediaAsset.update({ where: { id: f.sourceAssetId }, data: { deletedAt: new Date() } });
    const result = await updateCharacterMediaLibraryEntry({ ...mutation(f.characterId), entryId: entry.id, body: { expectedRevision: 1, status: "withdrawn" } });
    expect(result.entry).toMatchObject({ status: "withdrawn", revision: 2 });
    expect(models.embedMediaText).not.toHaveBeenCalled();
    await expect(updateCharacterMediaLibraryEntry({ ...mutation(f.characterId, editor), entryId: entry.id, body: { expectedRevision: 2, description: "Try to bypass withdrawal permission" } })).rejects.toMatchObject({ status: 403 });
    const preview = await readCharacterMediaLibraryContent({ characterId: f.characterId, entryId: entry.id, thumbnail: false, request: previewRequest() });
    expect(new Uint8Array(await preview.arrayBuffer())).toEqual(new Uint8Array(f.bytes));
  });

  it("rejects private user media even when it belongs to the same Character", async () => {
    const f = await fixture();
    await prisma.mediaAsset.update({ where: { id: f.sourceAssetId }, data: { ownerId: editor.id, metadata: { synthetic: false, sha256: f.digest } } });
    const put = vi.mocked(providers.blob.putPrivate); put.mockClear();
    await expect(createCharacterMediaLibraryEntry({ ...mutation(f.characterId), body: f.body })).rejects.toMatchObject({ status: 403 });
    await expect(describeCharacterMediaLibraryAsset({ ...mutation(f.characterId), body: { sourceAssetId: f.sourceAssetId } })).rejects.toMatchObject({ status: 403 });
    expect(put).not.toHaveBeenCalled();
    expect(models.describeMediaFrames).not.toHaveBeenCalled();
    expect(await prisma.characterMediaLibraryEntry.count({ where: { characterId: f.characterId } })).toBe(0);
  });

  it("replays one frame observation without saving or publishing its suggestion", async () => {
    const f = await fixture(); const input = { ...mutation(f.characterId), body: { sourceAssetId: f.sourceAssetId } };
    const first = await describeCharacterMediaLibraryAsset(input);
    expect(await describeCharacterMediaLibraryAsset(input)).toEqual(first);
    expect(first).toMatchObject({ sourceSha256: f.digest, facts: ["blue"], model: "fixture-vision" });
    expect(models.describeMediaFrames).toHaveBeenCalledTimes(1);
    expect(await prisma.characterMediaLibraryEntry.count({ where: { characterId: f.characterId } })).toBe(0);
  });

  it("searches only published entries with observed required and absent facts", async () => {
    const f = await fixture(); const { entry } = await createCharacterMediaLibraryEntry({ ...mutation(f.characterId), body: f.body });
    const body = { mediaType: "image" as const, query: "blue without text", requiredFacts: ["blue"], excludedFacts: ["text"], nudity: "none" as const };
    expect((await previewCharacterMediaLibrarySearch({ characterId: f.characterId, body })).matches).toEqual([]);
    await updateCharacterMediaLibraryEntry({ ...mutation(f.characterId), entryId: entry.id, body: { expectedRevision: 1, status: "published" } });
    expect((await previewCharacterMediaLibrarySearch({ characterId: f.characterId, body })).matches.map(match => match.entry.id)).toEqual([entry.id]);
    expect((await previewCharacterMediaLibrarySearch({ characterId: f.characterId, body: { ...body, excludedFacts: ["hat"] } })).matches).toEqual([]);
  });

  it("keeps the live Release pin usable while a new identity is active, then retires the old pin without losing withdrawal", async () => {
    const f = await fixture();
    const livePin = { visualProfileId: f.visual.id, visualProfileVersion: f.visual.version };
    const releaseData = { id: `${f.characterId}-release-v1`, projectId: `${f.characterId}-project`,
      revisionId: `${f.characterId}-revision`, characterContentVersionId: `${f.characterId}-content`,
      generationProvenance: {}, releasePlacementManifest: {}, snapshotHash: f.digest, status: "published" };
    const release = await prisma.characterRelease.create({ data: { ...releaseData, ...livePin } });
    await prisma.character.update({ where: { id: f.characterId }, data: { visibility: "public" } });
    await prisma.characterServing.create({ data: { characterId: f.characterId, currentReleaseId: release.id, state: "live" } });
    await prisma.characterVisualProfile.update({ where: { id: f.visual.id }, data: { status: "archived" } });
    const values = { ...f.visualValues, version: 2 };
    const production = await prisma.characterVisualProfile.create({ data: { ...values, immutableHash: characterVisualProfileSnapshotHash(values) } });
    const productionPin = { visualProfileId: production.id, visualProfileVersion: production.version };

    const observation = { sourceAssetId: f.sourceAssetId, visualIdentity: livePin };
    await expect(describeCharacterMediaLibraryAsset({ ...mutation(f.characterId), body: observation })).resolves.toMatchObject({ sourceSha256: f.digest });
    const { entry } = await createCharacterMediaLibraryEntry({ ...mutation(f.characterId), body: { ...f.body, status: "published" } });
    const query = characterMediaLibraryQuerySchema.parse({ mediaType: "image", status: "draft" });
    await expect(listCharacterMediaLibrary({ characterId: f.characterId, query })).resolves.toMatchObject({
      items: [], visualIdentity: productionPin, serving: { releaseId: release.id, visualIdentity: livePin },
      coverage: { production: { published: 0, hasEligibleMedia: false }, serving: { published: 1, hasEligibleMedia: true } },
    });
    const search = { mediaType: "image" as const, query: "blue image", requiredFacts: ["blue"], excludedFacts: [], nudity: "none" as const };
    expect((await previewCharacterMediaLibrarySearch({ characterId: f.characterId, body: search })).matches.map(match => match.entry.id)).toEqual([entry.id]);
    expect((await previewCharacterMediaLibrarySearch({ characterId: f.characterId, body: { ...search, visualIdentity: productionPin } })).matches).toEqual([]);
    const updated = await updateCharacterMediaLibraryEntry({ ...mutation(f.characterId), entryId: entry.id,
      body: { expectedRevision: entry.revision, description: "Reviewed blue image for the live identity" } });
    expect(updated.entry).toMatchObject({ ...livePin, status: "published", revision: entry.revision + 1 });

    const next = await prisma.characterRelease.create({ data: { ...releaseData, id: `${f.characterId}-release-v2`, ...productionPin } });
    await prisma.$transaction([
      prisma.characterServing.update({ where: { characterId: f.characterId }, data: { currentReleaseId: next.id } }),
      prisma.characterRelease.update({ where: { id: release.id }, data: { status: "superseded" } }),
    ]);
    await expect(previewCharacterMediaLibrarySearch({ characterId: f.characterId, body: { ...search, visualIdentity: livePin } })).rejects.toMatchObject({ status: 409 });
    await expect(updateCharacterMediaLibraryEntry({ ...mutation(f.characterId), entryId: entry.id,
      body: { expectedRevision: updated.entry.revision, description: "Cannot edit a retired publication" } })).rejects.toMatchObject({ status: 409 });
    await expect(updateCharacterMediaLibraryEntry({ ...mutation(f.characterId), entryId: entry.id,
      body: { expectedRevision: updated.entry.revision, status: "withdrawn" } })).resolves.toMatchObject({ entry: { ...livePin, status: "withdrawn" } });
  });

  it("reads the owned copy through scoped authentication and preserves 200/206/416 ranges", async () => {
    const f = await fixture(); const { entry } = await createCharacterMediaLibraryEntry({ ...mutation(f.characterId), body: f.body });
    await providers.blob.putPrivate({ key: f.sourceKey, body: new Uint8Array([99]), contentType: "image/png" });
    const input = { characterId: f.characterId, entryId: entry.id, thumbnail: false };
    const complete = await readCharacterMediaLibraryContent({ ...input, request: previewRequest() });
    expect(complete.status).toBe(200); expect(complete.headers.get("cache-control")).toBe("private, no-store");
    expect(new Uint8Array(await complete.arrayBuffer())).toEqual(new Uint8Array(f.bytes));
    const partial = await readCharacterMediaLibraryContent({ ...input, request: previewRequest("bytes=2-7") });
    expect(partial.status).toBe(206); expect(partial.headers.get("content-range")).toBe(`bytes 2-7/${f.bytes.length}`);
    expect(new Uint8Array(await partial.arrayBuffer())).toEqual(new Uint8Array(f.bytes.subarray(2, 8)));
    const invalid = await readCharacterMediaLibraryContent({ ...input, request: previewRequest(`bytes=${f.bytes.length}-`) });
    expect(invalid.status).toBe(416); expect((await invalid.arrayBuffer()).byteLength).toBe(0);
    const routeParams = { params: Promise.resolve({ id: f.characterId, entryId: entry.id }) };
    expect((await getContent(new Request(`http://admin.test${entry.url}`), routeParams)).status).toBe(401);
    expect((await getContent(new Request(`http://admin.test${entry.url}`, { headers: { "x-idream-user-id": editor.id, "x-idream-role": "user" } }), routeParams)).status).toBe(403);
    const authorized = await getContent(new Request(`http://admin.test${entry.url}`, { headers: { "x-idream-user-id": actor.id, "x-idream-role": "admin", range: "bytes=2-7" } }), routeParams);
    expect(authorized.status).toBe(206); expect(new Uint8Array(await authorized.arrayBuffer())).toEqual(new Uint8Array(f.bytes.subarray(2, 8)));
    const row = await stored(entry.id);
    await providers.blob.putPrivate({ key: row.storageKey, body: new Uint8Array([0, 1]), contentType: row.contentType });
    await expect(readCharacterMediaLibraryContent({ ...input, request: previewRequest("bytes=0-0") })).rejects.toMatchObject({ status: 409 });
  });

  it("preserves a committed copy when its cleanup ownership read fails", async () => {
    const f = await fixture();
    const warning = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    vi.spyOn(prisma.characterMediaLibraryEntry, "findUnique").mockRejectedValueOnce(new Error("Cleanup database unavailable"));
    const remove = vi.spyOn(providers.blob, "delete");
    const { entry } = await createCharacterMediaLibraryEntry({ ...mutation(f.characterId), body: f.body });
    expect(await stored(entry.id)).toMatchObject({ characterId: f.characterId });
    expect(remove).not.toHaveBeenCalled(); expect(warning).toHaveBeenCalled();
    const preview = await readCharacterMediaLibraryContent({ characterId: f.characterId, entryId: entry.id, thumbnail: false, request: previewRequest() });
    expect(new Uint8Array(await preview.arrayBuffer())).toEqual(new Uint8Array(f.bytes));
  });

  it("keeps the original mutation failure when cleanup ownership is uncertain", async () => {
    const f = await fixture();
    const warning = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    vi.mocked(providers.blob.putPrivate).mockImplementation(async input => {
      keys.add(input.key);
      if (input.key.endsWith("thumbnail.jpg")) return { ok: false, error: { code: "fixture_failure", message: "Write failed", retryable: true } };
      return realPut(input);
    });
    vi.spyOn(prisma.characterMediaLibraryEntry, "findUnique").mockRejectedValueOnce(new Error("Cleanup database unavailable"));
    const remove = vi.spyOn(providers.blob, "delete");
    await expect(createCharacterMediaLibraryEntry({ ...mutation(f.characterId), body: f.body })).rejects.toMatchObject({ code: "unavailable", message: "The chat library could not preserve its own media file" });
    expect(remove).not.toHaveBeenCalled(); expect(warning).toHaveBeenCalled();
    expect(await prisma.characterMediaLibraryEntry.count({ where: { characterId: f.characterId } })).toBe(0);
  });
});
