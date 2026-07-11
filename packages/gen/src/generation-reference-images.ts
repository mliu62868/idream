import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export type GenerationReferenceRole = "identity_anchor" | "identity_reference" | "source_image";

export type GenerationReferenceImage = {
  assetId?: string;
  role: GenerationReferenceRole;
  weight?: number;
  b64Json?: string;
  url?: string;
  contentType?: string;
};

export type MaterializedGenerationReferenceImage = GenerationReferenceImage & {
  path: string;
};

export async function materializeGenerationReferenceImages(input: {
  images: GenerationReferenceImage[];
  dir: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<MaterializedGenerationReferenceImage[]> {
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

export async function cleanupGenerationReferenceImages(
  images: MaterializedGenerationReferenceImage[],
) {
  await Promise.all(images.map((image) => rm(image.path, { force: true }).catch(() => {})));
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
  return match[2]
    ? new Uint8Array(Buffer.from(body, "base64"))
    : new TextEncoder().encode(decodeURIComponent(body));
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
