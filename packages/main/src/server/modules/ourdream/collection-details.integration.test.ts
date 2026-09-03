import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";
import { api, createMedia, createUser, expectError, expectOk } from "@/server/test/helpers";

const prefix = "zt-collection-detail-";
const owner = `${prefix}owner`;
const other = `${prefix}other`;
const owned = { userId: owner, ageGate: true };

beforeAll(async () => {
  await createUser({ id: owner, dataClass: "customer" });
  await createUser({ id: other, dataClass: "customer" });
});
afterAll(async () => {
  await prisma.mediaCollection.deleteMany({ where: { id: { startsWith: prefix } } });
  await prisma.mediaAsset.deleteMany({ where: { id: { startsWith: prefix } } });
  await prisma.user.deleteMany({ where: { id: { in: [owner, other] } } });
});
async function collection(label: string, count: number, visibility = "public") {
  const id = `${prefix}${label}`;
  const mediaIds = Array.from({ length: count }, (_, i) => `${id}-${String(i + 1).padStart(2, "0")}`);
  for (const [index, mediaId] of mediaIds.entries()) {
    await createMedia({ id: mediaId, ownerId: owner, visibility: "public_pack", type: index === 12 ? "video" : "image" });
  }
  await prisma.mediaCollection.create({ data: { id, name: label, ownerId: owner, visibility, items: { create: mediaIds.map((mediaAssetId, sortOrder) => ({ mediaAssetId, sortOrder })) } } });
  return { id, mediaIds };
}

