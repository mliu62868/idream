// SPEC: display derivatives Gen writes next to a delivered asset: a WebP preview
// for an image, a WebP poster (the first decoded frame) for a video.
// INTENT: these exist only for grids and posters. Originals stay byte-for-byte
// untouched, and downloads and edit/i2v sources keep reading them.
// INVARIANTS:
//   - rendering or storing a derivative never fails a generation that has already
//     succeeded and been paid for; the failure is recorded on the asset instead
//   - every derivative put is tracked in the caller's rollback set before the call,
//     because a lost acknowledgement cannot prove the store did not write
//   - normalizeArtifacts calls this after the provider returned, so it runs outside
//     the device lease: a resize must not hold the GPU from the next render
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import sharp from "sharp";
import { incrementCounter } from "@idream/shared";
import {
  generationAssetDerivativeKey,
  type GenerationAssetDerivative,
} from "@idream/shared/contracts";
import { env } from "./env";
import type { GenProviders } from "./providers";

const execFileAsync = promisify(execFile);

/** 640px long edge covers a two-column phone grid at 2x, the largest grid cell. */
export const DERIVATIVE_LONG_EDGE_PX = 640;
const DERIVATIVE_WEBP_QUALITY = 80;
const DERIVATIVE_CONTENT_TYPE = "image/webp";
// Same bound the delivered image already passed in decodedGeneratedImage.
const DERIVATIVE_INPUT_PIXEL_LIMIT = 16_777_216;
const POSTER_TIMEOUT_MS = 30_000;
// A decoded PNG of one frame. A runaway stream fails the poster, not the video.
const POSTER_FRAME_MAX_BYTES = 64 * 1024 * 1024;

export type RenderedDerivative = {
  readonly body: Uint8Array;
  readonly width: number;
  readonly height: number;
};

export type DerivativeRendering =
  | { readonly ok: true; readonly rendered: RenderedDerivative }
  | { readonly ok: false; readonly code: string; readonly message: string };

export type VideoPosterExtractor = (video: Uint8Array) => Promise<Uint8Array>;

// `withoutEnlargement` keeps a small source small. sharp copies no metadata unless
// asked, so a preview can't reintroduce what stripPngMetadata removed from the asset.
export async function renderDerivative(source: Uint8Array): Promise<RenderedDerivative> {
  const { data, info } = await sharp(source, { failOn: "warning", limitInputPixels: DERIVATIVE_INPUT_PIXEL_LIMIT })
    .autoOrient()
    .resize({ width: DERIVATIVE_LONG_EDGE_PX, height: DERIVATIVE_LONG_EDGE_PX, fit: "inside", withoutEnlargement: true })
    .webp({ quality: DERIVATIVE_WEBP_QUALITY })
    .toBuffer({ resolveWithObject: true });
  return { body: new Uint8Array(data), width: info.width, height: info.height };
}

// INTENT: ffmpeg hands sharp a lossless PNG so both derivatives share one encoder.
// Homebrew and many distro ffmpeg builds have no libwebp, and a missing encoder
// would turn every poster into a recorded failure on those hosts.
export const extractFirstVideoFrame: VideoPosterExtractor = async (video) => {
  const directory = await mkdtemp(join(tmpdir(), "idream-video-poster-"));
  const path = join(directory, "artifact.mp4");
  try {
    await writeFile(path, video);
    const { stdout } = await execFileAsync(env.FFMPEG_BIN, [
      "-nostdin", "-v", "error",
      // One frame needs little: this runs beside the GPU worker's host work.
      "-threads", "2",
      "-i", path,
      "-map", "0:v:0",
      "-frames:v", "1",
      "-f", "image2pipe",
      "-c:v", "png",
      "-",
    ], { encoding: "buffer", timeout: POSTER_TIMEOUT_MS, maxBuffer: POSTER_FRAME_MAX_BYTES });
    return new Uint8Array(stdout);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

// Both return null for an asset key outside the canonical Attempt layout, which then
// reads as "no derivative", exactly like an asset that predates them.
export async function renderImageDerivative(assetKey: string, body: Uint8Array) {
  return rendering(assetKey, () => renderDerivative(body));
}

export async function renderVideoPosterDerivative(
  assetKey: string,
  video: Uint8Array,
  extract: VideoPosterExtractor = extractFirstVideoFrame,
) {
  return rendering(assetKey, async () => renderDerivative(await extract(video)));
}

async function rendering(
  assetKey: string,
  render: () => Promise<RenderedDerivative>,
): Promise<DerivativeRendering | null> {
  if (!generationAssetDerivativeKey(assetKey)) return null;
  try {
    return { ok: true, rendered: await render() };
  } catch (error) {
    return { ok: false, code: "derivative_render_failed", message: failureMessage(error) };
  }
}

/** Store a rendered derivative and describe it for the terminal record. */
export async function persistAssetDerivative(input: {
  readonly blob: Pick<GenProviders["blob"], "putPrivateIfAbsent" | "delete">;
  readonly assetKey: string;
  readonly rendering: DerivativeRendering | null;
  /** The caller's rollback set: a later asset failure must also remove this write. */
  readonly attemptedKeys: Set<string>;
}): Promise<GenerationAssetDerivative | undefined> {
  const key = generationAssetDerivativeKey(input.assetKey);
  if (!key || !input.rendering) return undefined;
  if (!input.rendering.ok) return recordedFailure(input.rendering.code, input.rendering.message);
  const { rendered } = input.rendering;
  input.attemptedKeys.add(key);
  try {
    const persisted = await input.blob.putPrivateIfAbsent({
      key,
      body: rendered.body,
      contentType: DERIVATIVE_CONTENT_TYPE,
    });
    if (!persisted.ok) throw new Error(persisted.error.message);
    // Written by an earlier run of this Attempt, so this run must not roll it back.
    if (!persisted.data.created) input.attemptedKeys.delete(key);
    return {
      status: "ready",
      key,
      contentType: DERIVATIVE_CONTENT_TYPE,
      width: rendered.width,
      height: rendered.height,
      sizeBytes: rendered.body.byteLength,
    };
  } catch (error) {
    // The delivery goes ahead without this object, so it leaves the failure rollback
    // set either way. If this delete also fails the object is an orphan, but not an
    // unreachable one: erasure derives its key from the asset key regardless.
    input.attemptedKeys.delete(key);
    await input.blob.delete({ key }).catch(() => null);
    return recordedFailure("derivative_persist_failed", failureMessage(error));
  }
}

function recordedFailure(code: string, message: string): GenerationAssetDerivative {
  incrementCounter(
    "generation_asset_derivative_failed_total",
    "Generated assets delivered without their display derivative",
    { code },
  );
  return { status: "failed", code, message };
}

function failureMessage(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return (message.trim() || "derivative failed").slice(0, 500);
}
