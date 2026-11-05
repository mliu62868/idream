// SPEC: a terminal record's derivative reaches the MediaAsset row, the thumbnail route
// reads it under the original's access checks, and every older asset falls back.
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generationAssetDerivativeKey } from "@idream/shared/contracts";
import { resolveLocalBlobPath } from "@idream/shared/storage/local-blob";
import { GET as userContentRoute } from "@/app/user-content/[id]/[filename]/route";
import { prisma } from "@/server/lib/db";
import { mediaThumbnailViewUrl, mediaViewUrl } from "@/server/modules/ourdream/public-read-model";
import { api, createUser } from "@/server/test/helpers";
import { createDeliveredGenerationAsset } from "./generation-asset-delivery";

const P = `derivative-delivery-${randomUUID()}`;
const ownerId = `${P}-owner`;
const strangerId = `${P}-stranger`;
const requestId = `${P}-request`;
const attemptPrefix = `gen/${requestId}/attempts/${P}-attempt/`;
const originalBlobRoot = process.env.BLOB_ROOT;
let blobRoot = "";
let previewBytes: Uint8Array;
const originalBytes = new Uint8Array(Buffer.from("the-original-png-bytes"));

async function putBlob(key: string, body: Uint8Array) {
  const target = resolveLocalBlobPath(key);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, body);
}

async function deliver(input: {
  id: string;
  key: string;
  contentType?: string;
  mode?: "image" | "video";
  derivative?: Record<string, unknown>;
}) {
  const request = await prisma.generationJob.findUniqueOrThrow({ where: { id: requestId } });
  await prisma.$transaction((tx) => createDeliveredGenerationAsset(tx, {
    id: input.id,
    request,
    payload: { mode: input.mode ?? "image", usage: {} },
    provider: "mock-image",
    asset: {
      key: input.key,
      contentType: input.contentType ?? "image/png",
      width: 832,
      height: 1024,
      providerKey: null,
      ...(input.derivative ? { derivative: input.derivative } : {}),
    } as Parameters<typeof createDeliveredGenerationAsset>[1]["asset"],
    ordinal: 0,
    safetyStatus: "passed",
  }));
  return prisma.mediaAsset.findUniqueOrThrow({ where: { id: input.id } });
}

function readyDerivative(assetKey: string) {
  return {
    status: "ready", key: generationAssetDerivativeKey(assetKey), contentType: "image/webp",
    width: 520, height: 640, sizeBytes: previewBytes.byteLength,
  };
}

beforeAll(async () => {
  blobRoot = await mkdtemp(path.join(tmpdir(), "idream-derivative-delivery-"));
  process.env.BLOB_ROOT = blobRoot;
  previewBytes = new Uint8Array(await sharp({ create: { width: 8, height: 8, channels: 3, background: "red" } }).webp().toBuffer());
  await createUser({ id: ownerId });
  await createUser({ id: strangerId });
  await prisma.generationJob.create({ data: {
    id: requestId, userId: ownerId, mode: "image", provider: "mock-image", status: "completed",
    prompt: "a lake", controls: {}, presetIds: [], outputCount: 1, costDreamcoins: 0, sourceType: "character_preview",
  } as Parameters<typeof prisma.generationJob.create>[0]["data"] });
});

afterAll(async () => {
  await prisma.mediaAsset.deleteMany({ where: { ownerId } });
  await prisma.generationJob.deleteMany({ where: { id: requestId } });
  await prisma.user.deleteMany({ where: { id: { in: [ownerId, strangerId] } } });
  if (originalBlobRoot === undefined) delete process.env.BLOB_ROOT;
  else process.env.BLOB_ROOT = originalBlobRoot;
  await rm(blobRoot, { recursive: true, force: true });
});

describe("createDeliveredGenerationAsset", () => {
  it("points thumbnailUrl at the derivative and keeps url and storageKey on the original", async () => {
    const key = `${attemptPrefix}image-1.png`;
    const asset = await deliver({ id: `${P}-ready`, key, derivative: readyDerivative(key) });
    expect(asset).toMatchObject({
      storageKey: key,
      url: mediaViewUrl({ id: asset.id, type: "image", contentType: "image/png", url: "" }),
      thumbnailUrl: mediaThumbnailViewUrl(asset),
    });
    // Everything the two delivery paths used to disagree on is written by both.
    expect(asset.metadata).toMatchObject({
      synthetic: true,
      source: "character_preview",
      quality: { evaluatorVersion: "not_provided" },
      derivative: { status: "ready" },
    });
    expect(asset.sourcePromptHash).toMatch(/^prompt_/);
  });

  it("falls back to the original and records why when the derivative failed", async () => {
    const asset = await deliver({ id: `${P}-failed`, key: `${attemptPrefix}image-2.png`,
      derivative: { status: "failed", code: "derivative_render_failed", message: "sharp unavailable" } });
    expect(asset.thumbnailUrl).toBe(asset.url);
    expect(asset.metadata).toMatchObject({ derivative: { status: "failed", code: "derivative_render_failed" } });
  });

  it("gives a video a poster, or no thumbnail at all, never the video URL", async () => {
    const key = `${attemptPrefix}video.mp4`;
    const poster = await deliver({ id: `${P}-poster`, key, mode: "video", contentType: "video/mp4", derivative: readyDerivative(key) });
    expect(poster.thumbnailUrl).toBe(mediaThumbnailViewUrl(poster));
    const bare = await deliver({ id: `${P}-no-poster`, key: `gen/${requestId}/attempts/${P}-other/video.mp4`, mode: "video", contentType: "video/mp4" });
    expect(bare.thumbnailUrl).toBeNull();
  });

  it("refuses a ready derivative under any key other than the derived one", async () => {
    const key = `gen/${requestId}/attempts/${P}-forged/image-1.png`;
    const asset = await deliver({ id: `${P}-forged`, key, derivative: { ...readyDerivative(key), key: "character-images/someone-else.webp" } });
    expect(asset.thumbnailUrl).toBe(asset.url);
  });
});

