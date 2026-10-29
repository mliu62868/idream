import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import sharp from "sharp";
import { createVideoMediaProbe, type VerifiedVideoMedia } from "@idream/shared/media/video-probe";
import { Errors } from "@/server/lib/errors";
import { env } from "@/server/lib/env";
import { resolveMediaAssetBlobLocator } from "@/server/lib/media-asset-authority";
import { providers } from "@/server/providers";

const execute = promisify(execFile);
const MAX_BYTES = 100 * 1024 * 1024;
export type PreparedLibraryMedia = {
  bytes: Uint8Array; contentHash: string; contentType: string; kind: "image" | "video";
  width: number; height: number; durationSeconds: number | null; hasAudio: boolean | null;
  thumbnail: Uint8Array; frames: Array<{ dataUrl: string; atSeconds: number | null }>;
};

/** Hash and observe the same bytes that will be copied into library ownership. */
export async function readLibrarySourceBytes(asset: { type: string; storageKey: string | null; metadata: unknown }) {
  const locator = resolveMediaAssetBlobLocator(asset);
  if (!locator || !providers.blob.getPrivate) throw Errors.conflict("A durable source file is required for the chat library");
  const blob = await providers.blob.getPrivate({ key: locator.key, maxBytes: MAX_BYTES, signal: AbortSignal.timeout(30_000) });
  if (!blob.ok) throw Errors.unavailable("The source media file could not be read");
  return inspectLibraryMedia(blob.data.body, asset.type);
}

export async function inspectLibraryMedia(bytes: Uint8Array, type: string): Promise<PreparedLibraryMedia> {
  if (!bytes.byteLength || bytes.byteLength > MAX_BYTES) throw Errors.badRequest("Chat library media must be between 1 byte and 100 MB");
  const contentHash = createHash("sha256").update(bytes).digest("hex");
  if (type === "image") {
    try {
      const image = sharp(bytes, { failOn: "error", limitInputPixels: 40_000_000 });
      const metadata = await image.metadata();
      const types: Record<string, string> = { jpeg: "image/jpeg", png: "image/png", webp: "image/webp" };
      const contentType = metadata.format ? types[metadata.format] : undefined;
      if (!contentType || !metadata.width || !metadata.height || (metadata.pages ?? 1) !== 1) {
        throw new Error("Expected a single JPEG, PNG or WebP image");
      }
      // toBuffer decodes the complete source, unlike metadata() alone.
      const thumbnail = await image.rotate().resize({ width: 1024, height: 1024, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();
      return { bytes, contentHash, contentType, kind: "image", width: metadata.width, height: metadata.height,
        durationSeconds: null, hasAudio: null, thumbnail, frames: [{ dataUrl: dataUrl(thumbnail), atSeconds: null }] };
    } catch { throw Errors.badRequest("The image cannot be fully decoded as a supported single image"); }
  }
  if (type !== "video") throw Errors.badRequest("The chat library accepts only images and videos");
  let verified: VerifiedVideoMedia;
  try { verified = await createVideoMediaProbe({ ffprobePath: env.VIDEO_FFPROBE_BIN, ffmpegPath: env.VOICE_FFMPEG_BIN })(bytes); }
  catch { throw Errors.badRequest("The video cannot be fully decoded"); }
  if (verified.durationSeconds > 60) throw Errors.badRequest("Chat library clips must be at most 60 seconds");
  const directory = await mkdtemp(join(tmpdir(), "idream-library-frames-"));
  try {
    const path = join(directory, "source");
    await writeFile(path, bytes);
    const frames: PreparedLibraryMedia["frames"] = [];
    // Evenly spaced samples include the opening and ending. They are evidence
    // for an observation, never proof of unobserved intervening motion.
    const count = Math.min(12, Math.max(3, Math.ceil(verified.durationSeconds * 2)));
    let thumbnail: Uint8Array | undefined;
    for (let index = 0; index < count; index += 1) {
      const atSeconds = Math.max(0, verified.durationSeconds - 0.05) * index / (count - 1);
      const output = join(directory, `frame-${index}.jpg`);
      await execute(env.VOICE_FFMPEG_BIN, ["-nostdin", "-v", "error", "-ss", String(atSeconds), "-i", path,
        "-frames:v", "1", "-vf", "scale='min(768,iw)':-2", "-q:v", "3", output], { timeout: 30_000 });
      const frame = await readFile(output);
      if (!thumbnail) thumbnail = frame;
      frames.push({ dataUrl: dataUrl(frame), atSeconds });
    }
    // ffprobe checked the stream; identify the container from actual bytes.
    const webm = bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3;
    const mp4 = Buffer.from(bytes.subarray(4, 8)).toString("ascii") === "ftyp";
    if (!webm && !mp4) throw Errors.badRequest("Chat library video must use an MP4 or WebM container");
    return { bytes, contentHash, contentType: webm ? "video/webm" : "video/mp4", kind: "video",
      width: verified.width, height: verified.height, durationSeconds: verified.durationSeconds, hasAudio: verified.hasAudio,
      thumbnail: thumbnail!, frames };
  } finally { await rm(directory, { recursive: true, force: true }); }
}

function dataUrl(bytes: Uint8Array) { return `data:image/jpeg;base64,${Buffer.from(bytes).toString("base64")}`; }
