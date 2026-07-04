import { Buffer } from "node:buffer";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

export type SdcppReferenceRole = "identity_anchor" | "identity_reference" | "source_image";

export type SdcppReferenceImage = {
  assetId?: string;
  role: SdcppReferenceRole;
  weight?: number;
  b64Json?: string;
  url?: string;
  contentType?: string;
};

export type MaterializedSdcppReferenceImage = SdcppReferenceImage & {
  path: string;
};

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

export async function materializeSdcppReferenceImages(input: {
  images: SdcppReferenceImage[];
  dir: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<MaterializedSdcppReferenceImage[]> {
  await mkdir(input.dir, { recursive: true });
  return Promise.all(
    input.images.map(async (image, index) => {
      const bytes = image.b64Json
        ? new Uint8Array(Buffer.from(image.b64Json, "base64"))
        : await bytesFromUrl(image.url, input.fetchImpl ?? fetch, input.timeoutMs ?? 15_000);
      const contentType = image.contentType ?? contentTypeFromBytes(bytes) ?? "image/png";
      const filePath = path.join(
        input.dir,
        `reference-${index + 1}-${randomUUID()}${extensionForContentType(contentType)}`,
      );
      await writeFile(filePath, bytes);
      return { ...image, contentType, path: filePath };
    }),
  );
}

export async function cleanupSdcppReferenceImages(images: MaterializedSdcppReferenceImage[]) {
  await Promise.all(images.map((image) => rm(image.path, { force: true }).catch(() => {})));
}

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

async function bytesFromUrl(urlValue: string | undefined, fetchImpl: typeof fetch, timeoutMs: number) {
  if (!urlValue) throw new Error("reference image is missing bytes");
  if (urlValue.startsWith("data:")) return bytesFromDataUrl(urlValue);
  const url = new URL(urlValue);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Unsupported reference image URL protocol: ${url.protocol}`);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`Reference image fetch failed: ${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
  } finally {
    clearTimeout(timer);
  }
}

function bytesFromDataUrl(value: string) {
  const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(value);
  if (!match) throw new Error("Invalid reference image data URL");
  const body = match[3] ?? "";
  return match[2] ? new Uint8Array(Buffer.from(body, "base64")) : new TextEncoder().encode(decodeURIComponent(body));
}

function referenceRole(value: string | undefined): SdcppReferenceRole {
  if (value === "identity_anchor" || value === "source_image") return value;
  return "identity_reference";
}

function extensionForContentType(contentType: string) {
  const lower = contentType.toLowerCase();
  if (lower.includes("webp")) return ".webp";
  if (lower.includes("jpeg") || lower.includes("jpg")) return ".jpg";
  if (lower.includes("gif")) return ".gif";
  return ".png";
}

function contentTypeFromBytes(bytes: Uint8Array) {
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  return undefined;
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
