import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/server/lib/db";
import { api, createUser, expectOk } from "@/server/test/helpers";

const prefix = `media-search-${randomUUID()}`;
const ownerId = `${prefix}-owner`;
const otherId = `${prefix}-other`;
const oldImageId = `${prefix}-older-image`;
const videoId = `${prefix}-video`;
const voiceId = `${prefix}-voice`;

beforeAll(async () => {
  await createUser({ id: ownerId });
  await createUser({ id: otherId });
  await prisma.mediaAsset.createMany({ data: [
    ...Array.from({ length: 40 }, (_, index) => ({
      id: `${prefix}-recent-${index}`, ownerId, type: "image", url: `/user-content/recent-${index}.png`,
      prompt: "Recent image", metadata: {}, createdAt: new Date(Date.UTC(2025, 0, 1, 0, 0, index)),
    })),
    { id: oldImageId, ownerId, type: "image", url: "/user-content/older.png", prompt: "Cobalt moon above the mountains", metadata: {}, createdAt: new Date("2020-01-01") },
    { id: `${prefix}-other-image`, ownerId: otherId, type: "image", url: "/user-content/other.png", prompt: "Cobalt moon for another user", metadata: {}, createdAt: new Date("2020-01-01") },
    { id: `${prefix}-deleted`, ownerId, type: "image", url: "/user-content/deleted.png", prompt: "Cobalt moon deleted", metadata: {}, deletedAt: new Date(), createdAt: new Date("2020-01-01") },
    { id: videoId, ownerId, type: "video", url: "/user-content/video.mp4", prompt: "Cobalt moon in motion", metadata: {}, visibility: "unlisted", createdAt: new Date("2019-01-01") },
    { id: voiceId, ownerId, type: "voice", url: "/user-content/voice.mp3", prompt: null, metadata: {}, createdAt: new Date("2018-01-01") },
  ] });
});

afterAll(async () => {
  await prisma.mediaAsset.deleteMany({ where: { ownerId: { in: [ownerId, otherId] } } });
  await prisma.user.deleteMany({ where: { id: { in: [ownerId, otherId] } } });
  await prisma.$disconnect();
});

describe("Media library search", () => {
  it("searches older delivered media before pagination and respects owner and deletion boundaries", async () => {
    const first = await api("GET", "library/media", { userId: ownerId, ageGate: true });
    expectOk(first);
    expect(first.data.items).toHaveLength(40);
    expect(first.data.items.some((item: { id: string }) => item.id === oldImageId)).toBe(false);
    const found = await api("GET", "library/media", {
      userId: ownerId, ageGate: true, query: { q: "  cObAlT mOoN  ", type: "image" },
    });
    expectOk(found);
    expect(found.data.items.map((item: { id: string }) => item.id)).toEqual([oldImageId]);
    expect(found.data.nextCursor).toBeNull();
    const other = await api("GET", "library/media", {
      userId: otherId, ageGate: true, query: { q: "cobalt moon" },
    });
    expectOk(other);
    expect(other.data.items.map((item: { id: string }) => item.id)).toEqual([`${prefix}-other-image`]);
  });

  it("matches the displayed media kind without searching internal metadata", async () => {
    const result = await api("GET", "library/media", {
      userId: ownerId, ageGate: true, query: { q: "VOICE CLIP" },
    });
    expectOk(result);
    expect(result.data.items.map((item: { id: string }) => item.id)).toEqual([voiceId]);
    await prisma.mediaAsset.update({ where: { id: voiceId }, data: { metadata: { internalTrace: "hidden-route-value" } } });
    const hidden = await api("GET", "library/media", {
      userId: ownerId, ageGate: true, query: { q: "hidden-route-value" },
    });
    expectOk(hidden);
    expect(hidden.data.items).toEqual([]);
  });

  it("combines text search with existing media filters and paginates the matching set", async () => {
    const found = await api("GET", "media", {
      userId: ownerId, ageGate: true, query: { q: "cobalt moon", type: "video", visibility: "unlisted" },
    });
    expectOk(found);
    expect(found.data.items.map((item: { id: string }) => item.id)).toEqual([videoId]);
    const first = await api("GET", "library/media", {
      userId: ownerId, ageGate: true, query: { q: "cobalt moon", limit: 1 },
    });
    expectOk(first);
    expect(first.data.items.map((item: { id: string }) => item.id)).toEqual([oldImageId]);
    expect(first.data.nextCursor).toBeTypeOf("string");
    const next = await api("GET", "library/media", {
      userId: ownerId, ageGate: true, query: { q: "cobalt moon", limit: 1, cursor: first.data.nextCursor },
    });
    expectOk(next);
    expect(next.data.items.map((item: { id: string }) => item.id)).toEqual([videoId]);
    expect(next.data.nextCursor).toBeNull();
  });
});
