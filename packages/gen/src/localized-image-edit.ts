import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { z } from "zod";
import { CONFIRMED_IMAGE_EDIT_VERSION, LOCAL_IMAGE_EDIT_VERSION, localizedImageEditSchema, type ImageEditOperation } from "@idream/shared/chat/image-action";
import type { ImageGeneratePayload } from "@idream/shared/contracts";
import { env } from "./env";

const segmentationScript = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../scripts/segment-image.py");
const sha256 = (body: Uint8Array) => createHash("sha256").update(body).digest("hex");
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const segmentationEvidenceSchema = z.object({
  status: z.literal("ok"), sourceSha256: hashSchema, modelSha256: hashSchema,
  maskSha256: hashSchema, width: z.number().int().positive(), height: z.number().int().positive(),
  target: z.string(), selection: z.enum(["one", "all"]),
  maskPixels: z.number().int().positive(), totalPixels: z.number().int().positive(),
  candidates: z.array(z.record(z.string(), z.unknown())).min(1), elapsedMs: z.number().nonnegative(),
}).passthrough();

type EditPin = z.infer<typeof localizedImageEditSchema>;
type Reference = NonNullable<ImageGeneratePayload["referenceImages"]>[number];
type SegmentationInput = { source: Uint8Array; pin: Extract<EditPin, { version: typeof LOCAL_IMAGE_EDIT_VERSION }>; leaseFd?: number; onHeartbeat?: () => Promise<void> };
type SegmentationOutput = { mask: Uint8Array; evidence: unknown };
export type SegmentImage = (input: SegmentationInput) => Promise<SegmentationOutput>;
export type ImageEditPreservation = { maskBody: Uint8Array; evidence: Record<string, unknown> };

export class LocalizedImageEditError extends Error {
  readonly code = "localized_image_edit_failed";
  constructor(message: string, readonly evidence?: Record<string, unknown>) { super(message); }
}

export type PreparedLocalizedEdit = {
  source: Buffer; sourceRgba: Buffer; width: number; height: number;
  mask: Buffer; maskBody: Uint8Array; evidence: Record<string, unknown>;
  operation: ImageEditOperation | null;
};