describe("collection details and membership", () => {
  it("returns all thirteen members with typed content URLs, never generation details", async () => {
    const { id, mediaIds } = await collection("mixed", 13);
    const first = await api("GET", `media/collections/${id}`, { ageGate: true });
    expectOk(first);
    expect(first.headers.get("cache-control")).toContain("no-store");
    expect(first.headers.get("cache-control")).toContain("private");
    expect(first.data.canManage).toBe(false);
    expect(first.data.items).toHaveLength(12);
    expect(first.data.items.map((item: { id: string }) => item.id)).toEqual(mediaIds.slice(0, 12));
    const last = await api("GET", `media/collections/${id}`, { ageGate: true, query: { cursor: first.data.nextCursor } });
    expectOk(last);
    expect(last.data.nextCursor).toBeNull();
    expect(last.data.items).toEqual([{ id: mediaIds[12], type: "video", url: `/user-content/${Buffer.from(mediaIds[12]!).toString("base64url")}/content.mp4` }]);
    expect(JSON.stringify(last.data)).not.toMatch(/storageKey|sourceJobId|provider|prompt/);
  });

  it("checks public audience on every page while owners retain private and empty management", async () => {
    const { id, mediaIds } = await collection("audience", 2);
    const first = await api("GET", `media/collections/${id}`, { ageGate: true, query: { limit: 1 } });
    await prisma.mediaAsset.update({ where: { id: mediaIds[1]! }, data: { visibility: "private" } });
    expectError(await api("GET", `media/collections/${id}`, { ageGate: true, query: { cursor: first.data.nextCursor } }), 404);
    await prisma.mediaAsset.update({ where: { id: mediaIds[1]! }, data: { safetyStatus: "blocked" } });
    const privateView = await api("GET", `media/collections/${id}`, owned);
    expectOk(privateView);
    expect(privateView.data.canManage).toBe(true);
    expect(privateView.data.items).toHaveLength(2);
    expect(privateView.data.items[1].url).toBeNull();
    const empty = await collection("empty", 0, "private");
    expectOk(await api("GET", `media/collections/${empty.id}`, owned));
    expectError(await api("GET", `media/collections/${empty.id}`, { userId: other, ageGate: true }), 404);
  });

  it("keeps a cursor valid after deleting its row and rejects another collection or viewer scope", async () => {
    const { id, mediaIds } = await collection("cursor", 7);
    const first = await api("GET", `media/collections/${id}`, { ...owned, query: { limit: 3 } });
    expectOk(await api("DELETE", `media/collections/${id}/items/${mediaIds[2]}`, owned));
    const next = await api("GET", `media/collections/${id}`, { ...owned, query: { cursor: first.data.nextCursor } });
    expectOk(next);
    expect(next.data.items.map((item: { id: string }) => item.id)).toEqual(mediaIds.slice(3));
    expectError(await api("GET", `media/collections/${id}`, { userId: other, ageGate: true, query: { cursor: first.data.nextCursor } }), 400);
    expectError(await api("GET", `media/collections/${prefix}mixed`, { ...owned, query: { cursor: first.data.nextCursor } }), 400);
    expectError(await api("GET", `media/collections/${id}`, { ...owned, query: { cursor: "bad-cursor" } }), 400);
  });

  it("removes only the owner association, idempotently hides an empty collection, and retains original media", async () => {
    const { id, mediaIds } = await collection("remove", 1);
    const second = `${prefix}second`;
    await prisma.mediaCollection.create({ data: { id: second, ownerId: owner, name: "Also here", visibility: "public", items: { create: { mediaAssetId: mediaIds[0]! } } } });
    expectError(await api("DELETE", `media/collections/${id}/items/${mediaIds[0]}`, { userId: other, ageGate: true }), 404);
    const removed = await api("DELETE", `media/collections/${id}/items/${mediaIds[0]}`, owned);
    expectOk(removed);
    expect(removed.data).toMatchObject({ removed: true, collection: { visibility: "private", itemCount: 0 } });
    expect((await api("DELETE", `media/collections/${id}/items/${mediaIds[0]}`, owned)).data.removed).toBe(false);
    expectError(await api("GET", `media/collections/${id}`, { ageGate: true }), 404);
    expect(await prisma.mediaAsset.findUnique({ where: { id: mediaIds[0]! } })).toMatchObject({ deletedAt: null, visibility: "public_pack" });
    expect(await prisma.mediaCollectionItem.count({ where: { collectionId: second, mediaAssetId: mediaIds[0] } })).toBe(1);
  });

  it("serializes add/remove and assigns increasing order after holes", async () => {
    const { id, mediaIds } = await collection("order", 3);
    await api("DELETE", `media/collections/${id}/items/${mediaIds[1]}`, owned);
    const newIds = [`${id}-new-a`, `${id}-new-b`];
    for (const mediaId of newIds) await createMedia({ id: mediaId, ownerId: owner });
    const writes = await Promise.all(newIds.map((mediaAssetId) => api("POST", `media/collections/${id}/items`, { ...owned, body: { mediaAssetId } })));
    writes.forEach((result) => expectOk(result));
    const rows = await prisma.mediaCollectionItem.findMany({ where: { collectionId: id }, orderBy: { sortOrder: "asc" } });
    expect(rows.map((row) => row.sortOrder)).toEqual([0, 2, 3, 4]);
    const single = await collection("last-race", 1);
    const extra = `${prefix}race-extra`;
    await createMedia({ id: extra, ownerId: owner });
    const race = await Promise.all([
      api("DELETE", `media/collections/${single.id}/items/${single.mediaIds[0]}`, owned),
      api("POST", `media/collections/${single.id}/items`, { ...owned, body: { mediaAssetId: extra } }),
    ]);
    race.forEach((result) => expectOk(result));
    const result = await prisma.mediaCollection.findUniqueOrThrow({ where: { id: single.id }, include: { items: true } });
    expect(result.items.map((item) => item.mediaAssetId)).toEqual([extra]);
  });

  it("paginates beyond twenty public collections with stable tied dates and a separate focused item", async () => {
    const mediaId = `${prefix}list-media`;
    await createMedia({ id: mediaId, ownerId: owner, visibility: "public_pack" });
    const ids = Array.from({ length: 21 }, (_, i) => `${prefix}list-${String(i).padStart(2, "0")}`);
    for (const id of ids) await prisma.mediaCollection.create({ data: { id, name: id, ownerId: owner, visibility: "public", createdAt: new Date("2099-01-01T00:00:00Z"), items: { create: { mediaAssetId: mediaId } } } });
    const first = await api("GET", "community/collections", { ageGate: true, query: { collection: ids[0] } });
    expectOk(first);
    expect(first.data.collections.map((item: { id: string }) => item.id)).toEqual([...ids].reverse());
    const second = await api("GET", "community/collections", { ageGate: true, query: { cursor: first.data.nextCursor } });
    expectOk(second);
    expect(second.data.collections[0].id).toBe(ids[0]);
    expect(first.data.collections[0].previews[0]).toEqual({ id: mediaId, type: "image", url: `/user-content/${Buffer.from(mediaId).toString("base64url")}/content.webp` });
    expectError(await api("GET", "community/collections", { ageGate: true, query: { cursor: "broken" } }), 400);
  });
});
