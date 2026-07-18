import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";
import type { ImageGeneratePayload } from "@idream/shared/contracts";
import { resolveLocalBlobPath } from "@idream/shared/storage/local-blob";
import type { BlobStore } from "./providers";

type ImageReferenceInput = NonNullable<ImageGeneratePayload["referenceImages"]>[number];

export async function hydratedImageReferenceInputs(
  images: ImageReferenceInput[] | undefined,
  blob: BlobStore,
): Promise<ImageReferenceInput[]> {
  const requested = images ?? [];
  const hydrated = await Promise.all(
    requested.map(async (image) => {
      if (image.b64Json || isAbsoluteUrl(image.url)) return image;
      if (!image.storageKey) return image;
      const local = await localBlobReference(image);
      if (local) return local;
      const signed = await blob.signGetUrl({
        key: image.storageKey,
        expiresInSeconds: 60 * 15,
      });
      if (signed.ok) return { ...image, url: signed.data.url };
      return image;
    }),
  );
  const readable = hydrated.filter(
    (image) => image.b64Json || isAbsoluteUrl(image.url),
  );
  if (readable.length !== requested.length) {
    const readableIds = new Set(readable.map((image) => image.assetId));
    const unavailableAssetIds = requested.flatMap((image) =>
      readableIds.has(image.assetId) ? [] : [image.assetId]
    );
    throw new Error(
      `Pinned image references could not be hydrated: ${unavailableAssetIds.join(", ")}`,
    );
  }
  return readable;
}

async function localBlobReference(image: ImageReferenceInput) {
  if (!image.storageKey) return null;
  try {
    const bytes = await readFile(resolveLocalBlobPath(image.storageKey));
    return {
      ...image,
      b64Json: Buffer.from(bytes).toString("base64"),
    };
  } catch {
    return null;
  }
}

function isAbsoluteUrl(value: string | undefined) {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}
