import { createHash, randomUUID } from "node:crypto";
import {
  characterImageSourceListResponseSchema,
  characterImageSourceUploadRequestSchema,
  characterImageSourceUploadResponseSchema,
  type CharacterImageSourceAsset,
} from "@idream/shared/admin";
import type { MediaAsset, Prisma } from "@prisma/client";
import sharp from "sharp";
import { prisma } from "@/server/lib/db";
import { env } from "@/server/lib/env";
import { Errors } from "@/server/lib/errors";
import {
  operationalCharacterWhere,
  operationalMediaAssetWhere,
} from "@/server/modules/metric-data-scope";
import type { AdminActor } from "@/server/modules/admin-v2/shared/authority";
import { executeAtomicIdempotentMutation } from "@/server/modules/admin-v2/shared/atomic-mutation";
import { toInputJson } from "@/server/modules/admin-v2/shared/prisma-json";
import { providers } from "@/server/providers";

const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const MIN_IMAGE_BYTES = 512;
const MAX_IMAGE_PIXELS = 40_000_000;
const MAX_IMAGE_EDGE = 8_192;
const MIN_IMAGE_EDGE = 64;
const LIST_LIMIT = 24;
const IMAGE_SOURCE_PURPOSE = "identity_experiment_source";

type SupportedImageFormat = "jpeg" | "png" | "webp";

export type ParsedCharacterImageSourceForm = {
  purpose: typeof IMAGE_SOURCE_PURPOSE;
  image: {
    filename: string;
    contentType: "image/jpeg" | "image/png" | "image/webp";
    extension: ".jpg" | ".png" | ".webp";
    body: Uint8Array;
    sha256: string;
    width: number;
    height: number;
  };
};

export async function parseCharacterImageSourceForm(
  request: Request,
): Promise<ParsedCharacterImageSourceForm> {
  const form = await request.formData();
  const fields = characterImageSourceUploadRequestSchema.parse({
    purpose: stringField(form, "purpose"),
  });
  const image = form.get("image");
  if (!(image instanceof File)) {
    throw Errors.badRequest("Image source file is required");
  }
  if (image.size < MIN_IMAGE_BYTES) {
    throw Errors.badRequest("Image source file is too small");
  }
  if (image.size > MAX_IMAGE_BYTES) {
    throw Errors.badRequest("Image source must be 15 MB or smaller");
  }

  const body = new Uint8Array(await image.arrayBuffer());
  let metadata: Awaited<ReturnType<ReturnType<typeof sharp>["metadata"]>>;
  try {
    metadata = await sharp(body, {
      failOn: "error",
      limitInputPixels: MAX_IMAGE_PIXELS,
    }).metadata();
  } catch {
    throw Errors.badRequest("Image source could not be decoded");
  }
  if (!isSupportedImageFormat(metadata.format)) {
    throw Errors.badRequest("Image source must be JPEG, PNG, or WebP");
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
      "Image source dimensions must be between 64 and 8192 pixels",
    );
  }
  if (width * height > MAX_IMAGE_PIXELS) {
    throw Errors.badRequest("Image source contains too many pixels");
  }

  const contentType = contentTypeFor(metadata.format);
  const extension = extensionFor(metadata.format);
  return {
    purpose: fields.purpose,
    image: {
      filename: normalizedFilename(image.name, extension),
      contentType,
      extension,
      body,
      sha256: createHash("sha256").update(body).digest("hex"),
      width,
      height,
    },
  };
}

export async function listCharacterImageSources(input: {
  characterId: string;
}) {
  await requireCharacter(input.characterId);
  const assets = await prisma.mediaAsset.findMany({
    where: operationalMediaAssetWhere({
      characterId: input.characterId,
      type: "image",
      visibility: "private",
      safetyStatus: "passed",
      deletedAt: null,
      metadata: {
        path: ["purpose"],
        equals: IMAGE_SOURCE_PURPOSE,
      },
    }),
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: LIST_LIMIT,
  });
  return characterImageSourceListResponseSchema.parse({
    items: assets.map(characterImageSourceAssetDto),
  });
}

