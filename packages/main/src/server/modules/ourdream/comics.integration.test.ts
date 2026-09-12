import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { comicDetailSchema, comicListSchema, type ComicDetail, type ComicManifest } from "@idream/shared/comics";
import { prisma } from "@/server/lib/db";
import { providers } from "@/server/providers";
import { api, createCharacter, createMedia, createUser, expectError, expectOk, publishCharacterForPublicAudience, purgeTestData } from "@/server/test/helpers";
import { adminV2Route, type AdminV2RouteOptions } from "@/server/test/admin-v2-route-client";
import { POST as comicDecisionRoute } from "@/app/api/v2/admin/comics/[id]/decision/route";
import { GET as comicListRoute } from "@/app/api/v2/admin/comics/route";
import { GET as comicDetailRoute } from "@/app/api/v2/admin/comics/[id]/route";
import { dispatchV1 } from "./service";

const prefix = "zt-comic-publishing-";
const owner = `${prefix}owner`;
const other = `${prefix}reader`;
const moderator = `${prefix}moderator`;
const outsider = `${prefix}other-author`;
const authored = { userId: owner, ageGate: true };
const publicRead = { userId: other, ageGate: true };
const comicIds: string[] = [];
const blobKeys: string[] = [];
const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

beforeAll(async () => {
  await createUser({ id: owner, dataClass: "customer" });
  await createUser({ id: other, dataClass: "customer" });
  await createUser({ id: outsider, dataClass: "customer" });
  await createUser({ id: moderator, role: "moderator", dataClass: "internal" });
});

afterAll(async () => {
  await prisma.comic.deleteMany({ where: { creatorId: { startsWith: prefix } } });
  await prisma.controlPlaneCommand.deleteMany({ where: { targetType: "comic", targetId: { in: comicIds } } });
  await prisma.adminAuditLog.deleteMany({ where: { targetType: "comic", targetId: { in: comicIds } } });
  await prisma.moderationEvent.deleteMany({ where: { targetType: "comic", targetId: { in: comicIds } } });
  for (const key of blobKeys) await providers.blob.delete({ key });
  await purgeTestData(prefix);
});

async function image(label: string, ownerId = owner) {
  const id = `${prefix}${label}`;
  const key = `test-fixtures/${id}.png`;
  blobKeys.push(key);
  await providers.blob.putPrivate({ key, body: bytes, contentType: "image/png" });
  await createMedia({ id, ownerId, storageKey: key, contentType: "image/png", prompt: "PRIVATE_GENERATION_PROMPT" });
  return id;
}

async function draft(label: string, visibility: ComicManifest["visibility"] = "public", mediaIds?: string[]) {
  const ids = mediaIds ?? [await image(`${label}-page-a`), await image(`${label}-page-b`)];
  const manifest: ComicManifest = { title: `${prefix}${label}`, description: "A story from an adult creator.", visibility, allowRemix: false,
    episodes: [{ title: "Arrival", pages: ids.map((mediaAssetId, index) => ({ mediaAssetId, caption: `Frame ${index + 1}` })) }] };
  const response = await api("POST", "comics", { ...authored, body: manifest });
  expectOk(response, 201);
  const comic = comicDetailSchema.parse(response.data); comicIds.push(comic.id);
  return { comic, manifest, mediaIds: ids };
}

async function adminDecision(id: string, options: Omit<AdminV2RouteOptions, "path"> & { ageGate?: boolean }) {
  return adminV2Route(comicDecisionRoute, { ...options, method: "POST", path: `comics/${id}/decision`, params: { id },
    body: { confirmation: id, ...(options.body as Record<string, unknown>) } });
}

async function publish(comic: ComicDetail) {
  const submitted = await api("POST", `comics/${comic.id}/submit`, { ...authored, body: { version: comic.version } });
  expectOk(submitted);
  const approved = await adminDecision(comic.id, { userId: moderator, body: { version: submitted.data.version, decision: "approve", reason: "Reviewed all submitted pages." } });
  expectOk(approved);
  return comicDetailSchema.parse(approved.data);
}

