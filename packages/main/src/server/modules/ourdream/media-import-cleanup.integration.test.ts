import { createHash, randomUUID } from "node:crypto";
import sharp from "sharp";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { prisma } from "@/server/lib/db";
import * as remoteImage from "@/server/lib/safe-remote-image";
import { providers } from "@/server/providers";
import { createUser, purgeTestData } from "@/server/test/helpers";
import { createRemoteImageImport, readRemoteImageImport } from "./media-url-import";
import { cleanupExpiredMediaImports, IMPORT_STAGING_RETENTION_MS } from "./media-import-staging-cleanup";
import { armImportMarker, dispatchImportMarkerReapers } from "./import-marker-reaper";
import type { Prisma } from "@prisma/client";
import { ACCOUNT_DELETION_GRACE_PERIOD_MS, acceptChatAccountErasureCompletion, accountDeletionSubjectHash, dispatchPendingAccountDeletionBlobDeletes, requestAccountDeletion } from "@/server/account-deletion-authority";
import type { BlobStore } from "@/server/providers/types";

vi.mock("@/server/lib/safe-remote-image", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/server/lib/safe-remote-image")>(),
  readRemoteImage: vi.fn(),
}));

const prefix = "zt-import-fence-e2e-";
const users = ["legacy", "fenced", "unsupported", "expiry", "claim", "late-delete", "late-marker-delete", "late-marker-expire", "held-user", "held-media"].map(name => `${prefix}${name}`);
const heldMarkerIds: string[] = [];
const url = "https://public.example.org/flower.png";
let image: Buffer;
let stored: Map<string, { etag: string; bytes: Uint8Array }>;
let delayedWrite: (() => boolean) | undefined;

async function prepareDeletion(userId: string) {
  const deletion = await prisma.$transaction(tx => requestAccountDeletion(tx, { userId, now: new Date(Date.now() - ACCOUNT_DELETION_GRACE_PERIOD_MS - 10_000) }));
  await prisma.mainOutboxEvent.update({ where: { id: `user_deleted_${userId}` }, data: { status: "delivered", deliveredAt: new Date() } });
  await prisma.$transaction(tx => acceptChatAccountErasureCompletion(tx, { sourceEventId: `${userId}-chat-ack`, aggregateId: userId, payload: { version: 2, binding: "request_bound", userId, fileMutationId: `${userId}-file`, deletionRequestEventId: `user_deleted_${userId}` } }));
  return deletion;
}

// Fault injection is limited to the single idle-in-transaction importer in
// this explicitly named, loopback-only Vitest database. Never target a shared
// database or an unrelated backend when the evidence is ambiguous.
async function disconnectImportTransaction() {
  const testUrl = process.env.DATABASE_URL;
  if (!testUrl) throw new Error("Missing test database authority");
  const parsed = new URL(testUrl);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname) || !/(^|[_-])test([_-]|$)/i.test(parsed.pathname.slice(1))) {
    throw new Error("Refusing fault injection outside the dedicated local database");
  }
  const monitor = new pg.Client({ connectionString: testUrl });
  await monitor.connect();
  try {
    const result = await monitor.query<{ pid: number; query: string }>(`SELECT pid, query FROM pg_stat_activity
      WHERE datname = current_database() AND pid <> pg_backend_pid() AND state = 'idle in transaction'
      AND query ILIKE '%media_assets%'`);
    if (result.rowCount !== 1 || !/^\s*SELECT\b/i.test(result.rows[0]!.query)) {
      throw new Error(`Expected one exact importer transaction, found ${result.rowCount}`);
    }
    const stopped = await monitor.query<{ terminated: boolean }>("SELECT pg_terminate_backend($1) AS terminated", [result.rows[0]!.pid]);
    if (!stopped.rows[0]?.terminated) throw new Error("Could not interrupt the importer transaction");
  } finally { await monitor.end(); }
}

