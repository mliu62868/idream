import sharp from "sharp";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { prisma } from "@/server/lib/db";
import { Errors } from "@/server/lib/errors";
import * as remoteImage from "@/server/lib/safe-remote-image";
import { providers } from "@/server/providers";
import { api, createUser, purgeTestData } from "@/server/test/helpers";

vi.mock("@/server/lib/safe-remote-image", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/server/lib/safe-remote-image")>(),
  readRemoteImage: vi.fn(),
}));

const prefix = "zt-url-import-";
const owner = `${prefix}owner`;
const other = `${prefix}other`;
const ungated = `${prefix}ungated`;
const deleting = `${prefix}deleting`;
const deletingPut = `${prefix}deleting-put`;
const url = "https://public.example.org/flower.png?signature=secret";
let image: Buffer;
const imports = async () => prisma.mediaAsset.findMany({ where: { ownerId: { in: [owner, other, ungated, deleting, deletingPut] }, metadata: { path: ["source"], equals: "external_url_import" } }, select: { storageKey: true } });

beforeAll(async () => {
  await purgeTestData(prefix);
  await createUser({ id: owner });
  await createUser({ id: other });
  await createUser({ id: ungated });
  await createUser({ id: deleting });
  await createUser({ id: deletingPut });
  image = await sharp({ create: { width: 32, height: 24, channels: 3, background: "red" } }).png().toBuffer();
});
beforeEach(() => {
  vi.restoreAllMocks();
  vi.mocked(remoteImage.readRemoteImage).mockReset().mockResolvedValue({ bytes: image, contentType: "text/html" });
});
afterAll(async () => {
  for (const asset of await imports()) if (asset.storageKey) await providers.blob.delete({ key: asset.storageKey });
  await purgeTestData(prefix);
  await prisma.$disconnect();
});

const post = (key: string, imageUrl = url, userId = owner) => api("POST", "media/import-url", {
  userId, ageGate: true, headers: { "idempotency-key": key }, body: { url: imageUrl },
});

it("imports immutable private bytes, supports exact gallery lookup and recovers a lost response", async () => {
  const key = `${prefix}success`;
  const before = await prisma.dreamcoinLedger.count({ where: { userId: owner } });
  const created = await post(key);
  expect(created.status).toBe(201);
  const id = created.data.assetId;
  const row = await prisma.mediaAsset.findUniqueOrThrow({ where: { id } });
  expect(row).toMatchObject({ ownerId: owner, characterId: null, type: "image", visibility: "private", safetyStatus: "passed", contentType: "image/png", url: "" });
  expect(JSON.stringify(row.metadata)).not.toContain("signature");
  expect(JSON.stringify(row.metadata)).not.toContain(url);
  const bytes = await providers.blob.getPrivate!({ key: row.storageKey! });
  expect(bytes.ok && Buffer.from(bytes.data.body)).toEqual(image);
  const recovered = await api("GET", "media/import-url/request", { userId: owner, ageGate: true, query: { key } });
  expect(recovered.status).toBe(200);
  expect(recovered.data.assetId).toBe(id);
  const replay = await post(key);
  expect(replay.status).toBe(200);
  expect(replay.data.assetId).toBe(id);
  expect(remoteImage.readRemoteImage).toHaveBeenCalledTimes(1);
  expect((await post(key, "https://public.example.org/another.png")).status).toBe(409);
  expect((await api("GET", "media/import-url/request", { userId: other, ageGate: true, query: { key } })).status).toBe(404);
  const list = await api("GET", "media", { userId: owner, ageGate: true, query: { type: "image", assetId: id } });
  expect(list.status).toBe(200);
  expect(list.data.items).toHaveLength(1);
  expect(list.data.items[0]).toMatchObject({ id, characterId: null, visibility: "private" });
  expect(list.data.items[0].imageEditModelIds.length).toBeGreaterThan(0);
  expect((await api("GET", "media", { userId: other, ageGate: true, query: { type: "image", assetId: id } })).data.items).toEqual([]);
  const quote = await api("POST", `media/${id}/variation/quote`, { userId: owner, ageGate: true, body: { consistencyMode: "creative" } });
  expect(quote.status).toBe(200);
  expect(await prisma.dreamcoinLedger.count({ where: { userId: owner } })).toBe(before);
  expect(await prisma.generationJob.count({ where: { userId: owner } })).toBe(0);
});