async function content(path: string, userId = other) {
  // api() persisted the age gate for this user before the binary read.
  return dispatchV1(new Request(`http://localhost${path}`, { headers: { "x-idream-user-id": userId } }), path.replace(/^\/api\/v1\//, "").split("/"));
}

describe("Comic authoring, exact-version review and revocable publication", () => {
  it("keeps drafts owner-only and never treats visibility alone as a publication grant", async () => {
    const { comic } = await draft("draft-owner");
    expectError(await api("GET", `comics/${comic.id}`, publicRead), 404);
    expectError(await api("GET", `comics/${comic.id}`), 403);
    expectError(await api("PATCH", `comics/${comic.id}`, { userId: outsider, ageGate: true, body: { version: comic.version, manifest: { title: "Hijack", description: "", visibility: "public", episodes: [{ title: "One", pages: [] }] } } }), 404);
    expectOk(await api("GET", `comics/${comic.id}`, authored));
    const ownList = await api("GET", "comics", { ...authored, query: { scope: "mine" } });
    expect(comicListSchema.parse(ownList.data).items.some((item) => item.id === comic.id)).toBe(true);
    expectError(await api("GET", "comics", { ageGate: true, query: { scope: "mine" } }), 401);
  });

  it("uses v2 contracts, requires target confirmation and records each decision once", async () => {
    const { comic } = await draft("v2-review");
    const submitted = await api("POST", `comics/${comic.id}/submit`, { ...authored, body: { version: comic.version } }); expectOk(submitted);
    const list = await adminV2Route(comicListRoute, { path: "comics", userId: moderator }); expectOk(list);
    expect(comicListSchema.parse(list.data).items.some(item => item.id === comic.id)).toBe(true);
    const preview = await adminV2Route(comicDetailRoute, { path: `comics/${comic.id}`, params: { id: comic.id }, userId: moderator }); expectOk(preview);
    expect(preview.data.episodes[0].pages[0].url).toMatch(/^\/user-content\//);
    expectError(await api("GET", `admin/comics/${comic.id}`, { userId: moderator }), 404);
    const body = { version: submitted.data.version, decision: "approve", reason: "Reviewed the exact version." };
    expectError(await adminDecision(comic.id, { userId: moderator, body, idempotencyKey: false }), 400);
    expectError(await adminDecision(comic.id, { userId: moderator, body: { ...body, confirmation: "other" } }), 400);
    const idempotencyKey = crypto.randomUUID();
    const first = await adminDecision(comic.id, { userId: moderator, body, idempotencyKey }); expectOk(first);
    const replay = await adminDecision(comic.id, { userId: moderator, body, idempotencyKey }); expectOk(replay);
    expect(replay.data).toEqual(first.data);
    expect(await prisma.adminAuditLog.count({ where: { targetId: comic.id, action: "comic.approve" } })).toBe(1);
    expectError(await adminDecision(comic.id, { userId: moderator, body: { ...body, reason: "Changed command payload." }, idempotencyKey }), 409);
  });

  it("preserves chapter/page order, publishes the exact version and serves private-source bytes through Comic authority", async () => {
    const { comic, manifest, mediaIds } = await draft("ordered");
    const ordered: ComicManifest = { ...manifest, episodes: [
      { title: "Second scene first", pages: [{ mediaAssetId: mediaIds[1]!, caption: "First in the reader" }] },
      { title: "The beginning", pages: [{ mediaAssetId: mediaIds[0]!, caption: "Second in the reader" }] },
    ] };
    const saved = await api("PATCH", `comics/${comic.id}`, { ...authored, body: { version: comic.version, manifest: ordered } });
    expectOk(saved);
    expectError(await api("POST", `comics/${comic.id}/submit`, { ...authored, body: { version: comic.version } }), 409);
    const published = await publish(comicDetailSchema.parse(saved.data));
    const response = await api("GET", `comics/${comic.id}`, publicRead);
    expectOk(response);
    const read = comicDetailSchema.parse(response.data);
    expect(read.episodes.map((episode) => episode.title)).toEqual(["Second scene first", "The beginning"]);
    expect(read.episodes.flatMap((episode) => episode.pages.map((page) => page.mediaAssetId))).toEqual([...mediaIds].reverse());
    expect(read.canManage).toBe(false);
    expect(JSON.stringify(response.data)).not.toMatch(/PRIVATE_GENERATION_PROMPT|storageKey|sourceJobId|sourceProvenance/);
    expect(response.headers.get("cache-control")).toContain("no-store");
    const imageResponse = await content(read.episodes[0]!.pages[0]!.url!);
    expect(imageResponse.status).toBe(200);
    expect(new Uint8Array(await imageResponse.arrayBuffer())).toEqual(bytes);
    expect(imageResponse.headers.get("location")).toBeNull();
    expect(imageResponse.headers.get("cache-control")).toContain("no-store");
    expect((await prisma.mediaAsset.findMany({ where: { id: { in: mediaIds } }, select: { visibility: true } })).map((asset) => asset.visibility)).toEqual(["private", "private"]);
    expectError(await api("GET", `media/${mediaIds[0]}/content`, publicRead), 404);
    const publicList = comicListSchema.parse((await api("GET", "comics", publicRead)).data);
    expect(publicList.items.some((item) => item.id === comic.id)).toBe(true);
    expect(await prisma.adminAuditLog.findFirst({ where: { action: "comic.approve", targetId: comic.id } })).toMatchObject({ actorId: moderator, before: { status: "pending_review", version: published.version - 1 }, after: { status: "published", version: published.version } });
  });

  it("keeps unlisted publications out of discovery while their direct reader and creator attribution work", async () => {
    const { comic } = await draft("unlisted", "unlisted");
    await publish(comic);
    expectOk(await api("GET", `comics/${comic.id}`, publicRead));
    const list = comicListSchema.parse((await api("GET", "comics", { ...publicRead, query: { creatorId: owner } })).data);
    expect(list.items.some((item) => item.id === comic.id)).toBe(false);
    expectOk(await api("GET", `creators/${owner}`, publicRead));
    expectOk(await api("POST", `users/${owner}/follow`, publicRead));
  });

  it("requires submission, moderator permission and a current version; rejection restores editable draft", async () => {
    const { comic, manifest } = await draft("review");
    const decision = { version: comic.version, decision: "approve", reason: "Reviewed pages." };
    expectError(await adminDecision(comic.id, { userId: moderator, body: decision }), 409);
    expectError(await adminDecision(comic.id, { ...publicRead, body: decision }), 403);
    const submitted = await api("POST", `comics/${comic.id}/submit`, { ...authored, body: { version: comic.version } }); expectOk(submitted);
    expectError(await api("PATCH", `comics/${comic.id}`, { ...authored, body: { version: submitted.data.version, manifest } }), 409);
    expectError(await adminDecision(comic.id, { userId: moderator, body: decision }), 409);
    const rejected = await adminDecision(comic.id, { userId: moderator, body: { version: submitted.data.version, decision: "reject", reason: "Please revise the chapter order." } }); expectOk(rejected);
    expect(rejected.data.status).toBe("draft");
    expect(rejected.data.reviewNote).toContain("chapter order");
    const saved = await api("PATCH", `comics/${comic.id}`, { ...authored, body: { version: rejected.data.version, manifest } }); expectOk(saved);
    expect(saved.data.reviewNote).toBeNull();
    expect(await prisma.adminAuditLog.count({ where: { targetId: comic.id, action: "comic.reject" } })).toBe(1);
  });

  it("serializes competing edits and prevents stale approval after withdrawal", async () => {
    const { comic, manifest } = await draft("concurrent");
    const writes = await Promise.all(["First edit", "Second edit"].map((title) => api("PATCH", `comics/${comic.id}`, { ...authored, body: { version: comic.version, manifest: { ...manifest, title } } })));
    expect(writes.map((result) => result.status).sort()).toEqual([200, 409]);
    const saved = comicDetailSchema.parse(writes.find((result) => result.status === 200)!.data);
    const submitted = await api("POST", `comics/${comic.id}/submit`, { ...authored, body: { version: saved.version } }); expectOk(submitted);
    expectOk(await api("POST", `comics/${comic.id}/withdraw`, { ...authored, body: { version: submitted.data.version } }));
    expectError(await adminDecision(comic.id, { userId: moderator, body: { version: submitted.data.version, decision: "approve", reason: "Stale review cannot publish." } }), 409);
    expect(await prisma.comic.findUnique({ where: { id: comic.id } })).toMatchObject({ status: "withdrawn", publishedAt: null });
  });

  it("requires withdrawing publication before private/delete Gallery mutations and immediately revokes old page URLs", async () => {
    const { comic, mediaIds } = await draft("withdraw");
    const published = await publish(comic);
    const read = comicDetailSchema.parse((await api("GET", `comics/${comic.id}`, publicRead)).data);
    const pageUrl = read.episodes[0]!.pages[0]!.url!;
    expectError(await api("POST", "media/bulk", { ...authored, body: { ids: mediaIds, action: "visibility", visibility: "private" } }), 409);
    expectError(await api("DELETE", `media/${mediaIds[0]}`, authored), 409);
    const withdrawn = await api("POST", `comics/${comic.id}/withdraw`, { ...authored, body: { version: published.version } }); expectOk(withdrawn);
    expectError(await api("GET", `comics/${comic.id}`, publicRead), 404);
    expect((await content(pageUrl)).status).toBe(404);
    expectOk(await api("GET", `comics/${comic.id}`, authored));
    expectOk(await api("POST", "media/bulk", { ...authored, body: { ids: mediaIds, action: "visibility", visibility: "private" } }));
    expectOk(await api("DELETE", `media/${mediaIds[0]}`, authored));
    expect(await prisma.mediaAsset.findUnique({ where: { id: mediaIds[1]! } })).toMatchObject({ deletedAt: null, visibility: "private" });
  });

  it("retains missing-page evidence after hard delete and blocks the whole public publication", async () => {
    const { comic, mediaIds } = await draft("missing-page");
    await publish(comic);
    await prisma.mediaAsset.delete({ where: { id: mediaIds[0]! } });
    expectError(await api("GET", `comics/${comic.id}`, publicRead), 404);
    const own = comicDetailSchema.parse((await api("GET", `comics/${comic.id}`, authored)).data);
    expect(own.pageCount).toBe(2);
    expect(own.episodes[0]!.pages[0]).toMatchObject({ mediaAssetId: null, url: null });
    expect(comicListSchema.parse((await api("GET", "comics", publicRead)).data).items.some((item) => item.id === comic.id)).toBe(false);
  });

  it("blocks publication of foreign, blocked, missing and synthetic media without changing the saved manifest", async () => {
    const foreign = await image("foreign", outsider);
    const blocked = await image("blocked"); await prisma.mediaAsset.update({ where: { id: blocked }, data: { safetyStatus: "blocked" } });
    const synthetic = await image("synthetic"); await prisma.mediaAsset.update({ where: { id: synthetic }, data: { metadata: { synthetic: true } } });
    const { comic, manifest } = await draft("invalid-source");
    for (const mediaAssetId of [foreign, blocked, synthetic, "missing-asset"]) {
      expectError(await api("PATCH", `comics/${comic.id}`, { ...authored, body: { version: comic.version, manifest: { ...manifest, episodes: [{ title: "Invalid", pages: [{ mediaAssetId, caption: "" }] }] } } }), 400);
    }
    expect(await prisma.comic.findUnique({ where: { id: comic.id } })).toMatchObject({ version: comic.version, title: manifest.title });
    expectError(await api("PATCH", `comics/${comic.id}`, { ...authored, body: { version: comic.version, manifest: { ...manifest, description: "underage content" } } }), 403);
  });

  it("enforces empty/private submit rules, scoped cursors and author suspension at read time", async () => {
    const { comic, manifest } = await draft("constraints", "private", []);
    expectError(await api("POST", `comics/${comic.id}/submit`, { ...authored, body: { version: comic.version } }), 400);
    const saved = await api("PATCH", `comics/${comic.id}`, { ...authored, body: { version: comic.version, manifest: { ...manifest, visibility: "public" } } }); expectOk(saved);
    expectError(await api("POST", `comics/${comic.id}/submit`, { ...authored, body: { version: saved.data.version } }), 400);
    const page = comicListSchema.parse((await api("GET", "comics", { ...authored, query: { scope: "mine", limit: 1 } })).data);
    expect(page.nextCursor).not.toBeNull();
    expectError(await api("GET", "comics", { ...publicRead, query: { cursor: page.nextCursor! } }), 400);
    expectError(await api("GET", "comics", { ...publicRead, query: { cursor: "garbage" } }), 400);
    const next = comicListSchema.parse((await api("GET", "comics", { ...authored, query: { scope: "mine", limit: 1, cursor: page.nextCursor! } })).data);
    expect(next.items[0]?.id).not.toBe(page.items[0]?.id);
    const published = await publish((await draft("suspended")).comic);
    await prisma.user.update({ where: { id: owner }, data: { status: "suspended" } });
    try { expectError(await api("GET", `comics/${published.id}`, publicRead), 404); }
    finally { await prisma.user.update({ where: { id: owner }, data: { status: "active" } }); }
  });

  it("projects only currently public Character provenance and removes it when that Character becomes private", async () => {
    const characterId = `${prefix}public-character`;
    await createCharacter({ id: characterId, creatorId: owner });
    await publishCharacterForPublicAudience({ characterId, ownerId: owner });
    const { comic, mediaIds } = await draft("provenance");
    await prisma.mediaAsset.update({ where: { id: mediaIds[0]! }, data: { characterId } });
    await publish(comic);
    const read = comicDetailSchema.parse((await api("GET", `comics/${comic.id}`, publicRead)).data);
    expect(read.episodes[0]!.pages[0]!.character).toMatchObject({ id: characterId, remixHref: `/generate?characterId=${characterId}` });
    await prisma.character.update({ where: { id: characterId }, data: { visibility: "private" } });
    const changed = comicDetailSchema.parse((await api("GET", `comics/${comic.id}`, publicRead)).data);
    expect(changed.episodes[0]!.pages[0]!.character).toBeNull();
  });
});