// A deterministic object-store model: If-Match is checked at server commit,
// independently of the client having received a timeout. This is a simulation
// of the required contract, not evidence about any actual S3 installation.
function installFencedStore() {
  const blob = providers.blob as Required<BlobStore>;
  vi.spyOn(blob, "prepareFencedPut").mockImplementation(async ({ key }) => {
    const etag = `"${randomUUID()}"`;
    stored.set(key, { etag, bytes: new Uint8Array([0]) });
    return { ok: true, data: { key, markerEtag: etag } };
  });
  vi.spyOn(blob, "putPrivateFenced").mockImplementation(async ({ key, body, markerEtag }) => {
    delayedWrite = () => {
      if (stored.get(key)?.etag !== markerEtag) return false;
      stored.set(key, { etag: '"image"', bytes: body });
      return true;
    };
    return { ok: false, error: { code: "fenced_put_failed", message: "client timeout", retryable: true } };
  });
  vi.spyOn(blob, "deleteFenced").mockImplementation(async ({ key }) => {
    stored.delete(key);
    return { ok: true, data: { deleted: true } };
  });
  vi.spyOn(blob, "delete").mockImplementation(async ({ key }) => {
    stored.delete(key);
    return { ok: true, data: { deleted: true } };
  });
  return blob;
}

beforeAll(async () => {
  await purgeTestData(prefix);
  for (const id of users) await createUser({ id, dataClass: "customer" });
  image = await sharp({ create: { width: 32, height: 24, channels: 3, background: "red" } }).png().toBuffer();
});
beforeEach(() => {
  stored = new Map();
  delayedWrite = undefined;
  vi.mocked(remoteImage.readRemoteImage).mockReset().mockResolvedValue({ bytes: image, contentType: "image/png" });
});
afterEach(() => { vi.restoreAllMocks(); });
afterAll(async () => {
  await prisma.importMarkerReaper.deleteMany({ where: { id: { in: heldMarkerIds } } });
  await prisma.legalHold.deleteMany({ where: { id: { startsWith: prefix } } });
  await prisma.accountDeletion.deleteMany({ where: { subjectHash: { in: users.map(accountDeletionSubjectHash) } } });
  await purgeTestData(prefix);
  await prisma.$disconnect();
});

it.each(["user", "media"])("retains a %s-held stage even when its marker was already armed", async targetType => {
  const userId = `${prefix}held-${targetType}`, blob = installFencedStore();
  await expect(createRemoteImageImport(userId, `${prefix}held-${targetType}-key`, url)).rejects.toMatchObject({ code: "unavailable" });
  const stage = await prisma.mediaAsset.findFirstOrThrow({ where: { ownerId: userId, metadata: { path: ["importState"], equals: "staging" } } });
  heldMarkerIds.push(stage.id);
  const marker = await prisma.importMarkerReaper.findUniqueOrThrow({ where: { id: stage.id } });
  const now = new Date(Date.now() + IMPORT_STAGING_RETENTION_MS + 10_000);
  await prisma.$transaction(tx => armImportMarker(tx, { stageId: stage.id, key: marker.storageKey, authority: marker.authorityHash }, now));
  const holdId = `${prefix}hold-${targetType}`;
  await prisma.legalHold.create({ data: { id: holdId, targetType, targetId: targetType === "user" ? userId : stage.id,
    caseNumber: `${prefix}case-${targetType}`, reason: "retain staged evidence", approvedById: `${prefix}admin`, createdById: `${prefix}admin` } });
  const scopedDb = { $transaction: prisma.$transaction.bind(prisma), importMarkerReaper: new Proxy(prisma.importMarkerReaper, {
    get(target, property) {
      if (property === "findMany") return (args: Prisma.ImportMarkerReaperFindManyArgs) => target.findMany({ ...args, where: { AND: [args.where ?? {}, { id: stage.id }] } });
      return Reflect.get(target, property, target);
    },
  }) };
  expect(await cleanupExpiredMediaImports({ now, blob })).toMatchObject({ deleted: 0 });
  expect(await dispatchImportMarkerReapers({ now, blob, db: scopedDb })).toEqual({ checked: 0, failed: 1 });
  expect(stored.has(marker.storageKey)).toBe(true);
  expect(await prisma.mediaAsset.findUnique({ where: { id: stage.id } })).not.toBeNull();
  await prisma.legalHold.update({ where: { id: holdId }, data: { status: "released", releasedById: `${prefix}admin`, releasedAt: now } });
  expect(await cleanupExpiredMediaImports({ now: new Date(now.getTime() + 120_000), blob })).toMatchObject({ deleted: 1 });
  expect(stored.has(marker.storageKey)).toBe(false);
});