it("rejects unauthenticated, ungated, credentialed, unsafe and invalid inputs before creating assets", async () => {
  expect((await api("POST", "media/import-url", { ageGate: true, headers: { "idempotency-key": `${prefix}anon` }, body: { url } })).status).toBe(401);
  expect((await api("POST", "media/import-url", { userId: ungated, headers: { "idempotency-key": `${prefix}gate` }, body: { url } })).status).toBe(403);
  expect((await post(`${prefix}credentials`, "https://user:secret@example.org/x")).status).toBe(400);
  expect(remoteImage.readRemoteImage).not.toHaveBeenCalled();
  vi.mocked(remoteImage.readRemoteImage).mockRejectedValueOnce(Errors.conflict("Private address"));
  expect((await post(`${prefix}private`, "http://127.0.0.1/image")).status).toBe(409);
  vi.mocked(remoteImage.readRemoteImage).mockResolvedValueOnce({ bytes: Buffer.from("<svg onload=alert(1)></svg>"), contentType: "image/png" });
  expect((await post(`${prefix}svg`)).status).toBe(409);
  expect((await post(`${prefix}minor`, "https://public.example.org/underage.png")).status).toBe(409);
});

it("does not create an asset if account deletion wins during the download", async () => {
  let started!: () => void, release!: () => void;
  const downloading = new Promise<void>(resolve => { started = resolve; });
  const resume = new Promise<void>(resolve => { release = resolve; });
  vi.mocked(remoteImage.readRemoteImage).mockImplementation(async () => { started(); await resume; return { bytes: image, contentType: "image/png" }; });
  const keys: string[] = [];
  const put = providers.blob.putPrivateFenced!.bind(providers.blob);
  vi.spyOn(providers.blob, "putPrivateFenced").mockImplementation(async input => { keys.push(input.key); return put(input); });
  const pending = post(`${prefix}deleted-race`, url, deleting);
  await downloading;
  await prisma.user.update({ where: { id: deleting }, data: { status: "deleted", deletedAt: new Date() } });
  release();
  expect((await pending).status).toBe(401);
  expect(await prisma.mediaAsset.count({ where: { ownerId: deleting } })).toBe(0);
  expect(keys).toHaveLength(0);
});

