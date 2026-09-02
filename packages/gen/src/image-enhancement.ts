import { createHash } from "node:crypto";
import type { ImageGeneratePayload } from "@idream/shared/contracts";
import sharp from "sharp";
import { z } from "zod";
import { env } from "./env";
import { GenerationArtifactError } from "./generation-execution";

const enhancementSchema = z.object({
  sourceMediaId: z.string().min(1),
  sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
  sourceWidth: z.number().int().positive().max(2048),
  sourceHeight: z.number().int().positive().max(2048),
  scale: z.literal(2),
}).strict();

type Enhancement = z.infer<typeof enhancementSchema>;
type ReferenceImage = NonNullable<ImageGeneratePayload["referenceImages"]>[number];

// The same bytes checked against Main's source pin must reach the provider.
// Freezing a signed URL alone would let the provider fetch a changed object.
export async function prepareImageEnhancement(payload: ImageGeneratePayload, references: ReferenceImage[]) {
  if (payload.model !== "realesrgan-x2plus" && payload.model !== "realesrgan-x2plus-enhance") {
    if (payload.controls.enhancement !== undefined) throw new Error("Enhance controls require the Enhance model");
    return null;
  }
  const pin = enhancementSchema.parse(payload.controls.enhancement);
  if (
    payload.count !== 1 || references.length !== 1 ||
    references[0]?.assetId !== pin.sourceMediaId || references[0]?.role !== "source_image" ||
    payload.controls.sourceImageAssetId !== pin.sourceMediaId ||
    payload.controls.width !== pin.sourceWidth * 2 || payload.controls.height !== pin.sourceHeight * 2 ||
    pin.sourceWidth * pin.sourceHeight > 4_194_304 ||
    payload.controls.workflowKey !== "realesrgan-x2plus-enhance" || payload.controls.workflowVersion !== 1
  ) throw new Error("Enhance requires its pinned source, two-times dimensions and one output");
  const reference = references[0];
  const bytes = reference.b64Json
    ? Buffer.from(reference.b64Json, "base64")
    : await referenceBytes(reference.url);
  if (createHash("sha256").update(bytes).digest("hex") !== pin.sourceSha256) {
    throw new Error("Enhance source bytes no longer match the accepted source");
  }
  const actual = await decodedImage(bytes, 4_194_304);
  if (actual.width !== pin.sourceWidth || actual.height !== pin.sourceHeight) {
    throw new Error("Enhance source dimensions do not match the accepted source");
  }
  return {
    pin,
    reference: {
      assetId: pin.sourceMediaId, role: "source_image" as const,
      b64Json: bytes.toString("base64"), contentType: actual.contentType,
      width: actual.width, height: actual.height,
    },
  };
}

export async function enhancedImageDimensions(body: Uint8Array, pin: Enhancement) {
  try {
    const actual = await decodedImage(Buffer.from(body), 16_777_216);
    if (actual.width !== pin.sourceWidth * 2 || actual.height !== pin.sourceHeight * 2) {
      throw new Error("Enhance output must have exactly twice the source width and height");
    }
    return actual;
  } catch (error) {
    throw new GenerationArtifactError("enhancement_output_invalid", error instanceof Error ? error.message : "Enhance output cannot be decoded", false);
  }
}

async function decodedImage(bytes: Buffer, maximumPixels: number) {
  const image = sharp(bytes, { failOn: "warning", limitInputPixels: maximumPixels });
  const metadata = await image.metadata();
  if (
    !["png", "jpeg", "webp"].includes(metadata.format ?? "") ||
    (metadata.pages ?? 1) !== 1 || (metadata.orientation ?? 1) !== 1
  ) throw new Error("Enhance requires a single PNG, JPEG or WebP image with no EXIF rotation");
  // Metadata alone does not prove that compressed pixels can be decoded.
  const { info } = await image.raw().toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, contentType: `image/${metadata.format}` };
}

async function referenceBytes(url: string | undefined): Promise<Buffer> {
  if (!url) throw new Error("Enhance source image is not readable");
  const response = await fetch(url, { signal: AbortSignal.timeout(env.PIPELINE_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`Enhance source fetch failed with status ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}