it("blocks final erasure while an unfenced historical import could still write", async () => {
  const userId = users[0]!;
  const storageKey = `imports/${createHash("sha256").update(userId).digest("hex")}/${randomUUID()}`;
  await prisma.mediaAsset.create({ data: { id: `media_url_stage_${randomUUID()}`, ownerId: userId, type: "image", url: "", storageKey,
    safetyStatus: "unknown", visibility: "private", metadata: { source: "external_url_import", importState: "staging", importParentId: `media_url_import_${"a".repeat(64)}` } } });
  const blob = installFencedStore();
  const deletion = await prepareDeletion(userId);
  const result = await dispatchPendingAccountDeletionBlobDeletes({ deletionIds: [deletion.id], blob });
  // A late unfenced write may still materialize; terminal completion is forbidden.
  stored.set(storageKey, { etag: '"legacy"', bytes: image });
  expect(result.completed).toBe(0);
  expect(await prisma.user.findUnique({ where: { id: userId } })).not.toBeNull();
  expect(stored.has(storageKey)).toBe(true);
});

it("erases a fenced timed-out import and rejects the server's later conditional write", async () => {
  const userId = users[1]!;
  const blob = installFencedStore();
  await expect(createRemoteImageImport(userId, `${prefix}fenced-key`, url)).rejects.toMatchObject({ code: "unavailable" });
  expect(delayedWrite).toBeDefined();
  expect(stored.size).toBe(1);
  const deletion = await prepareDeletion(userId);
  const result = await dispatchPendingAccountDeletionBlobDeletes({ deletionIds: [deletion.id], blob });
  expect(result.completed).toBe(1);
  expect(await prisma.user.findUnique({ where: { id: userId } })).toBeNull();
  expect(delayedWrite!()).toBe(false);
  expect(stored.size).toBe(0);
});

it("retains ownership and retries erasure if fenced deletion is unavailable", async () => {
  const userId = users[2]!;
  const blob = installFencedStore();
  await expect(createRemoteImageImport(userId, `${prefix}unsupported-key`, url)).rejects.toMatchObject({ code: "unavailable" });
  const deletion = await prepareDeletion(userId);
  const unsupported: BlobStore = { putPrivate: blob.putPrivate.bind(blob), signGetUrl: blob.signGetUrl.bind(blob), delete: blob.delete.bind(blob) };
  const first = await dispatchPendingAccountDeletionBlobDeletes({ deletionIds: [deletion.id], blob: unsupported });
  expect(first.failed).toBe(1);
  expect(first.completed).toBe(0);
  expect(await prisma.user.findUnique({ where: { id: userId } })).not.toBeNull();
  expect(stored.size).toBe(1);
  const retry = await dispatchPendingAccountDeletionBlobDeletes({ deletionIds: [deletion.id], blob, now: new Date(Date.now() + 300_000) });
  expect(retry.completed).toBe(1);
  expect(delayedWrite!()).toBe(false);
  expect(stored.size).toBe(0);
});