export async function createCharacterImageSource(input: {
  characterId: string;
  actor: AdminActor;
  idempotencyKey: string;
  requestId: string;
  form: ParsedCharacterImageSourceForm;
}) {
  await requireCharacter(input.characterId);

  const uploadId = randomUUID();
  const assetId = `media_identity_source_${uploadId}`;
  const storageKey =
    `character-image-sources/${input.characterId}/${uploadId}${input.form.image.extension}`;
  let preparedStored = false;
  let mutationCompleted = false;

  try {
    const result = await executeAtomicIdempotentMutation({
      environment: env.APP_ENV,
      actor: input.actor,
      idempotencyKey: input.idempotencyKey,
      requestId: input.requestId,
      commandType: "character.identity_experiment_source.upload",
      target: { type: "character", id: input.characterId },
      payload: {
        purpose: input.form.purpose,
        filename: input.form.image.filename,
        contentType: input.form.image.contentType,
        sizeBytes: input.form.image.body.byteLength,
        sha256: input.form.image.sha256,
        width: input.form.image.width,
        height: input.form.image.height,
      },
      prepare: async () => {
        const stored = await providers.blob.putPrivate({
          key: storageKey,
          body: input.form.image.body,
          contentType: input.form.image.contentType,
        });
        if (!stored.ok) {
          throw Errors.unavailable("Image source storage failed", stored.error);
        }
        preparedStored = true;
        return stored.data;
      },
      mutate: async (tx) => {
        const locked = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT "id" FROM "characters"
          WHERE "id" = ${input.characterId}
          FOR UPDATE
        `;
        if (!locked[0]) throw Errors.notFound("Character not found");
        const asset = await tx.mediaAsset.create({
          data: {
            id: assetId,
            ownerId: input.actor.id,
            characterId: input.characterId,
            type: "image",
            url: mediaViewUrl(assetId, input.form.image.extension),
            storageKey,
            contentType: input.form.image.contentType,
            width: input.form.image.width,
            height: input.form.image.height,
            visibility: "private",
            safetyStatus: "passed",
            metadata: toInputJson({
              purpose: input.form.purpose,
              source: "admin_local_upload",
              filename: input.form.image.filename,
              sizeBytes: input.form.image.body.byteLength,
              sha256: input.form.image.sha256,
              platformAsset: {
                purpose: input.form.purpose,
                status: "draft",
              },
            }),
          },
        });
        await tx.adminAuditLog.create({
          data: {
            actorId: input.actor.id,
            actorRole: input.actor.role,
            action: "character.identity_experiment_source.uploaded",
            targetType: "media_asset",
            targetId: asset.id,
            reason: "Upload a private local source for an identity experiment",
            after: toInputJson({
              characterId: input.characterId,
              assetId: asset.id,
              filename: input.form.image.filename,
              contentType: input.form.image.contentType,
              sizeBytes: input.form.image.body.byteLength,
              width: input.form.image.width,
              height: input.form.image.height,
              visibility: asset.visibility,
              referenceSetChanged: false,
            }),
            requestId: input.requestId,
          },
        });
        return { asset: characterImageSourceAssetDto(asset) };
      },
      decorateResult: (value, replayed) => ({
        ...(value as Record<string, unknown>),
        replayed,
      }),
    });
    mutationCompleted = true;
    const parsed = characterImageSourceUploadResponseSchema.parse(result);
    if (parsed.replayed && preparedStored) {
      await deletePreparedBlob(storageKey);
    }
    return parsed;
  } catch (cause) {
    if (!mutationCompleted && preparedStored) {
      await deletePreparedBlob(storageKey);
    }
    throw cause;
  }
}

function characterImageSourceAssetDto(
  asset: MediaAsset,
): CharacterImageSourceAsset {
  const metadata = jsonObject(asset.metadata);
  return {
    id: asset.id,
    url: asset.url,
    thumbnailUrl: asset.thumbnailUrl,
    filename:
      typeof metadata.filename === "string"
        ? metadata.filename
        : `image-source${extensionForContentType(asset.contentType)}`,
    contentType: supportedContentType(asset.contentType),
    sizeBytes:
      typeof metadata.sizeBytes === "number" && metadata.sizeBytes > 0
        ? Math.trunc(metadata.sizeBytes)
        : 1,
    width: asset.width ?? 1,
    height: asset.height ?? 1,
    createdAt: asset.createdAt.toISOString(),
  };
}

async function requireCharacter(characterId: string) {
  const character = await prisma.character.findFirst({
    where: operationalCharacterWhere({
      id: characterId,
      deletedAt: null,
    }),
    select: { id: true },
  });
  if (!character) throw Errors.notFound("Character not found");
}

async function deletePreparedBlob(storageKey: string) {
  await Promise.allSettled([providers.blob.delete({ key: storageKey })]);
}

function stringField(form: FormData, key: string) {
  const value = form.get(key);
  return typeof value === "string" ? value : "";
}

function isSupportedImageFormat(
  format: string | undefined,
): format is SupportedImageFormat {
  return format === "jpeg" || format === "png" || format === "webp";
}

function contentTypeFor(
  format: SupportedImageFormat,
): "image/jpeg" | "image/png" | "image/webp" {
  if (format === "jpeg") return "image/jpeg";
  if (format === "png") return "image/png";
  return "image/webp";
}

function extensionFor(
  format: SupportedImageFormat,
): ".jpg" | ".png" | ".webp" {
  if (format === "jpeg") return ".jpg";
  if (format === "png") return ".png";
  return ".webp";
}

function supportedContentType(
  value: string | null,
): "image/jpeg" | "image/png" | "image/webp" {
  if (value === "image/jpeg" || value === "image/png" || value === "image/webp") {
    return value;
  }
  return "image/jpeg";
}

function extensionForContentType(value: string | null) {
  if (value === "image/png") return ".png";
  if (value === "image/webp") return ".webp";
  return ".jpg";
}

function normalizedFilename(
  filename: string,
  extension: ".jpg" | ".png" | ".webp",
) {
  const withoutExtension = filename.replace(/\.[^.]+$/, "");
  const normalized = withoutExtension
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 170);
  return `${normalized || "local-image-source"}${extension}`;
}

function mediaViewUrl(assetId: string, extension: string) {
  const token = Buffer.from(assetId, "utf8").toString("base64url");
  return `/user-content/${token}/content${extension}`;
}

function jsonObject(value: Prisma.JsonValue): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
