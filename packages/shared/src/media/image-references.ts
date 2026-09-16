import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";
import type { ImageGeneratePayload } from "../contracts";
import { resolveLocalBlobPath } from "../storage/local-blob";

export type ImageReferenceInput =
  NonNullable<ImageGeneratePayload["referenceImages"]>[number];

/** The one capability hydration needs from a blob store. */
export type ImageReferenceBlobStore = {
  signGetUrl(input: {
    key: string;
    expiresInSeconds: number;
  }): Promise<
    | { ok: true; data: { url: string } }
    | { ok: false; error: unknown }
  >;
};

// SPEC: turn pinned image references into something a provider can actually read
//   — inline base64 when the bytes are on this host, otherwise a signed URL.
// INTENT: this lived in packages/gen AND packages/main as two byte-identical
//   copies (only the blob parameter's type name differed). gen ran one of them;
//   main's copy had no production caller at all, and existed so that three Main
//   tests could assert "the references Main pins are hydratable". Those tests
//   were therefore asserting against a copy that could silently drift from the
//   implementation that actually runs. One implementation, imported by both.
// INVARIANT: every requested reference must come back readable; a reference that
//   resolves to neither bytes nor an absolute URL fails the whole set loudly
//   rather than silently generating from a smaller reference set.
export async function hydratedImageReferenceInputs(
  images: ImageReferenceInput[] | undefined,
  blob: ImageReferenceBlobStore,
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
