import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import path from "node:path";
import type { BlobStore } from "../providers/types";
import { Errors } from "./errors";
import { verifySourceImageBytes } from "./safe-remote-image";

export type BundledEditorialImage = {
  readonly bytes: Uint8Array;
  readonly contentType: string;
  readonly extension: string;
  readonly contentSha256: string;
};

const BUNDLED_EDITORIAL_IMAGE_PREFIX = "/images/ourdream/";
const MAX_BUNDLED_IMAGE_BYTES = 64 * 1024 * 1024;

/** Read packaged editorial artwork; this never grants media or publication authority. */
export async function readBundledEditorialImage(
  urlValue: string,
): Promise<BundledEditorialImage | null> {
  const value = urlValue.trim();
  if (!value.startsWith("/") || value.startsWith("//")) return null;
  let parsed: URL;
  try {
    parsed = new URL(value, "https://idream.invalid");
  } catch {
    return null;
  }
  if (parsed.origin !== "https://idream.invalid" || parsed.search || parsed.hash) return null;
  let pathname: string;
  try {
    pathname = decodeURIComponent(parsed.pathname);
  } catch {
    return null;
  }
  if (!pathname.startsWith(BUNDLED_EDITORIAL_IMAGE_PREFIX)) return null;
  if (![".webp", ".png", ".jpg", ".jpeg"].includes(path.extname(pathname).toLowerCase())) return null;

  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    // Anchor to the real package cwd: neither a filename nor a directory
    // symlink may redirect a bundled URL outside its packaged image directory.
    const publicRoot = path.join(await realpath(process.cwd()), "public", "images", "ourdream");
    const candidate = path.resolve(publicRoot, pathname.slice(BUNDLED_EDITORIAL_IMAGE_PREFIX.length));
    if (!candidate.startsWith(`${publicRoot}${path.sep}`)) return null;
    const resolved = await realpath(candidate);
    if (!resolved.startsWith(`${publicRoot}${path.sep}`)) return null;
    file = await open(resolved, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await file.stat();
    if (!stat.isFile() || stat.size === 0 || stat.size > MAX_BUNDLED_IMAGE_BYTES) return null;
    const bytes = new Uint8Array(await file.readFile());
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_BUNDLED_IMAGE_BYTES) return null;
    const verified = await verifySourceImageBytes(bytes);
    const extension = verified.contentType === "image/jpeg" ? ".jpg"
      : verified.contentType === "image/png" ? ".png"
      : verified.contentType === "image/webp" ? ".webp"
      : null;
    if (!extension) return null;
    return {
      bytes,
      contentType: verified.contentType,
      extension,
      contentSha256: createHash("sha256").update(bytes).digest("hex"),
    };
  } catch {
    // Missing or unreadable packaged pixels remain a materialization block.
    return null;
  } finally {
    await file?.close();
  }
}

/** Store the original bytes; callers separately authorize and attach the locator. */
export async function persistBundledEditorialImage(
  assetId: string,
  bundled: BundledEditorialImage,
  blob: Pick<BlobStore, "putPrivate">,
): Promise<{ storageKey: string; contentType: string }> {
  // Asset IDs are strings; their JSON encoding preserves the existing
  // canonicalSha256(assetId) key namespace used by editorial readiness repair.
  const assetKey = createHash("sha256").update(JSON.stringify(assetId)).digest("hex").slice(0, 16);
  const storageKey = `official-editorial/${assetKey}/${bundled.contentSha256}${bundled.extension}`;
  const stored = await blob.putPrivate({ key: storageKey, body: bundled.bytes, contentType: bundled.contentType });
  if (!stored.ok || stored.data.key !== storageKey || stored.data.size !== bundled.bytes.byteLength) {
    throw Errors.unavailable("The live portrait could not be stored for image production", {
      assetId,
      providerCode: stored.ok ? "invalid_blob_receipt" : stored.error.code,
    });
  }
  return { storageKey, contentType: bundled.contentType };
}
