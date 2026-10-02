import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { packDetailSchema, packListSchema, type PackDetail, type PackManifest } from "@idream/shared/packs";
import { prisma } from "@/server/lib/db";
import { providers } from "@/server/providers";
import { AGE_GATE_COOKIE_HEADER, api, createMedia, createUser, expectError, expectOk, purgeTestData } from "@/server/test/helpers";
import { adminV2Route, type AdminV2RouteOptions } from "@/server/test/admin-v2-route-client";
import { GET as adminList } from "@/app/api/v2/admin/packs/route";
import { GET as adminDetail } from "@/app/api/v2/admin/packs/[id]/route";
import { POST as adminBlock } from "@/app/api/v2/admin/packs/[id]/block/route";
import { ACCOUNT_DELETION_GRACE_PERIOD_MS, acceptChatAccountErasureCompletion, accountDeletionSubjectHash, dispatchPendingAccountDeletionBlobDeletes, requestAccountDeletion } from "@/server/account-deletion-authority";
import { packSnapshotSchema } from "./pack-authority";
import { dispatchV1 } from "./service";

const prefix = "zt-free-pack-";
const owner = `${prefix}owner`, reader = `${prefix}reader`, other = `${prefix}other`, moderator = `${prefix}moderator`;
const authored = { userId: owner, ageGate: true };
const packIds: string[] = [], blobKeys: string[] = [], deletionUserIds: string[] = [];
const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
beforeAll(async () => {
  for (const id of [owner, reader, other]) await createUser({ id, dataClass: "customer" });
  await createUser({ id: moderator, role: "moderator", dataClass: "internal" });
  // db push omits migration triggers: install the exact deployed invariant.
  const sql = readFileSync("prisma/migrations/20261002010000_free_packs/migration.sql", "utf8");
  const start = sql.indexOf("CREATE FUNCTION idream_pack_release_immutable"), trigger = sql.indexOf("CREATE TRIGGER pack_releases_immutable");
  await prisma.$executeRawUnsafe(sql.slice(start, trigger)); await prisma.$executeRawUnsafe(sql.slice(trigger));
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
afterAll(async () => {
  const releases = await prisma.packRelease.findMany({ where: { packId: { in: packIds } }, select: { manifest: true } });
  for (const release of releases) blobKeys.push(...packSnapshotSchema.parse(release.manifest).items.map(item => item.storageKey));
  await prisma.pack.updateMany({ where: { id: { in: packIds } }, data: { currentReleaseId: null, status: "withdrawn" } });
  await prisma.pack.deleteMany({ where: { id: { in: packIds } } });
  await prisma.controlPlaneCommand.deleteMany({ where: { targetType: "pack", targetId: { in: packIds } } });
  await prisma.adminAuditLog.deleteMany({ where: { targetType: "pack", targetId: { in: packIds } } });
  await prisma.accountDeletion.deleteMany({ where: { subjectHash: { in: deletionUserIds.map(accountDeletionSubjectHash) } } });
  for (const key of new Set(blobKeys)) await providers.blob.delete({ key });
  await purgeTestData(prefix);
  await prisma.$executeRawUnsafe("DROP TRIGGER IF EXISTS pack_releases_immutable ON pack_releases");
  await prisma.$executeRawUnsafe("DROP FUNCTION IF EXISTS idream_pack_release_immutable()");
});
async function asset(label: string, ownerId = owner, type: "image" | "video" | "voice" = "image") {
  const id = `${prefix}${label}`, contentType = type === "image" ? "image/png" : type === "video" ? "video/mp4" : "audio/wav";
  const key = `test-fixtures/${id}`; blobKeys.push(key);
  await providers.blob.putPrivate({ key, body: bytes, contentType });
  if (type === "voice") await prisma.mediaAsset.create({ data: { id, ownerId, type, url: `/api/v1/media/${id}/content`, storageKey: key, contentType, visibility: "private", safetyStatus: "passed", metadata: {} } });
  else await createMedia({ id, ownerId, type, storageKey: key, contentType, prompt: "PRIVATE_GENERATION_PROMPT" });
  return id;
}
async function draft(label: string, options: Partial<PackManifest> = {}, creator = owner) {
  const ids = options.items?.map(item => item.mediaAssetId) ?? [await asset(`${label}-image`, creator)];
  const manifest: PackManifest = { title: `${prefix}${label}`, description: "Only these assets are included; future content is excluded.", visibility: "public", coverAssetId: null, claimUntil: null, items: ids.map(mediaAssetId => ({ mediaAssetId, caption: "Selected item" })), ...options };
  const result = await api("POST", "packs", { userId: creator, ageGate: true, body: manifest }); expectOk(result, 201);
  const pack = packDetailSchema.parse(result.data); packIds.push(pack.id); return { pack, manifest, ids };
}
async function publish(pack: PackDetail, creator = owner) {
  const result = await api("POST", `packs/${pack.id}/publish`, { userId: creator, ageGate: true, body: { version: pack.version } }); expectOk(result); return packDetailSchema.parse(result.data);
}
async function claim(pack: PackDetail, userId = reader) {
  const result = await api("POST", `packs/${pack.id}/claim`, { userId, ageGate: true, body: { version: pack.release!.version, releaseId: pack.release!.id } }); expectOk(result); return packDetailSchema.parse(result.data);
}
async function binary(path: string, userId?: string) {
  const url = new URL(path, "http://localhost");
  return dispatchV1(new Request(url, { headers: { cookie: AGE_GATE_COOKIE_HEADER, ...(userId ? { "x-idream-user-id": userId } : { "x-idream-anonymous-id": "test-age-gate-anonymous" }) } }), url.pathname.replace(/^\/api\/v1\//, "").split("/"));
}
async function block(pack: PackDetail, body: Record<string, unknown> = {}, options: Partial<AdminV2RouteOptions> = {}) {
  return adminV2Route(adminBlock, { path: `packs/${pack.id}/block`, params: { id: pack.id }, userId: moderator, method: "POST", body: { version: pack.version, confirmation: pack.id, reason: "Operator emergency withdrawal.", ...body }, ...options });
}

describe("independent free Packs and exact-version persistent grants", () => {
  it("creates explicit owner-only drafts and a dedicated My AI Pack entry", async () => {
    const { pack, ids } = await draft("draft-owner", { visibility: "private" });
    expect(pack).toMatchObject({ status: "draft", visibility: "private", canManage: true, version: 1, priceCents: 0 });
    expect(pack.manifest!.items).toEqual([{ mediaAssetId: ids[0], caption: "Selected item" }]);
    expectError(await api("GET", `packs/${pack.id}`, { userId: other, ageGate: true }), 404);
    expectError(await api("GET", `packs/${pack.id}`, { ageGate: true }), 404);
    expectError(await api("PATCH", `packs/${pack.id}`, { userId: other, ageGate: true, body: { version: 1, manifest: pack.manifest } }), 404);
    const library = await api("GET", "library/packs", authored); expectOk(library);
    expect(library.data.items).toContainEqual(expect.objectContaining({ type: "pack", href: `/packs/${pack.id}` }));
    expectError(await api("POST", "packs", { ...authored, body: { ...pack.manifest, items: [{ mediaAssetId: await asset("foreign", other), caption: "" }] } }), 400);
  });
  it("offers public metadata and only an explicit cover, keeping full contents and source assets private", async () => {
    const ids = [await asset("public-cover"), await asset("public-video", owner, "video"), await asset("public-voice", owner, "voice")];
    const { pack } = await draft("public-snapshot", { items: ids.map(mediaAssetId => ({ mediaAssetId, caption: mediaAssetId })), coverAssetId: ids[0]! }); const published = await publish(pack);
    const result = await api("GET", `packs/${pack.id}`, { ageGate: true }); expectOk(result); const preview = packDetailSchema.parse(result.data);
    expect(preview.manifest).toBeNull(); expect(preview.release!.canAccess).toBe(false);
    expect(preview.release!.items.every(item => item.url === null && item.downloadUrl === null)).toBe(true);
    expect(JSON.stringify(result.data)).not.toMatch(/PRIVATE_GENERATION_PROMPT|storageKey|sourceMediaAssetId/);
    expect((await binary(preview.coverUrl!)).status).toBe(200);
    expect((await binary(`/api/v1/packs/${pack.id}/releases/${published.release!.id}/items/${ids[1]}/content`)).status).toBe(404);
    expect((await prisma.mediaAsset.findMany({ where: { id: { in: ids } } })).every(item => item.visibility === "private")).toBe(true);
    const snapshot = packSnapshotSchema.parse((await prisma.packRelease.findUniqueOrThrow({ where: { id: published.release!.id } })).manifest);
    expect(snapshot.items.every(item => item.storageKey.startsWith(`packs/${pack.id}/`))).toBe(true);
    expect(snapshot.items.map(item => item.type)).toEqual(["image", "video", "voice"]);
    await expect(prisma.packRelease.update({ where: { id: published.release!.id }, data: { title: "Mutation" } })).rejects.toThrow(/immutable/);
  });
  it("claims once, restores on refresh, rejects a foreign viewer and survives physical Gallery deletion", async () => {
    const { pack, ids } = await draft("grant-persistence"); const published = await publish(pack); const [a, b] = await Promise.all([claim(published), claim(published)]);
    expect(a.grant!.id).toBe(b.grant!.id); expect(await prisma.packGrant.count({ where: { releaseId: published.release!.id, userId: reader } })).toBe(1);
    const restored = await api("GET", `packs/${pack.id}`, { userId: reader, ageGate: true }); expectOk(restored); expect(restored.data.grant.id).toBe(a.grant!.id);
    const url = a.release!.items[0]!.url!; expect((await binary(url, other)).status).toBe(404);
    const source = await prisma.mediaAsset.findUniqueOrThrow({ where: { id: ids[0] } });
    await providers.blob.delete({ key: source.storageKey! }); await prisma.mediaAsset.delete({ where: { id: source.id } });
    const read = await binary(url, reader); expect(read.status).toBe(200); expect(new Uint8Array(await read.arrayBuffer())).toEqual(bytes);
    const download = await binary(a.release!.items[0]!.downloadUrl!, reader); expect(download.headers.get("content-disposition")).toContain("attachment"); expect(download.headers.get("cache-control")).toContain("no-store");
    expect(await prisma.dreamcoinLedger.count({ where: { userId: reader } })).toBe(0);
  });
  it("withdraws distribution but preserves claims without leaking later private editions", async () => {
    const { pack, manifest } = await draft("version-isolation"); const v1 = await publish(pack); const grant = await claim(v1);
    const withdrawn = await api("POST", `packs/${pack.id}/withdraw`, { ...authored, body: { version: v1.version } }); expectOk(withdrawn);
    expectError(await api("POST", `packs/${pack.id}/claim`, { userId: other, ageGate: true, body: { releaseId: v1.release!.id, version: v1.release!.version } }), 409);
    expect((await binary(grant.release!.items[0]!.url!, reader)).status).toBe(200); expectError(await api("GET", `packs/${pack.id}`, { ageGate: true }), 404);
    const changed = await api("PATCH", `packs/${pack.id}`, { ...authored, body: { version: withdrawn.data.version, manifest: { ...manifest, title: "SECRET_NEW_PRIVATE_EDITION", visibility: "private" } } }); expectOk(changed);
    const v2 = await publish(packDetailSchema.parse(changed.data)); const owned = await api("GET", `packs/${pack.id}`, { userId: reader, ageGate: true }); expectOk(owned);
    expect(owned.data.release.id).toBe(v1.release!.id); expect(JSON.stringify(owned.data)).not.toContain("SECRET_NEW_PRIVATE_EDITION");
    expectError(await api("GET", `packs/${pack.id}`, { userId: reader, ageGate: true, query: { release: v2.release!.id } }), 404);
    expect((await binary(v2.release!.items[0]!.url!, reader)).status).toBe(404);
    expectError(await api("GET", `packs/${pack.id}`, { userId: other, ageGate: true, query: { release: v1.release!.id } }), 404);
  });
  it("excludes unlisted Packs from discovery while allowing their explicit free link", async () => {
    const { pack } = await draft("unlisted", { visibility: "unlisted" }); const published = await publish(pack);
    const catalog = await api("GET", "packs", { ageGate: true }); expectOk(catalog); expect(packListSchema.parse(catalog.data).items.some(item => item.id === pack.id)).toBe(false);
    expectOk(await api("GET", `packs/${pack.id}`, { ageGate: true })); expect((await claim(published)).grant).not.toBeNull(); expect((await binary(`/api/v1/packs/${pack.id}/cover`)).status).toBe(404);
  });
  it("stops new claims exactly at expiry without expiring existing grants", async () => {
    const cutoff = new Date(Date.now() + 60_000); const { pack } = await draft("expiry", { claimUntil: cutoff.toISOString() }); const published = await publish(pack);
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(cutoff.getTime() - 1); const grant = await claim(published); vi.setSystemTime(cutoff);
    expectError(await api("POST", `packs/${pack.id}/claim`, { userId: other, ageGate: true, body: { releaseId: published.release!.id, version: published.release!.version } }), 409);
    expectError(await api("GET", `packs/${pack.id}`, { ageGate: true }), 404); expect((await binary(grant.release!.items[0]!.url!, reader)).status).toBe(200); expect((await claim(published)).grant!.id).toBe(grant.grant!.id);
  });
  it("fences concurrent edits during publication and cleans losing snapshot bytes", async () => {
    const { pack, manifest, ids } = await draft("publish-race"); let releaseRead!: () => void, readStarted!: () => void;
    const pending = new Promise<void>(resolve => { releaseRead = resolve; }), started = new Promise<void>(resolve => { readStarted = resolve; });
    const original = providers.blob.getPrivate!.bind(providers.blob);
    vi.spyOn(providers.blob, "getPrivate").mockImplementation(async input => { if (input.key.includes(ids[0]!)) { readStarted(); await pending; } return original(input); });
    const put = vi.spyOn(providers.blob, "putPrivate"); const publication = api("POST", `packs/${pack.id}/publish`, { ...authored, body: { version: pack.version } }); await started;
    expectOk(await api("PATCH", `packs/${pack.id}`, { ...authored, body: { version: pack.version, manifest: { ...manifest, title: "Newer draft" } } }));
    releaseRead(); expectError(await publication, 409); expect(await prisma.packRelease.count({ where: { packId: pack.id } })).toBe(0);
    const staged = put.mock.calls.find(([input]) => input.key.startsWith(`packs/${pack.id}/`))![0].key; expect((await original({ key: staged })).ok).toBe(false);
    expectError(await api("PATCH", `packs/${pack.id}`, { ...authored, body: { version: pack.version, manifest } }), 409);
  });
  it("blocks through Admin v2 once and retains grant receipts with 410 content", async () => {
    const { pack } = await draft("blocked"); const published = await publish(pack), grant = await claim(published);
    expectOk(await adminV2Route(adminList, { path: "packs", userId: moderator })); expectOk(await adminV2Route(adminDetail, { path: `packs/${pack.id}`, params: { id: pack.id }, userId: moderator }));
    expectError(await block(published, {}, { idempotencyKey: false }), 400); expectError(await block(published, { confirmation: "different" }), 400); expectError(await block(published, {}, { userId: other }), 403);
    const idempotencyKey = crypto.randomUUID(), first = await block(published, {}, { idempotencyKey }); expectOk(first); const replay = await block(published, {}, { idempotencyKey }); expectOk(replay); expect(replay.data).toEqual(first.data);
    expect(await prisma.adminAuditLog.count({ where: { targetType: "pack", targetId: pack.id, action: "pack.block" } })).toBe(1); expectError(await block(published, { reason: "Different payload" }, { idempotencyKey }), 409);
    const receipt = await api("GET", `packs/${pack.id}`, { userId: reader, ageGate: true }); expectOk(receipt); expect(receipt.data.grant.id).toBe(grant.grant!.id); expect(receipt.data.release.canAccess).toBe(false);
    expect((await binary(grant.release!.items[0]!.url!, reader)).status).toBe(410);
    expectError(await api("POST", `packs/${pack.id}/claim`, { userId: other, ageGate: true, body: { releaseId: published.release!.id, version: published.release!.version } }), 409);
  });
  it("retains foreign grants after full creator erasure and deletes ungranted snapshots", async () => {
    const creator = `${prefix}erased-creator`; deletionUserIds.push(creator); await createUser({ id: creator, dataClass: "customer" });
    const a = await draft("erasure-kept", {}, creator), b = await draft("erasure-ungranted", {}, creator);
    const kept = await publish(a.pack, creator), dropped = await publish(b.pack, creator), grant = await claim(kept);
    const droppedKeys = packSnapshotSchema.parse((await prisma.packRelease.findUniqueOrThrow({ where: { id: dropped.release!.id } })).manifest).items.map(item => item.storageKey);
    const deletion = await prisma.$transaction(tx => requestAccountDeletion(tx, { userId: creator, now: new Date(Date.now() - ACCOUNT_DELETION_GRACE_PERIOD_MS - 10_000) }));
    expectError(await api("GET", `packs/${kept.id}`, { ageGate: true }), 404); expectOk(await api("GET", `packs/${kept.id}`, { userId: reader, ageGate: true }));
    await prisma.$transaction(tx => acceptChatAccountErasureCompletion(tx, { sourceEventId: `${prefix}erasure-chat-completion`, aggregateId: creator, payload: { version: 2, binding: "request_bound", userId: creator, fileMutationId: `${prefix}file-mutation`, deletionRequestEventId: `user_deleted_${creator}` } }));
    const result = await dispatchPendingAccountDeletionBlobDeletes({ deletionIds: [deletion.id], workerId: `${prefix}blob-worker` }); expect(result.failed).toBe(0); expect(result.completed).toBe(1);
    expect(await prisma.user.findUnique({ where: { id: creator } })).toBeNull(); expect(await prisma.pack.findUnique({ where: { id: dropped.id } })).toBeNull();
    for (const key of droppedKeys) expect((await providers.blob.getPrivate!({ key })).ok).toBe(false);
    const restored = await api("GET", `packs/${kept.id}`, { userId: reader, ageGate: true }); expectOk(restored); expect(restored.data.creator.id).toBeNull(); expect(restored.data.manifest).toBeNull(); expect(restored.data.grant.id).toBe(grant.grant!.id);
    expect((await binary(grant.release!.items[0]!.url!, reader)).status).toBe(200); expect((await binary(grant.release!.items[0]!.url!, other)).status).toBe(404);
  });
});