describe("thumbnail route", () => {
  const id = `${P}-served`;
  const key = `gen/${requestId}/attempts/${P}-served/image-1.png`;

  beforeAll(async () => {
    await deliver({ id, key, derivative: readyDerivative(key) });
    await putBlob(key, originalBytes);
    await putBlob(generationAssetDerivativeKey(key)!, previewBytes);
  });

  it("serves the derivative as WebP and leaves content and downloads on the original", async () => {
    const thumbnail = await api("GET", `media/${id}/thumbnail`, { userId: ownerId, ageGate: true });
    expect(thumbnail.status).toBe(200);
    expect(thumbnail.headers.get("content-type")).toBe("image/webp");
    expect(thumbnail.bytes).toEqual(previewBytes);

    const original = await api("GET", `media/${id}/content`, { userId: ownerId, ageGate: true });
    expect(original.headers.get("content-type")).toBe("image/png");
    expect(original.bytes).toEqual(originalBytes);

    const download = await api("GET", `media/${id}/thumbnail`, { userId: ownerId, ageGate: true, query: { download: "1" } });
    expect(download.bytes).toEqual(originalBytes);
  });

  it("applies the original's access checks", async () => {
    expect((await api("GET", `media/${id}/thumbnail`, { userId: strangerId, ageGate: true })).status).toBe(404);
    expect((await api("GET", `media/${id}/thumbnail`, { ageGate: true, anonymousId: `${P}-anon` })).status).toBe(401);
    const deleted = `${P}-deleted`;
    const deletedKey = `gen/${requestId}/attempts/${P}-deleted/image-1.png`;
    await deliver({ id: deleted, key: deletedKey, derivative: readyDerivative(deletedKey) });
    await putBlob(generationAssetDerivativeKey(deletedKey)!, previewBytes);
    await prisma.mediaAsset.update({ where: { id: deleted }, data: { deletedAt: new Date() } });
    expect((await api("GET", `media/${deleted}/thumbnail`, { userId: ownerId, ageGate: true })).status).toBe(404);
  });

  it("answers with the original for a historical asset, and when the derivative object is gone", async () => {
    const historical = `${P}-historical`;
    const historicalKey = `gen/${requestId}/image-1.png`;
    const asset = await deliver({ id: historical, key: historicalKey });
    expect(asset.thumbnailUrl).toBe(asset.url);
    await putBlob(historicalKey, originalBytes);
    expect((await api("GET", `media/${historical}/thumbnail`, { userId: ownerId, ageGate: true })).bytes).toEqual(originalBytes);

    const missing = `${P}-missing`;
    const missingKey = `gen/${requestId}/attempts/${P}-missing/image-1.png`;
    await deliver({ id: missing, key: missingKey, derivative: readyDerivative(missingKey) });
    await putBlob(missingKey, originalBytes);
    expect((await api("GET", `media/${missing}/thumbnail`, { userId: ownerId, ageGate: true })).bytes).toEqual(originalBytes);
  });

  it("routes only the exact filename to the derivative at /user-content", async () => {
    const token = Buffer.from(id, "utf8").toString("base64url");
    const read = async (filename: string) => {
      const response = await userContentRoute(new Request(`http://localhost/user-content/${token}/${filename}`, {
        headers: { "x-idream-user-id": ownerId, cookie: "idream_age_gate=accepted" },
      }), { params: Promise.resolve({ id: token, filename }) });
      return response.headers.get("content-type");
    };
    await api("GET", `media/${id}/content`, { userId: ownerId, ageGate: true }); // materializes the age gate row
    expect(await read("thumbnail.webp")).toBe("image/webp");
    expect(await read("content.png")).toBe("image/png");
    expect(await read("thumbnail.png")).toBe("image/png");
  });

  it("projects the derivative through the media DTO, and a video keeps a playable url", async () => {
    const posterKey = `gen/${requestId}/attempts/${P}-listed/video.mp4`;
    await deliver({ id: `${P}-listed`, key: posterKey, mode: "video", contentType: "video/mp4", derivative: readyDerivative(posterKey) });
    const listed = await api("GET", "media", { userId: ownerId, ageGate: true, query: { limit: 50 } });
    expect(listed.status).toBe(200);
    const items = (listed.data?.items ?? listed.data) as Array<{ id: string; url: string; thumbnailUrl: string }>;
    const image = items.find((item) => item.id === id)!;
    expect(image.thumbnailUrl).toBe(mediaThumbnailViewUrl({ id }));
    expect(image.url).not.toBe(image.thumbnailUrl);
    const video = items.find((item) => item.id === `${P}-listed`)!;
    expect(video.thumbnailUrl).toBe(mediaThumbnailViewUrl({ id: `${P}-listed` }));
    expect(video.url).toMatch(/\/content\.mp4$/);
  });
});