it("expires a failed fenced stage after retryable deletion and fences late writes", async () => {
  const userId = users[3]!;
  const blob = installFencedStore();
  const key = `${prefix}expiry-key`;
  await expect(createRemoteImageImport(userId, key, url)).rejects.toMatchObject({ code: "unavailable" });
  const stage = await prisma.mediaAsset.findFirstOrThrow({ where: { ownerId: userId, metadata: { path: ["importState"], equals: "staging" } } });
  const now = new Date(Date.now() + IMPORT_STAGING_RETENTION_MS + 10_000);
  const failedDelete = vi.spyOn(blob, "deleteFenced").mockResolvedValueOnce({ ok: false, error: { code: "temporary", message: "unavailable", retryable: true } });
  const first = await cleanupExpiredMediaImports({ now, blob });
  expect(first.failed).toBe(1);
  expect(await prisma.mediaAsset.findUnique({ where: { id: stage.id } })).not.toBeNull();
  expect(stored.size).toBe(1);
  const second = await cleanupExpiredMediaImports({ now: new Date(now.getTime() + 120_000), blob });
  expect(second.deleted).toBe(1);
  expect(await prisma.mediaAsset.findUnique({ where: { id: stage.id } })).toBeNull();
  expect(delayedWrite!()).toBe(false);
  expect(stored.size).toBe(0);
  await expect(readRemoteImageImport(userId, key)).rejects.toMatchObject({ code: "gone" });
  expect(failedDelete).toHaveBeenCalledTimes(2);
});

it("prevents a paused importer from writing after an expired stage has been claimed", async () => {
  const userId = users[4]!;
  const blob = installFencedStore();
  let reserved!: () => void, resumeImporter!: () => void;
  let deleteStarted!: () => void, resumeDelete!: () => void;
  const reservedPromise = new Promise<void>(resolve => { reserved = resolve; });
  const resumeImporterPromise = new Promise<void>(resolve => { resumeImporter = resolve; });
  const deleteStartedPromise = new Promise<void>(resolve => { deleteStarted = resolve; });
  const resumeDeletePromise = new Promise<void>(resolve => { resumeDelete = resolve; });
  const transaction = prisma.$transaction.bind(prisma);
  let calls = 0;
  const transactionSpy = vi.spyOn(prisma, "$transaction").mockImplementation(async (...args) => {
    const first = ++calls === 1;
    const result = await Reflect.apply(transaction, prisma, args);
    if (first) { reserved(); await resumeImporterPromise; }
    return result;
  });
  vi.spyOn(blob, "deleteFenced").mockImplementationOnce(async input => {
    deleteStarted();
    await resumeDeletePromise;
    stored.delete(input.key);
    return { ok: true, data: { deleted: true } };
  });
  const pending = createRemoteImageImport(userId, `${prefix}claim-key`, url);
  let cleanup: ReturnType<typeof cleanupExpiredMediaImports> | undefined;
  try {
    await Promise.race([reservedPromise, pending.then(() => { throw new Error("Importer did not pause after reservation"); })]);
    const stage = await prisma.mediaAsset.findFirstOrThrow({ where: { ownerId: userId, metadata: { path: ["importState"], equals: "staging" } } });
    const now = new Date(Date.now() + IMPORT_STAGING_RETENTION_MS + 10_000);
    cleanup = cleanupExpiredMediaImports({ now, blob });
    await Promise.race([deleteStartedPromise, cleanup.then(() => { throw new Error("Cleanup did not reach the controlled DELETE"); })]);
    resumeImporter();
    await expect(pending).rejects.toMatchObject({ code: "unavailable" });
    expect(blob.prepareFencedPut).not.toHaveBeenCalled();
    expect(blob.putPrivateFenced).not.toHaveBeenCalled();
    resumeDelete();
    expect((await cleanup).deleted).toBe(1);
    expect(await prisma.mediaAsset.findUnique({ where: { id: stage.id } })).toBeNull();
  } finally {
    resumeImporter();
    resumeDelete();
    await pending.catch(() => {});
    await cleanup?.catch(() => {});
    transactionSpy.mockRestore();
  }
});

