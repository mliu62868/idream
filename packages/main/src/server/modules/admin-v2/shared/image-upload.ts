import { createHash } from "node:crypto";
import sharp from "sharp";
import { Errors } from "@/server/lib/errors";

const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const MIN_IMAGE_BYTES = 512;
const MAX_IMAGE_PIXELS = 40_000_000;
const MAX_IMAGE_EDGE = 8_192;
const MIN_IMAGE_EDGE = 64;

type SupportedImageFormat = "jpeg" | "png" | "webp";

export type ParsedAdminImageUpload = {
  filename: string;
  contentType: "image/jpeg" | "image/png" | "image/webp";
  extension: ".jpg" | ".png" | ".webp";
  body: Uint8Array;
  sha256: string;
  width: number;
  height: number;
};

/**
 * SPEC: every Admin image import accepts one decoded, single-frame JPEG/PNG/WebP between
 * 64 and 8192 pixels and at most 15 MB / 40 MP.
 * INTENT: Character imports and platform-asset uploads are different product commands,
 * but accepting bytes is one security and storage boundary. Keep that judgement here.
 */
export async function parseAdminImageUpload(
  form: FormData,
  fieldName = "image",
): Promise<ParsedAdminImageUpload> {
  const image = form.get(fieldName);
  if (!(image instanceof File)) {
    throw Errors.badRequest("Image file is required");
  }
  if (image.size < MIN_IMAGE_BYTES) {
    throw Errors.badRequest("Image file is too small");
  }
  if (image.size > MAX_IMAGE_BYTES) {
    throw Errors.badRequest("Image must be 15 MB or smaller");
  }

  const body = new Uint8Array(await image.arrayBuffer());
  let metadata: Awaited<ReturnType<ReturnType<typeof sharp>["metadata"]>>;
  try {
    metadata = await sharp(body, {
      failOn: "error",
      limitInputPixels: MAX_IMAGE_PIXELS,
    }).metadata();
  } catch {
    throw Errors.badRequest("Image could not be decoded");
  }
  if (!isSupportedImageFormat(metadata.format)) {
    throw Errors.badRequest("Image must be JPEG, PNG, or WebP");
  }
  if ((metadata.pages ?? 1) !== 1) {
    throw Errors.badRequest("Animated or multi-page images are not supported");
  }
  const width = metadata.width ?? 0;
  const height = metadata.height ?? 0;
  if (
    width < MIN_IMAGE_EDGE ||
    height < MIN_IMAGE_EDGE ||
    width > MAX_IMAGE_EDGE ||
    height > MAX_IMAGE_EDGE
  ) {
    throw Errors.badRequest(
      "Image dimensions must be between 64 and 8192 pixels",
    );
  }
  if (width * height > MAX_IMAGE_PIXELS) {
    throw Errors.badRequest("Image contains too many pixels");
  }

  const contentType = contentTypeFor(metadata.format);
  const extension = extensionFor(metadata.format);
  return {
    filename: normalizedFilename(image.name, extension),
    contentType,
    extension,
    body,
    sha256: createHash("sha256").update(body).digest("hex"),
    width,
    height,
  };
}

function isSupportedImageFormat(
  format: string | undefined,
): format is SupportedImageFormat {
  return format === "jpeg" || format === "png" || format === "webp";
}

function contentTypeFor(
  format: SupportedImageFormat,
): ParsedAdminImageUpload["contentType"] {
  if (format === "jpeg") return "image/jpeg";
  if (format === "png") return "image/png";
  return "image/webp";
}

function extensionFor(
  format: SupportedImageFormat,
): ParsedAdminImageUpload["extension"] {
  if (format === "jpeg") return ".jpg";
  if (format === "png") return ".png";
  return ".webp";
}

function normalizedFilename(
  filename: string,
  extension: ParsedAdminImageUpload["extension"],
) {
  const withoutExtension = filename.replace(/\.[^.]+$/, "");
  const normalized = withoutExtension
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 170);
  return `${normalized || "uploaded-image"}${extension}`;
}