/** Confirmed masks are data validation only. Historical SAM pins need the accelerator lease. */
export async function prepareLocalizedImageEdit(input: {
  controls?: Record<string, unknown>; referenceImages?: Reference[]; count: number;
}, segment: SegmentImage = segmentImageWithSam3, execution: Pick<SegmentationInput, "leaseFd" | "onHeartbeat"> = {}): Promise<PreparedLocalizedEdit | null> {
  if (input.controls?.localizedEdit === undefined) return null;
  try {
    const pin = localizedImageEditSchema.parse(input.controls.localizedEdit);
    const sources = input.referenceImages?.filter(item => item.role === "source_image") ?? [];
    const source = sources[0];
    if (input.count !== 1 || sources.length !== 1 || !source?.b64Json || !source.contentSha256 || !source.sourceSnapshotId ||
      source.assetId !== input.controls.sourceImageAssetId || input.controls.orientation !== "original") {
      throw new Error("Localized edit requires one frozen source image and original dimensions");
    }
    const frozen = Buffer.from(source.b64Json, "base64");
    if (sha256(frozen) !== source.contentSha256) throw new Error("Localized edit source hash does not match Main's snapshot");
    if (pin.version === CONFIRMED_IMAGE_EDIT_VERSION && frozen.toString("base64") !== source.b64Json) {
      throw new Error("Confirmed source encoding is invalid");
    }
    if (pin.version === CONFIRMED_IMAGE_EDIT_VERSION) assertStaticPng(frozen);
    const decoded = await decodeRgba(frozen);
    if (decoded.width !== input.controls.width || decoded.height !== input.controls.height) throw new Error("Localized edit source dimensions changed");
    // One explicit decoding convention is shared by segmentation, final compose
    // and its independent verification. Provider decoding is not authority.
    const canonicalSource = await sharp(decoded.pixels, { raw: { width: decoded.width, height: decoded.height, channels: 4 } }).png().toBuffer();
    await execution.onHeartbeat?.();
    let result: SegmentationOutput;
    let evidence: Record<string, unknown>;
    if (pin.version === CONFIRMED_IMAGE_EDIT_VERSION) {
      if (pin.sourceSnapshotId !== source.sourceSnapshotId || pin.sourceSha256 !== source.contentSha256 ||
          pin.width !== decoded.width || pin.height !== decoded.height) throw new Error("Confirmed edit does not match its frozen source");
      const sourceMetadata = await sharp(frozen).metadata();
      if (sourceMetadata.format !== "png" || (sourceMetadata.orientation ?? 1) !== 1 || sourceMetadata.space !== "srgb" ||
          sourceMetadata.channels !== 4 || !sourceMetadata.hasAlpha || sourceMetadata.depth !== "uchar" || sourceMetadata.bitsPerSample !== 8) {
        throw new Error("Confirmed source must be an oriented sRGB RGBA8 PNG frame");
      }
      const mask = Buffer.from(pin.maskPngBase64, "base64");
      if (mask.toString("base64") !== pin.maskPngBase64 || sha256(mask) !== pin.maskSha256) throw new Error("Confirmed mask hash or encoding is invalid");
      assertStaticPng(mask);
      const { maskPngBase64: _maskBytes, ...confirmation } = pin;
      evidence = { ...confirmation, status: "ok", regionAuthority: "user_confirmation", maskCorrectnessCertified: false };
      result = { mask, evidence };
    } else {
      result = await segment({ source: canonicalSource, pin, ...execution });
      evidence = segmentationEvidenceSchema.parse(result.evidence);
      if (evidence.sourceSha256 !== sha256(canonicalSource) || evidence.modelSha256 !== pin.modelSha256 ||
        evidence.maskSha256 !== sha256(result.mask) || evidence.width !== decoded.width || evidence.height !== decoded.height ||
        evidence.target !== pin.target || evidence.selection !== pin.selection) throw new Error("Segmentation evidence does not match the pinned edit");
    }
    if (result.mask.byteLength > 512 * 1024) throw new Error("Segmentation mask exceeds the evidence size limit");
    const maskImage = sharp(result.mask, { failOn: "warning", limitInputPixels: 4_194_304 });
    const maskMetadata = await maskImage.metadata();
    if (maskMetadata.format !== "png" || (maskMetadata.pages ?? 1) !== 1 || maskMetadata.hasAlpha ||
      maskMetadata.width !== decoded.width || maskMetadata.height !== decoded.height) throw new Error("Segmentation mask geometry is invalid");
    if (pin.version === CONFIRMED_IMAGE_EDIT_VERSION && (maskMetadata.channels !== 1 || maskMetadata.depth !== "uchar" || maskMetadata.bitsPerSample !== 8 ||
        maskMetadata.space !== "b-w" || (maskMetadata.orientation ?? 1) !== 1)) throw new Error("Confirmed mask must be an oriented 8-bit grayscale PNG");
    const mask = await maskImage.greyscale().raw().toBuffer();
    const maskPixels = mask.reduce((count, value) => count + Number(value > 0), 0);
    if (mask.length !== decoded.width * decoded.height || mask.some(value => value !== 0 && value !== 255) ||
      maskPixels === 0 || (pin.version === LOCAL_IMAGE_EDIT_VERSION &&
        (maskPixels / mask.length > 0.65 || maskPixels !== evidence.maskPixels || mask.length !== evidence.totalPixels))) {
      throw new Error("Segmentation mask is empty, excessive, or inconsistent");
    }
    return { source: canonicalSource, sourceRgba: decoded.pixels, width: decoded.width, height: decoded.height,
      mask, maskBody: result.mask, operation: pin.version === CONFIRMED_IMAGE_EDIT_VERSION ? pin.operation : null,
      evidence: { ...evidence, version: pin.version, maskPixels, totalPixels: mask.length,
        sourceAssetId: source.assetId, sourceSnapshotId: source.sourceSnapshotId, frozenSourceSha256: source.contentSha256,
        canonicalSourceSha256: sha256(canonicalSource), decodeConvention: "sharp-auto-orient-srgb-rgba-v1" } };
  } catch (error) {
    if (error instanceof LocalizedImageEditError) throw error;
    throw new LocalizedImageEditError(error instanceof Error ? error.message : String(error));
  }
}

/** Pixel preservation is enforced here, independently of generative behavior. */
export async function compositeLocalizedImageEdit(prepared: PreparedLocalizedEdit, candidate: Uint8Array) {
  try {
    const generated = await decodeRgba(candidate);
    if (generated.width !== prepared.width || generated.height !== prepared.height) throw new Error("Localized edit candidate dimensions changed");
    const pixels = Buffer.from(prepared.sourceRgba);
    let changedTargetPixels = 0;
    for (let p = 0; p < prepared.mask.length; p += 1) {
      if (prepared.mask[p] === 0) continue;
      const offset = p * 4;
      if (!pixels.subarray(offset, offset + 4).equals(generated.pixels.subarray(offset, offset + 4))) changedTargetPixels += 1;
      generated.pixels.copy(pixels, offset, offset, offset + 4);
    }
    if (changedTargetPixels === 0 && prepared.operation?.kind !== "recolor") throw new Error("Localized edit produced no target change");
    const body = await sharp(pixels, { raw: { width: prepared.width, height: prepared.height, channels: 4 } }).png().toBuffer();
    const verified = await decodeRgba(body);
    let changedProtectedPixels = 0;
    for (let p = 0; p < prepared.mask.length; p += 1) {
      const offset = p * 4;
      if (prepared.mask[p] === 0 && !verified.pixels.subarray(offset, offset + 4).equals(prepared.sourceRgba.subarray(offset, offset + 4))) changedProtectedPixels += 1;
    }
    if (changedProtectedPixels !== 0) throw new Error("Localized edit changed protected pixels");
    const preservation: ImageEditPreservation = { maskBody: prepared.maskBody, evidence: {
      ...prepared.evidence, candidateSha256: sha256(candidate), resultSha256: sha256(body),
      protectedPixels: prepared.mask.length - Number(prepared.evidence.maskPixels), changedProtectedPixels, changedTargetPixels,
      // The numerical invariant cannot certify target selection or semantic success.
      intentVerified: false,
    } };
    return { body, width: prepared.width, height: prepared.height, contentType: "image/png", preservation };
  } catch (error) {
    throw new LocalizedImageEditError(error instanceof Error ? error.message : String(error));
  }
}

