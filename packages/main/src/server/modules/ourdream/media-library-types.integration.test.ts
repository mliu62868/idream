import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseWorkspaceMediaResponse } from "@/lib/public-api-contracts";
import { prisma } from "@/server/lib/db";
import { api, createUser, expectError, expectOk } from "@/server/test/helpers";

const prefix = `media-types-${randomUUID()}`;
const ownerId = `${prefix}-owner`;
const otherId = `${prefix}-other`;
const prompt = `Rainy gallery ${prefix}`;
const assetId = (suffix: string) => `${prefix}-${suffix}`;
const ids = (items: Array<{ id: string }>) => items.map(item => item.id);

beforeAll(async () => {
  await createUser({ id: ownerId });
  await createUser({ id: otherId });
  const rows = [
    { suffix: "voice-new", type: "voice", visibility: "private" },
    { suffix: "image", type: "image", visibility: "private" },
    { suffix: "voice-middle", type: "voice", visibility: "private" },
    { suffix: "video", type: "video", visibility: "private" },
    { suffix: "image-unlisted", type: "image", visibility: "unlisted" },
    { suffix: "video-unlisted", type: "video", visibility: "unlisted" },
    { suffix: "unliked", type: "image", visibility: "private" },
    { suffix: "other", type: "image", visibility: "private", ownerId: otherId },
    { suffix: "deleted", type: "image", visibility: "private", deletedAt: new Date() },
    { suffix: "descriptor", type: "voice", visibility: "private", contentType: "application/vnd.idream.pocket-tts-preset+json" },
  ];
  await prisma.mediaAsset.createMany({ data: rows.map((row, index) => ({
    id: assetId(row.suffix), ownerId: row.ownerId ?? ownerId, type: row.type,
    visibility: row.visibility, deletedAt: row.deletedAt, contentType: row.contentType,
    url: `/user-content/${prefix}-${row.suffix}`, prompt, metadata: {},
    liked: row.suffix !== "unliked", createdAt: new Date(Date.UTC(2025, 0, 1, 0, 0, 20 - index)),
  })) });
  await prisma.mediaLike.createMany({ data: rows.filter(row => row.suffix !== "unliked")
    .map(row => ({ userId: ownerId, mediaAssetId: assetId(row.suffix) })) });
  await prisma.mediaLike.create({ data: { userId: otherId, mediaAssetId: assetId("other") } });
});

afterAll(async () => {
  await prisma.mediaAsset.deleteMany({ where: { ownerId: { in: [ownerId, otherId] } } });
  await prisma.user.deleteMany({ where: { id: { in: [ownerId, otherId] } } });
  await prisma.$disconnect();
});

describe("media kind selection before pagination", () => {
  it("keeps voice in the general liked library while returning only requested gallery kinds", async () => {
    const all = await api("GET", "media", { userId: ownerId, ageGate: true, query: { liked: 1 } });
    expectOk(all);
    expect(ids(all.data.items)).toEqual(["voice-new", "image", "voice-middle", "video", "image-unlisted", "video-unlisted"].map(assetId));
    const visual = await api("GET", "media", { userId: ownerId, ageGate: true, query: { liked: 1, types: "image,video" } });
    expectOk(visual);
    expect(ids(parseWorkspaceMediaResponse({ ok: true, data: visual.data }).items)).toEqual(["image", "video", "image-unlisted", "video-unlisted"].map(assetId));
    const voice = await api("GET", "library/media", { userId: ownerId, ageGate: true, query: { liked: 1, type: "voice" } });
    expectOk(voice);
    expect(ids(voice.data.items)).toEqual([assetId("voice-new"), assetId("voice-middle")]);
    const everyKind = await api("GET", "media", { userId: ownerId, ageGate: true, query: { liked: 1, types: "image,video,voice" } });
    expectOk(everyKind);
    expect(ids(everyKind.data.items)).toEqual(ids(all.data.items));
  });

  it("combines kinds with likes, text, visibility and ownership before advancing the cursor", async () => {
    const query = { liked: 1, types: "image,video", q: prompt, visibility: "private", limit: 1 };
    const first = await api("GET", "media", { userId: ownerId, ageGate: true, query });
    expectOk(first);
    expect(ids(first.data.items)).toEqual([assetId("image")]);
    expect(first.data.nextCursor).toBeTypeOf("string");
    const next = await api("GET", "media", { userId: ownerId, ageGate: true, query: { ...query, cursor: first.data.nextCursor } });
    expectOk(next);
    expect(ids(next.data.items)).toEqual([assetId("video")]);
    expect(next.data.nextCursor).toBeNull();
    const other = await api("GET", "media", { userId: otherId, ageGate: true, query });
    expectOk(other);
    expect(ids(other.data.items)).toEqual([assetId("other")]);
    const wrongKind = await api("GET", "media", { userId: ownerId, ageGate: true, query: { ...query, q: "voice clip" } });
    expectOk(wrongKind);
    expect(wrongKind.data.items).toEqual([]);
  });

  it("rejects empty, unknown or oversized kind lists and ambiguous single/multiple filters", async () => {
    for (const types of ["", "image,audio", "image,video,voice,image", ",image"]) {
      expectError(await api("GET", "media", { userId: ownerId, ageGate: true, query: { types } }), 400);
    }
    expectError(await api("GET", "media", { userId: ownerId, ageGate: true, query: { type: "image", types: "video" } }), 400);
  });
});