it("does not let a late cleanup DELETE remove the winner of a new import attempt", async () => {
  const userId = users[5]!;
  const blob = installFencedStore();
  const key = `${prefix}late-delete-key`;
  await expect(createRemoteImageImport(userId, key, url)).rejects.toMatchObject({ code: "unavailable" });
  const oldStage = await prisma.mediaAsset.findFirstOrThrow({ where: { ownerId: userId, metadata: { path: ["importState"], equals: "staging" } } });
  let lateDelete: (() => void) | undefined;
  vi.spyOn(blob, "deleteFenced").mockImplementationOnce(async input => {
    lateDelete = () => { stored.delete(input.key); };
    return { ok: false, error: { code: "fenced_delete_failed", message: "client timeout", retryable: true } };
  });
  const now = new Date(Date.now() + IMPORT_STAGING_RETENTION_MS + 10_000);
  expect((await cleanupExpiredMediaImports({ now, blob })).failed).toBe(1);
  vi.mocked(blob.putPrivateFenced).mockImplementationOnce(async input => {
    if (stored.get(input.key)?.etag !== input.markerEtag) return { ok: false, error: { code: "precondition", message: "marker changed", retryable: false } };
    stored.set(input.key, { etag: '"winner"', bytes: input.body });
    return { ok: true, data: { key: input.key, size: input.body.byteLength } };
  });
  const winner = await createRemoteImageImport(userId, key, url);
  const complete = await prisma.mediaAsset.findUniqueOrThrow({ where: { id: winner.assetId } });
  expect(complete.storageKey).not.toBe(oldStage.storageKey);
  expect(lateDelete).toBeDefined();
  lateDelete!();
  expect(stored.get(complete.storageKey!)?.bytes).toEqual(image);
  expect((await readRemoteImageImport(userId, key)).assetId).toBe(winner.assetId);
  // A restarted cleaner can retry the same DELETE idempotently, but must not
  // touch the completed asset's independently-owned key.
  vi.mocked(blob.deleteFenced).mockImplementation(async input => {
    stored.delete(input.key);
    return { ok: true, data: { deleted: true } };
  });
  const retry = await cleanupExpiredMediaImports({ now: new Date(now.getTime() + 120_000), blob });
  expect(retry.deleted).toBeGreaterThanOrEqual(1);
  expect(await prisma.mediaAsset.findUnique({ where: { id: oldStage.id } })).toBeNull();
  expect(stored.get(complete.storageKey!)?.bytes).toEqual(image);
});

it.each(["erasure", "expiration"] as const)("does not write private bytes when marker preparation arrives after %s", async mode => {
  const userId = users[mode === "erasure" ? 6 : 7]!;
  const blob = installFencedStore();
  let markerStarted!: () => void, resumeMarker!: () => void;
  const startedPromise = new Promise<void>(resolve => { markerStarted = resolve; });
  const resumePromise = new Promise<void>(resolve => { resumeMarker = resolve; });
  vi.mocked(blob.prepareFencedPut).mockImplementationOnce(async ({ key }) => {
    markerStarted();
    await resumePromise;
    // Only opaque random marker bytes can arrive after the authority vanished.
    stored.set(key, { etag: '"late-marker"', bytes: new Uint8Array([0]) });
    return { ok: true, data: { key, markerEtag: '"late-marker"' } };
  });
  const pending = createRemoteImageImport(userId, `${prefix}late-marker-${mode}`, url);
  // Attach a rejection handler before deliberately changing authority.
  void pending.catch(() => {});
  try {
    await Promise.race([startedPromise, pending.then(() => { throw new Error("Marker preparation did not pause"); })]);
    await disconnectImportTransaction();
    if (mode === "erasure") {
      const deletion = await prepareDeletion(userId);
      expect((await dispatchPendingAccountDeletionBlobDeletes({ deletionIds: [deletion.id], blob })).completed).toBe(1);
      expect(await prisma.user.findUnique({ where: { id: userId } })).toBeNull();
    } else {
      const now = new Date(Date.now() + IMPORT_STAGING_RETENTION_MS + 10_000);
      expect((await cleanupExpiredMediaImports({ now, blob })).deleted).toBe(1);
    }
    resumeMarker();
    await expect(pending).rejects.toBeDefined();
    expect(blob.putPrivateFenced).not.toHaveBeenCalled();
    for (const object of stored.values()) expect(object.bytes).toEqual(new Uint8Array([0]));
  } finally {
    resumeMarker();
    await pending.catch(() => {});
  }
});
