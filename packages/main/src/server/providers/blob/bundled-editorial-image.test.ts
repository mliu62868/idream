import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  persistBundledEditorialImage,
  readBundledEditorialImage,
  type BundledEditorialImage,
} from "@/server/lib/bundled-editorial-image";
import { canonicalSha256 } from "@/server/modules/admin-v2/shared/canonical-json";
import type { BlobStore } from "../types";

let root: string;
let imageRoot: string;
let jpeg: Buffer;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "idream-bundled-image-"));
  imageRoot = path.join(root, "public", "images", "ourdream");
  await mkdir(imageRoot, { recursive: true });
  jpeg = await sharp({ create: { width: 8, height: 6, channels: 3, background: "#7296b0" } }).jpeg().toBuffer();
  await writeFile(path.join(imageRoot, "portrait.webp"), jpeg);
  vi.spyOn(process, "cwd").mockReturnValue(root);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

async function portrait(): Promise<BundledEditorialImage> {
  const result = await readBundledEditorialImage("/images/ourdream/portrait.webp");
  if (!result) throw new Error("Bundled fixture was not readable");
  return result;
}

describe("bundled editorial image storage", () => {
  it("detects JPEG bytes behind a .webp name without transcoding", async () => {
    const image = await portrait();
    expect(image.contentType).toBe("image/jpeg");
    expect(image.extension).toBe(".jpg");
    expect(Buffer.from(image.bytes)).toEqual(jpeg);
    expect(image.contentSha256).toBe(createHash("sha256").update(jpeg).digest("hex"));
  });

  it.each(["png", "webp"] as const)("keeps actual %s images in their original format", async format => {
    const bytes = await sharp(jpeg)[format]().toBuffer();
    await writeFile(path.join(imageRoot, `portrait.${format}`), bytes);
    const image = await readBundledEditorialImage(`/images/ourdream/portrait.${format}`);
    expect(image).toMatchObject({ contentType: `image/${format}`, extension: `.${format}` });
    expect(Buffer.from(image!.bytes)).toEqual(bytes);
  });

  it.each([
    "https://example.com/images/ourdream/portrait.webp",
    "//example.com/images/ourdream/portrait.webp",
    "/images/other/portrait.webp",
    "/images/ourdream/../portrait.webp",
    "/images/ourdream/%2e%2e%2fportrait.webp",
    "/images/ourdream/%2fportrait.webp",
    "/images/ourdream/%zz.webp",
    "/images/ourdream/portrait.webp?download=1",
    "/images/ourdream/portrait.webp#fragment",
  ])("refuses non-bundled or ambiguous URL %s", async url => {
    await writeFile(path.join(root, "public", "images", "portrait.webp"), jpeg);
    await expect(readBundledEditorialImage(url)).resolves.toBeNull();
  });

  it("rejects file and directory symlinks escaping the packaged image directory", async () => {
    const outside = path.join(root, "outside");
    await mkdir(outside);
    await writeFile(path.join(outside, "portrait.webp"), jpeg);
    await symlink(path.join(outside, "portrait.webp"), path.join(imageRoot, "escaped.webp"));
    await symlink(outside, path.join(imageRoot, "escaped-directory"));
    await expect(readBundledEditorialImage("/images/ourdream/escaped.webp")).resolves.toBeNull();
    await expect(readBundledEditorialImage("/images/ourdream/escaped-directory/portrait.webp")).resolves.toBeNull();
  });

  it("rejects a packaged image root replaced by an external symlink", async () => {
    const outside = path.join(root, "outside");
    await mkdir(outside);
    await writeFile(path.join(outside, "portrait.webp"), jpeg);
    await rm(imageRoot, { recursive: true });
    await symlink(outside, imageRoot);
    await expect(readBundledEditorialImage("/images/ourdream/portrait.webp")).resolves.toBeNull();
  });

  it("keeps missing, empty, corrupt, SVG and oversized files unmaterializable", async () => {
    await writeFile(path.join(imageRoot, "empty.webp"), "");
    await writeFile(path.join(imageRoot, "corrupt.webp"), "not image bytes");
    await writeFile(path.join(imageRoot, "vector.webp"), '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="6"><rect width="8" height="6"/></svg>');
    await writeFile(path.join(imageRoot, "large.webp"), jpeg);
    await truncate(path.join(imageRoot, "large.webp"), 64 * 1024 * 1024 + 1);
    for (const name of ["missing", "empty", "corrupt", "vector", "large"]) {
      await expect(readBundledEditorialImage(`/images/ourdream/${name}.webp`)).resolves.toBeNull();
    }
  });

  it("persists the original bytes under the existing content-addressed namespace", async () => {
    const image = await portrait();
    const putPrivate = vi.fn<BlobStore["putPrivate"]>(async input => ({
      ok: true, data: { key: input.key, size: input.body.byteLength },
    }));
    const result = await persistBundledEditorialImage("seed-image-sarah-mercer", image, { putPrivate });
    const expectedKey = `official-editorial/${canonicalSha256("seed-image-sarah-mercer").slice(0, 16)}/${image.contentSha256}.jpg`;
    expect(result).toEqual({ storageKey: expectedKey, contentType: "image/jpeg" });
    expect(putPrivate).toHaveBeenCalledExactlyOnceWith({ key: expectedKey, body: image.bytes, contentType: "image/jpeg" });
  });

  it("propagates provider failures without returning an attachable locator", async () => {
    const putPrivate = vi.fn<BlobStore["putPrivate"]>(async () => ({
      ok: false, error: { code: "storage_unavailable", message: "offline", retryable: true },
    }));
    await expect(persistBundledEditorialImage("asset", await portrait(), { putPrivate })).rejects.toMatchObject({
      code: "unavailable", details: { assetId: "asset", providerCode: "storage_unavailable" },
    });
    const failure = new Error("storage write threw");
    putPrivate.mockRejectedValueOnce(failure);
    await expect(persistBundledEditorialImage("asset", await portrait(), { putPrivate })).rejects.toBe(failure);
  });

  it.each(["key", "size"] as const)("refuses a successful Blob receipt with a mismatched %s", async field => {
    const putPrivate = vi.fn<BlobStore["putPrivate"]>(async input => ({
      ok: true, data: { key: field === "key" ? "another-key" : input.key, size: input.body.byteLength + (field === "size" ? 1 : 0) },
    }));
    await expect(persistBundledEditorialImage("asset", await portrait(), { putPrivate })).rejects.toMatchObject({
      code: "unavailable", details: { providerCode: "invalid_blob_receipt" },
    });
  });
});