async function decodeRgba(body: Uint8Array) {
  const image = sharp(body, { failOn: "warning", limitInputPixels: 4_194_304 });
  const metadata = await image.metadata();
  if (!["png", "jpeg", "webp"].includes(metadata.format ?? "") || (metadata.pages ?? 1) !== 1) throw new Error("Edit image must be a single PNG, JPEG or WebP frame");
  const { data, info } = await image.rotate().toColourspace("srgb").ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  if (info.channels !== 4) throw new Error("Edit image did not decode to RGBA");
  return { pixels: data, width: info.width, height: info.height };
}

function assertStaticPng(bytes: Buffer) {
  if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error("Confirmed pixels require PNG bytes");
  // libpng can decode only APNG's first frame while reporting pages=1. The
  // container itself must prove there is no animation before decoding pixels.
  for (let offset = 8; offset + 12 <= bytes.length;) {
    const size = bytes.readUInt32BE(offset);
    const end = offset + size + 12;
    const name = bytes.toString("ascii", offset + 4, offset + 8);
    if (end > bytes.length || name === "acTL") throw new Error("Confirmed PNG must be a complete single frame");
    if (name === "IEND") {
      if (size !== 0 || end !== bytes.length) throw new Error("Confirmed PNG has an invalid terminal chunk");
      return;
    }
    offset = end;
  }
  throw new Error("Confirmed PNG has no terminal chunk");
}

async function segmentImageWithSam3(input: SegmentationInput): Promise<SegmentationOutput> {
  const root = env.COMFYUI_IMAGE_ROOT;
  if (!root) throw new Error("Localized editing requires COMFYUI_IMAGE_ROOT");
  if (!Number.isInteger(input.leaseFd)) throw new Error("Localized editing requires an inherited accelerator lease");
  const controller = new AbortController();
  let heartbeatFailure: unknown;
  let pendingHeartbeat: Promise<void> | undefined;
  let checking = false;
  const heartbeat = setInterval(() => {
    if (checking || controller.signal.aborted || !input.onHeartbeat) return;
    checking = true;
    pendingHeartbeat = input.onHeartbeat().catch(error => { heartbeatFailure = error; controller.abort(); }).finally(() => { checking = false; });
  }, 5_000);
  try {
    const result = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const child = spawn(env.COMFYUI_IMAGE_VENV_PYTHON ?? path.join(root, ".venv/bin/python"), [segmentationScript,
      "--comfy-root", root, "--checkpoint", path.join(root, "models/checkpoints/sam3.1_multiplex_fp16.safetensors"),
      "--stdio", "--lease-fd", "3", "--parent-pid", String(process.pid), "--target", input.pin.target, "--selection", input.pin.selection,
    ], { timeout: Math.min(env.IMAGE_TIMEOUT_MS, 120_000), killSignal: "SIGKILL", signal: controller.signal,
      stdio: ["pipe", "pipe", "pipe", input.leaseFd!],
      env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR,
        HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1", PYTHONUNBUFFERED: "1", PYTHONDONTWRITEBYTECODE: "1" } });
      let stdout = "";
      let stderr = "";
      let processFailure: unknown;
      child.stdout!.on("data", chunk => { stdout += String(chunk); if (stdout.length > 1024 * 1024) { processFailure = new Error("Segmentation evidence exceeds its limit"); child.kill("SIGKILL"); } });
      child.stderr!.on("data", chunk => { stderr = (stderr + String(chunk)).slice(-4096); });
      child.on("error", error => { processFailure = error; });
      child.stdin!.on("error", error => { processFailure = error; child.kill("SIGKILL"); });
      child.once("close", (code, signal) => {
        if (heartbeatFailure || processFailure || signal) { reject(heartbeatFailure ?? processFailure ?? new Error(`Segmentation terminated by ${signal}`)); return; }
        try {
          const evidence = JSON.parse(stdout) as Record<string, unknown>;
          if (code !== 0 || evidence.status !== "ok") throw new LocalizedImageEditError(typeof evidence.message === "string" ? evidence.message : "Segmentation rejected the target", evidence);
          resolve(evidence);
        } catch (error) { reject(error instanceof SyntaxError ? new Error(`Segmentation returned invalid evidence: ${stderr}`) : error); }
      });
      child.stdin!.end(input.source);
    });
    const { maskPngBase64, ...evidence } = result;
    if (typeof maskPngBase64 !== "string") throw new Error("Segmentation returned no mask");
    return { mask: Buffer.from(maskPngBase64, "base64"), evidence };
  } finally {
    clearInterval(heartbeat);
    await pendingHeartbeat;
    if (heartbeatFailure) throw heartbeatFailure;
  }
}
