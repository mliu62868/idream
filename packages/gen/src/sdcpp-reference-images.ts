import {
  cleanupGenerationReferenceImages,
  materializeGenerationReferenceImages,
  type GenerationReferenceImage,
  type GenerationReferenceRole,
  type MaterializedGenerationReferenceImage,
} from "./generation-reference-images";

export {
  cleanupGenerationReferenceImages,
  materializeGenerationReferenceImages,
  type GenerationReferenceImage,
  type GenerationReferenceRole,
  type MaterializedGenerationReferenceImage,
} from "./generation-reference-images";

// Compatibility aliases for the sd.cpp-specific parsing/argument helpers below.
export type SdcppReferenceRole = GenerationReferenceRole;
export type SdcppReferenceImage = GenerationReferenceImage;
export type MaterializedSdcppReferenceImage = MaterializedGenerationReferenceImage;

export type SdcppReferenceMode = "auto" | "ref_image" | "init_img" | "disabled";

export function parseSdcppReferenceImages(value: unknown, maxCount: number): SdcppReferenceImage[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(isRecord)
    .flatMap((item): SdcppReferenceImage[] => {
      const b64Json = stringField(item, "b64Json") ?? stringField(item, "b64_json") ?? stringField(item, "base64");
      const url = stringField(item, "url");
      if (!b64Json && !url) return [];
      return [{
        role: referenceRole(stringField(item, "role")),
        ...(stringField(item, "assetId") ?? stringField(item, "asset_id")
          ? { assetId: stringField(item, "assetId") ?? stringField(item, "asset_id") }
          : {}),
        ...(typeof item.weight === "number" && Number.isFinite(item.weight)
          ? { weight: clampNumber(item.weight, 0, 2) }
          : {}),
        ...(b64Json ? { b64Json } : {}),
        ...(url ? { url } : {}),
        ...(stringField(item, "contentType") ?? stringField(item, "content_type")
          ? { contentType: stringField(item, "contentType") ?? stringField(item, "content_type") }
          : {}),
      }];
    })
    .slice(0, Math.max(0, maxCount));
}

export const materializeSdcppReferenceImages = materializeGenerationReferenceImages;

export const cleanupSdcppReferenceImages = cleanupGenerationReferenceImages;

export function sdcppReferenceArgs(input: {
  images: MaterializedSdcppReferenceImage[];
  mode: SdcppReferenceMode;
  strength: number;
}) {
  if (input.mode === "disabled" || input.images.length === 0) return [];
  if (input.mode === "ref_image") return refImageArgs(input.images);
  if (input.mode === "init_img") return initImageArgs(input.images, input.strength);

  const source = input.images.find((image) => image.role === "source_image");
  const identityRefs = input.images.filter((image) => image !== source);
  return [
    ...(source ? initImageArgs([source], input.strength) : []),
    ...refImageArgs(identityRefs.length > 0 ? identityRefs : source ? [] : input.images),
  ];
}

function initImageArgs(images: MaterializedSdcppReferenceImage[], strength: number) {
  const [image, ...rest] = images;
  if (!image) return [];
  return [
    "--init-img",
    image.path,
    "--strength",
    String(clampNumber(strength, 0.05, 0.95)),
    ...refImageArgs(rest),
  ];
}

function refImageArgs(images: MaterializedSdcppReferenceImage[]) {
  if (images.length === 0) return [];
  return [
    ...images.flatMap((image) => ["--ref-image", image.path]),
    ...(images.length > 1 ? ["--increase-ref-index"] : []),
  ];
}

function referenceRole(value: string | undefined): SdcppReferenceRole {
  if (
    value === "identity_anchor" ||
    value === "look_reference" ||
    value === "source_image"
  ) return value;
  return "identity_reference";
}

function stringField(record: Record<string, unknown>, key: string) {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clampNumber(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}
