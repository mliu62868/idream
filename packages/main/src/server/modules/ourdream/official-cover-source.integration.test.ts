import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Prisma, type MediaAsset } from "@prisma/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/server/lib/db";
import { providers } from "@/server/providers";
import * as bundledImages from "@/server/lib/bundled-editorial-image";
import { materializeOfficialCoverSource } from "./official-cover-source";

const assetId = "seed-image-sarah-mercer";
let original: MediaAsset;
const repair = (dryRun = false) => materializeOfficialCoverSource({ db: prisma, blob: providers.blob, characterId: "sarah-mercer", dryRun });
const metadata = () => original.metadata as Prisma.InputJsonObject;

beforeAll(async () => { original = await prisma.mediaAsset.findUniqueOrThrow({ where: { id: assetId } }); });
beforeEach(async () => {
  await prisma.mediaAsset.update({ where: { id: assetId }, data: { storageKey: null, contentType: null } });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await prisma.mediaAsset.update({ where: { id: assetId }, data: {
    ownerId: original.ownerId, characterId: original.characterId, type: original.type,
    storageKey: original.storageKey, contentType: original.contentType, url: original.url,
    safetyStatus: original.safetyStatus, deletedAt: original.deletedAt, metadata: metadata(),
  } });
});

describe("materialize the original official cover without changing publication authority", () => {
  it("plans without writes, persists the exact JPEG bytes, and repeats without touching releases or identity", async () => {
    const authority = () => prisma.character.findUniqueOrThrow({ where: { id: "sarah-mercer" }, include: { serving: { include: { currentRelease: true } }, visualProfiles: true } });
    const before = await authority();
    const put = vi.spyOn(providers.blob, "putPrivate");
    expect(await repair(true)).toMatchObject({ state: "planned", contentType: "image/jpeg" });
    expect(put).not.toHaveBeenCalled();
    expect((await prisma.mediaAsset.findUniqueOrThrow({ where: { id: assetId } })).storageKey).toBeNull();
    const bytes = await readFile("public/images/ourdream/card-sarah-mercer.webp");
    const result = await repair();
    expect(result).toMatchObject({ state: "materialized", contentType: "image/jpeg", contentSha256: createHash("sha256").update(bytes).digest("hex") });
    const after = await prisma.mediaAsset.findUniqueOrThrow({ where: { id: assetId } });
    const stored = await providers.blob.getPrivate!({ key: after.storageKey! });
    expect(stored.ok).toBe(true);
    if (!stored.ok) throw new Error("Missing materialized cover");
    expect(Buffer.from(stored.data.body)).toEqual(bytes);
    expect(after.url).toBe(original.url);
    expect(after.metadata).toEqual(original.metadata);
    expect(await repair()).toMatchObject({ state: "unchanged", reason: "existing_locator" });
    expect(put).toHaveBeenCalledTimes(1);
    expect(await authority()).toEqual(before);
  });

  it.each([
    { storageKey: "operator/portrait.png" },
    { metadata: { blobLocator: { schemaVersion: "media-asset-blob-locator-v1", kind: "shared_immutable", key: "operator/shared.png", sourceAssetId: "original" }, duplicateLineage: { sourceAssetId: "original" } } },
  ])("preserves an existing owned or shared source: %o", async change => {
    await prisma.mediaAsset.update({ where: { id: assetId }, data: { ...change, ...(change.metadata ? { metadata: { ...metadata(), ...change.metadata } } : {}) } });
    const before = await prisma.mediaAsset.findUniqueOrThrow({ where: { id: assetId } });
    const put = vi.spyOn(providers.blob, "putPrivate");
    expect(await repair()).toMatchObject({ state: "unchanged", reason: "existing_locator" });
    expect(put).not.toHaveBeenCalled();
    expect(await prisma.mediaAsset.findUniqueOrThrow({ where: { id: assetId } })).toEqual(before);
  });

  it.each([
    { url: "/images/ourdream/card-raya-reyes.webp" },
    { ownerId: "seed-admin-user" },
    { characterId: "raya-reyes" },
    { characterId: null },
    { type: "video" },
    { deletedAt: new Date("2026-10-01T00:00:00Z") },
    { safetyStatus: "rejected" },
    { metadata: { platformAsset: { status: "archived" } } },
    { metadata: { seedSource: "operator-import" } },
  ])("does not authorize a modified or unavailable import: %o", async change => {
    await prisma.mediaAsset.update({ where: { id: assetId }, data: { ...change, ...(change.metadata ? { metadata: { ...metadata(), ...change.metadata } } : {}) } });
    const before = await prisma.mediaAsset.findUniqueOrThrow({ where: { id: assetId } });
    const put = vi.spyOn(providers.blob, "putPrivate");
    expect(await repair()).toMatchObject({ state: "skipped", reason: "source_changed_or_unavailable" });
    expect(put).not.toHaveBeenCalled();
    expect(await prisma.mediaAsset.findUniqueOrThrow({ where: { id: assetId } })).toEqual(before);
  });

  it("leaves no locator when the bundled file or Blob write fails", async () => {
    const read = vi.spyOn(bundledImages, "readBundledEditorialImage").mockResolvedValueOnce(null);
    await expect(repair()).rejects.toThrow("missing or unreadable");
    expect((await prisma.mediaAsset.findUniqueOrThrow({ where: { id: assetId } })).storageKey).toBeNull();
    read.mockRestore();
    vi.spyOn(providers.blob, "putPrivate").mockResolvedValue({ ok: false, error: { code: "controlled_blob_failure", message: "Storage unavailable", retryable: true } });
    await expect(repair()).rejects.toThrow();
    expect((await prisma.mediaAsset.findUniqueOrThrow({ where: { id: assetId } })).storageKey).toBeNull();
  });

  it("does not attach bytes after a concurrent operator archives the source", async () => {
    const put = providers.blob.putPrivate.bind(providers.blob);
    vi.spyOn(providers.blob, "putPrivate").mockImplementation(async input => {
      await prisma.mediaAsset.update({ where: { id: assetId }, data: { metadata: { ...metadata(), platformAsset: { status: "archived" } } } });
      return put(input);
    });
    await expect(repair()).rejects.toThrow("changed while");
    expect(await prisma.mediaAsset.findUniqueOrThrow({ where: { id: assetId } })).toMatchObject({ storageKey: null, metadata: { platformAsset: { status: "archived" } } });
  });

  it("recovers an interrupted original import with readable bytes in one targeted seed run", async () => {
    expect(process.env.APP_ENV).toBe("test");
    expect(decodeURIComponent(new URL(process.env.DATABASE_URL!).pathname.slice(1)))
      .toMatch(/(^|[_-])test([_-]|$)/i);
    // An older seed could stop after creating the original MediaAsset but
    // before attaching its Character. One successful replay must finish both.
    await prisma.mediaAsset.update({ where: { id: assetId }, data: {
      characterId: null, storageKey: null, contentType: null,
    } });
    const result = await new Promise<{ code: number | string; stderr: string }>(resolve => {
      execFile("bun", ["run", "db:seed"], {
        cwd: process.cwd(),
        env: { ...process.env, IDREAM_SEED_OFFICIAL_CHARACTER_ID: "sarah-mercer" },
        timeout: 30_000,
      }, (error, _stdout, stderr) => resolve({ code: error?.code ?? 0, stderr }));
    });
    expect(result.code, result.stderr).toBe(0);
    const restored = await prisma.mediaAsset.findUniqueOrThrow({ where: { id: assetId } });
    expect(restored).toMatchObject({
      characterId: "sarah-mercer", ownerId: original.ownerId,
      url: original.url, metadata: original.metadata, contentType: "image/jpeg",
    });
    expect(restored.storageKey).toBeTruthy();
    const stored = await providers.blob.getPrivate!({ key: restored.storageKey! });
    expect(stored.ok).toBe(true);
    if (!stored.ok) throw new Error("The recovered official cover has no readable bytes");
    expect(Buffer.from(stored.data.body)).toEqual(await readFile("public/images/ourdream/card-sarah-mercer.webp"));
  }, 40_000);

  it("does not restore modified import authority across two actual targeted seed runs", async () => {
    expect(process.env.APP_ENV).toBe("test");
    expect(decodeURIComponent(new URL(process.env.DATABASE_URL!).pathname.slice(1)))
      .toMatch(/(^|[_-])test([_-]|$)/i);
    const changed = await prisma.mediaAsset.update({ where: { id: assetId }, data: {
      ownerId: "seed-admin-user",
      metadata: { ...metadata(), seedSource: "operator-import", ownership: "operator_owned" },
    } });
    const runs: Array<{ code: number | string; stderr: string; asset: MediaAsset }> = [];
    // Run both processes before asserting: the original bug rewrote provenance
    // on the first seed and attached the bundled locator on the second.
    for (let index = 0; index < 2; index += 1) {
      const result = await new Promise<{ code: number | string; stderr: string }>(resolve => {
        execFile("bun", ["run", "db:seed"], {
          cwd: process.cwd(),
          env: { ...process.env, IDREAM_SEED_OFFICIAL_CHARACTER_ID: "sarah-mercer" },
          timeout: 30_000,
        }, (error, _stdout, stderr) => resolve({ code: error?.code ?? 0, stderr }));
      });
      runs.push({ ...result, asset: await prisma.mediaAsset.findUniqueOrThrow({ where: { id: assetId } }) });
    }
    for (const [index, run] of runs.entries()) {
      expect(run.code, `seed run ${index + 1} must reject changed provenance`).toBe(1);
      expect(run.stderr).toContain("Official editorial import sarah-mercer lacks its exact publishable seed asset");
      expect(run.asset, `seed run ${index + 1} must preserve the entire source row`).toEqual(changed);
      expect(run.asset.storageKey).toBeNull();
    }
  }, 70_000);
});
