import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";
import { providers } from "@/server/providers";
import { api, createCharacter, createMedia, createUser, expectError, expectOk, publishCharacterForPublicAudience, purgeTestData } from "@/server/test/helpers";
import { mediaAssetAuthorityDependencies } from "@/server/modules/admin-v2/shared/media-asset-authority-dependencies";
import { dispatchV1 } from "./service";

const prefix = "zt-collection-publicity-", owner = `${prefix}owner`, reader = `${prefix}reader`;
const owned = { userId: owner, ageGate: true }, publicRead = { userId: reader, ageGate: true };
const keys: string[] = [], bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
beforeAll(async () => { await createUser({ id: owner, dataClass: "customer" }); await createUser({ id: reader, dataClass: "customer" }); });
afterAll(async () => { for (const key of keys) await providers.blob.delete({ key }); await purgeTestData(prefix); });
async function image(label: string) {
  const id = `${prefix}${label}`, key = `test-fixtures/${id}.png`; keys.push(key);
  await providers.blob.putPrivate({ key, body: bytes, contentType: "image/png" });
  await createMedia({ id, ownerId: owner, storageKey: key, contentType: "image/png" }); return id;
}
async function share(id: string) {
  const created = await api("POST", "media/collections", { ...owned, body: { name: "Shared then withdrawn", visibility: "public", mediaAssetId: id } });
  expectOk(created, 201); return created.data.collection.id as string;
}
async function content(id: string, userId: string) {
  return dispatchV1(new Request(`http://localhost/api/v1/media/${id}/content`, { headers: { "x-idream-user-id": userId } }), ["media", id, "content"]);
}
describe("collection publication grants are distinct from retained media references", () => {
  it("withdraws public bytes while retaining a private Character primary image, Look, draft and active generation", async () => {
    const mediaId = await image("private-look"), characterId = `${prefix}private-character`;
    await createCharacter({ id: characterId, creatorId: owner, source: "user", visibility: "private", imageAssetId: mediaId });
    await prisma.mediaAsset.update({ where: { id: mediaId }, data: { characterId } });
    const profile = await prisma.characterVisualProfile.create({ data: { characterId, status: "active", identityPrompt: "Private identity", faceTraits: {}, hairTraits: {}, bodyTraits: {}, signatureTraits: {}, styleTraits: {}, anchorAssetIds: [mediaId], adapterRefs: [], createdFrom: "user" } });
    const look = await prisma.characterLook.create({ data: { characterId, visualProfileId: profile.id, ownerId: owner, label: "Private Look", appearanceDelta: { outfit: "blue jacket" }, referenceAssetId: mediaId, activeKey: `${prefix}look` } });
    await prisma.characterProject.create({ data: { id: `${prefix}draft-project`, characterId, activeKey: `${prefix}draft-project`, draftImageAssetId: mediaId } });
    const job = await prisma.generationJob.create({ data: { id: `${prefix}active-job`, userId: owner, characterId, mode: "image", prompt: "Private variation", controls: { sourceImageAssetId: mediaId }, presetIds: [], idempotencyKey: `${prefix}active-job`, status: "running" } });
    const collectionId = await share(mediaId);
    expectOk(await api("GET", `media/collections/${collectionId}`, publicRead));
    expect((await content(mediaId, reader)).status).toBe(200);
    expect((await mediaAssetAuthorityDependencies(prisma, mediaId)).map(value => value.kind)).toEqual(expect.arrayContaining(["character_primary_image", "character_look", "character_project_draft", "character_generation_job"]));
    expectOk(await api("PATCH", `media/collections/${collectionId}`, { ...owned, body: { visibility: "private" } }));
    const media = await prisma.mediaAsset.findUniqueOrThrow({ where: { id: mediaId } });
    expect(media).toMatchObject({ visibility: "private", deletedAt: null }); expect(media.metadata).not.toHaveProperty("publicViaCollection");
    expect((await content(mediaId, reader)).status).toBe(404);
    const readable = await content(mediaId, owner); expect(readable.status).toBe(200); expect(new Uint8Array(await readable.arrayBuffer())).toEqual(bytes);
    const looks = await api("GET", `characters/${characterId}/looks`, owned); expectOk(looks);
    expect(looks.data.items).toContainEqual(expect.objectContaining({ id: look.id, status: "active", referenceAssetId: mediaId }));
    expect(await prisma.generationJob.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({ status: "running" });
    expectError(await api("GET", `media/collections/${collectionId}`, publicRead), 404);
  });
  it("keeps a qualified live Character publication public after its collection is withdrawn", async () => {
    const characterId = `${prefix}published-character`;
    await createCharacter({ id: characterId, creatorId: owner });
    const published = await publishCharacterForPublicAudience({ characterId, ownerId: owner });
    const asset = await prisma.mediaAsset.findUniqueOrThrow({ where: { id: published.assetId } });
    await prisma.mediaAsset.update({ where: { id: asset.id }, data: { metadata: { ...(asset.metadata as Record<string, unknown>), publicViaCollection: true } } });
    const collectionId = await share(asset.id); expectOk(await api("GET", `characters/${characterId}`, publicRead));
    expectOk(await api("PATCH", `media/collections/${collectionId}`, { ...owned, body: { visibility: "private" } }));
    expect(await prisma.mediaAsset.findUniqueOrThrow({ where: { id: asset.id } })).toMatchObject({ visibility: "public_pack" });
    expectOk(await api("GET", `characters/${characterId}`, publicRead));
  });
  it("keeps published Comic scoped content readable without making its source globally public", async () => {
    const mediaId = await image("comic-page"), collectionId = await share(mediaId);
    const created = await api("POST", "comics", { ...owned, body: { title: `${prefix}Comic`, description: "A reviewed story", visibility: "public", allowRemix: false, episodes: [{ title: "One", pages: [{ mediaAssetId: mediaId, caption: "A frame" }] }] } });
    expectOk(created, 201);
    // Already-reviewed publication fixture; Comic publication itself has its own full integration suite.
    await prisma.comic.update({ where: { id: created.data.id }, data: { status: "published", publishedAt: new Date() } });
    expectOk(await api("PATCH", `media/collections/${collectionId}`, { ...owned, body: { visibility: "private" } }));
    expect(await prisma.mediaAsset.findUniqueOrThrow({ where: { id: mediaId } })).toMatchObject({ visibility: "private" });
    expect((await content(mediaId, reader)).status).toBe(404);
    const comic = await api("GET", `comics/${created.data.id}`, publicRead); expectOk(comic);
    const path = comic.data.episodes[0].pages[0].url as string;
    const page = await dispatchV1(new Request(`http://localhost${path}`, { headers: { "x-idream-user-id": reader } }), path.replace(/^\/api\/v1\//, "").split("/"));
    expect(page.status).toBe(200); expect(new Uint8Array(await page.arrayBuffer())).toEqual(bytes);
  });
});