it("serializes account deletion with an active Blob PUT", async () => {
  let started!: () => void, release!: () => void;
  const writing = new Promise<void>(resolve => { started = resolve; });
  const resume = new Promise<void>(resolve => { release = resolve; });
  const put = providers.blob.putPrivateFenced!.bind(providers.blob);
  vi.spyOn(providers.blob, "putPrivateFenced").mockImplementationOnce(async input => { started(); await resume; return put(input); });
  const pending = post(`${prefix}delete-during-put`, url, deletingPut);
  await writing;
  let deleted = false;
  const deletion = prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM users WHERE id = ${deletingPut} FOR UPDATE`;
    await tx.user.update({ where: { id: deletingPut }, data: { status: "deleted", deletedAt: new Date() } });
    deleted = true;
  });
  await new Promise(resolve => setTimeout(resolve, 40));
  expect(deleted).toBe(false);
  release();
  const result = await pending;
  await deletion;
  expect(result.status).toBe(201);
  const row = await prisma.mediaAsset.findUniqueOrThrow({ where: { id: result.data.assetId } });
  expect(row.storageKey).toBeTruthy();
  expect((await prisma.user.findUniqueOrThrow({ where: { id: deletingPut } })).status).toBe("deleted");
});

it("rejects a concurrent different URL before writing another Blob", async () => {
  const key = `${prefix}race`;
  const keys: string[] = [];
  const put = providers.blob.putPrivateFenced!.bind(providers.blob);
  vi.spyOn(providers.blob, "putPrivateFenced").mockImplementation(async input => { keys.push(input.key); return put(input); });
  let start!: () => void;
  const barrier = new Promise<void>(resolve => { start = resolve; });
  let count = 0;
  vi.mocked(remoteImage.readRemoteImage).mockImplementation(async () => { if (++count === 2) start(); await barrier; return { bytes: image, contentType: "image/png" }; });
  const results = await Promise.all([post(key, "https://public.example.org/a.png"), post(key, "https://public.example.org/b.png")]);
  expect(results.map(result => result.status).sort()).toEqual([201, 409]);
  expect(keys).toHaveLength(1);
  const ownerAsset = results.find(result => result.status === 201)!.data.assetId;
  const row = await prisma.mediaAsset.findUniqueOrThrow({ where: { id: ownerAsset } });
  expect(keys[0]).toBe(row.storageKey);
});

it("recovers an ambiguous PUT without exposing pending data or allowing a late PUT to overwrite the winner", async () => {
  const key = `${prefix}ambiguous`;
  const firstBytes = image;
  const changedBytes = await sharp({ create: { width: 32, height: 24, channels: 3, background: "blue" } }).png().toBuffer();
  const put = providers.blob.putPrivateFenced!.bind(providers.blob);
  let oldKey = "";
  let oldInput: Parameters<NonNullable<typeof providers.blob.putPrivateFenced>>[0] | undefined;
  vi.spyOn(providers.blob, "putPrivateFenced").mockImplementationOnce(async input => {
    oldKey = input.key;
    oldInput = input;
    await put(input);
    return { ok: false, error: { code: "put_failed", message: "ambiguous", retryable: true } };
  });
  expect((await post(key)).status).toBe(503);
  const pending = await prisma.mediaAsset.findFirstOrThrow({ where: { ownerId: owner, metadata: { path: ["importState"], equals: "pending" } } });
  const stage = await prisma.mediaAsset.findFirstOrThrow({ where: { storageKey: oldKey } });
  expect(pending.safetyStatus).toBe("unknown");
  expect(stage.safetyStatus).toBe("unknown");
  expect((await api("GET", "media/import-url/request", { userId: owner, ageGate: true, query: { key } })).status).toBe(404);
  for (const id of [pending.id, stage.id]) {
    const gallery = await api("GET", "media", { userId: owner, ageGate: true, query: { assetId: id } });
    expect(gallery.data.items).toEqual([]);
    expect((await api("GET", `media/${id}/content`, { userId: owner, ageGate: true })).status).toBe(404);
    expect((await api("GET", `media/${id}/download`, { userId: owner, ageGate: true })).status).toBe(404);
    expect((await api("POST", `media/${id}/variation/quote`, { userId: owner, ageGate: true, body: {} })).status).not.toBe(200);
    expect((await api("POST", `media/${id}/like`, { userId: owner, ageGate: true })).status).toBe(404);
    const bulk = await api("POST", "media/bulk", { userId: owner, ageGate: true, body: { ids: [id], action: "visibility", visibility: "public_pack" } });
    expect(bulk.data.updated).toBe(0);
    await api("DELETE", `media/${id}`, { userId: owner, ageGate: true });
    expect((await prisma.mediaAsset.findUniqueOrThrow({ where: { id } })).deletedAt).toBeNull();
  }
  vi.mocked(remoteImage.readRemoteImage).mockResolvedValue({ bytes: changedBytes, contentType: "image/png" });
  const retry = await post(key);
  expect(retry.status).toBe(201);
  expect(retry.data.assetId).toBe(pending.id);
  const complete = await prisma.mediaAsset.findUniqueOrThrow({ where: { id: pending.id } });
  expect(complete.storageKey).not.toBe(oldKey);
  // Simulate a prior request completing its PUT after the retry committed.
  expect(oldInput).toBeDefined();
  await expect(put({ ...oldInput!, body: firstBytes })).resolves.toMatchObject({ ok: false });
  const actual = await providers.blob.getPrivate!({ key: complete.storageKey! });
  expect(actual.ok && Buffer.from(actual.data.body)).toEqual(changedBytes);
  expect((await prisma.mediaAsset.findUniqueOrThrow({ where: { id: stage.id } })).storageKey).toBe(oldKey);
});

it("returns one asset for concurrent retries of the same import", async () => {
  const key = `${prefix}same-race`;
  let start!: () => void;
  const barrier = new Promise<void>(resolve => { start = resolve; });
  let count = 0;
  vi.mocked(remoteImage.readRemoteImage).mockImplementation(async () => { if (++count === 2) start(); await barrier; return { bytes: image, contentType: "image/png" }; });
  const results = await Promise.all([post(key), post(key)]);
  expect(results.map(result => result.status).sort()).toEqual([200, 201]);
  expect(results[0].data.assetId).toBe(results[1].data.assetId);
  expect(await prisma.mediaAsset.count({ where: { id: results[0].data.assetId, ownerId: owner } })).toBe(1);
});
