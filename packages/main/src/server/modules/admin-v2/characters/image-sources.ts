import { randomUUID } from "node:crypto";
import {
  characterImageSourceListResponseSchema,
  characterImageSourceUploadRequestSchema,
  characterImageSourceUploadResponseSchema,
  type CharacterImageQualification,
  type CharacterImageSourceAsset,
} from "@idream/shared/admin";
import type { MediaAsset, Prisma } from "@prisma/client";
import { prisma } from "@/server/lib/db";
import { env } from "@/server/lib/env";
import { Errors } from "@/server/lib/errors";
import {
  mediaAssetPlatformStatus,
  OPERATOR_UPLOAD_AUTHORITY_SCHEMA,
} from "@/server/lib/media-asset-authority";
import {
  operationalCharacterWhere,
  operationalMediaAssetWhere,
} from "@/server/modules/metric-data-scope";
import type { AdminActor } from "@/server/modules/admin-v2/shared/authority";
import { executeAtomicIdempotentMutation } from "@/server/modules/admin-v2/shared/atomic-mutation";
import {
  parseAdminImageUpload,
  type ParsedAdminImageUpload,
} from "@/server/modules/admin-v2/shared/image-upload";
import { toInputJson } from "@/server/modules/admin-v2/shared/prisma-json";
import { providers } from "@/server/providers";
import { decodeAdminListCursor, encodeAdminListCursor, parseIsoCursorKey } from "../shared/list-cursor";
import { characterImageQualifications } from "./image-qualification";

const LIST_LIMIT = 100;
const IMAGE_SOURCE_PURPOSE = "identity_experiment_source";
const CHARACTER_LIBRARY_PURPOSE = "character_library";

type CharacterImageUploadPurpose =
  | typeof IMAGE_SOURCE_PURPOSE
  | typeof CHARACTER_LIBRARY_PURPOSE;

export type ParsedCharacterImageSourceForm = {
  purpose: CharacterImageUploadPurpose;
  image: ParsedAdminImageUpload;
};

export async function parseCharacterImageSourceForm(
  request: Request,
): Promise<ParsedCharacterImageSourceForm> {
  const form = await request.formData();
  const fields = characterImageSourceUploadRequestSchema.parse({
    purpose: stringField(form, "purpose"),
  });
  return {
    purpose: fields.purpose,
    image: await parseAdminImageUpload(form),
  };
}

export async function listCharacterImageSources(input: {
  characterId: string;
  purpose?: CharacterImageUploadPurpose;
  cursor?: string;
  search?: string;
  limit?: number;
}) {
  await requireCharacter(input.characterId);
  const purpose = input.purpose ?? IMAGE_SOURCE_PURPOSE;
  const limit = input.limit ?? LIST_LIMIT;
  const search = input.search?.trim().toLowerCase() ?? "";
  const queryIdentity = { characterId: input.characterId, purpose, search };
  const scope = "character-image-sources";
  const cursorKeys = input.cursor
    ? decodeAdminListCursor(input.cursor, scope, queryIdentity) : null;
  if (cursorKeys && (cursorKeys.length !== 2 || typeof cursorKeys[1] !== "string")) {
    throw Errors.badRequest("Invalid image library cursor");
  }
  let anchor = cursorKeys ? {
    createdAt: parseIsoCursorKey(cursorKeys[0], scope),
    id: cursorKeys[1] as string,
  } : null;
  const where = operationalMediaAssetWhere({
      characterId: input.characterId,
      type: "image",
      safetyStatus: "passed",
      deletedAt: null,
      ...(purpose === IMAGE_SOURCE_PURPOSE
        ? {
            visibility: "private",
            metadata: {
              path: ["purpose"],
              equals: IMAGE_SOURCE_PURPOSE,
            },
          }
        : {
            // Publication changes visibility, not membership in this library.
            OR: [
              {
                metadata: {
                  path: ["purpose"],
                  equals: CHARACTER_LIBRARY_PURPOSE,
                },
              },
              {
                metadata: {
                  path: ["platformAsset", "purpose"],
                  equals: CHARACTER_LIBRARY_PURPOSE,
                },
              },
              {
                productionItems: {
                  some: {
                    batch: {
                      targetType: "character",
                      targetId: input.characterId,
                      purpose: {
                        in: [
                          "character_cover",
                          "character_hero",
                          "character_chat",
                        ],
                      },
                    },
                  },
                },
              },
            ],
          }),
    });
  const items: CharacterImageSourceAsset[] = [];
  // Filter membership and search before the visible page limit. Scanning keyset
  // batches preserves legacy JSON metadata and never hides older eligible rows.
  while (items.length <= limit) {
    const assets = await prisma.mediaAsset.findMany({
      where: { AND: [where, ...(anchor ? [{ OR: [
        { createdAt: { lt: anchor.createdAt } },
        { createdAt: anchor.createdAt, id: { lt: anchor.id } },
      ] }] : [])] },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: LIST_LIMIT,
    });
    const visibleAssets = assets.filter((asset) =>
      mediaAssetPlatformStatus(asset.metadata) !== "archived"
    );
    const qualifications = purpose === CHARACTER_LIBRARY_PURPOSE
      ? await characterImageQualifications(prisma, input.characterId, visibleAssets)
      : new Map<string, CharacterImageQualification>();
    for (const asset of visibleAssets) {
      const dto = characterImageSourceAssetDto(asset, qualifications.get(asset.id) ?? null);
      if (search && ![dto.id, dto.filename, dto.qualification?.source ?? "", dto.qualification?.state ?? ""]
        .join(" ").toLowerCase().includes(search)) continue;
      items.push(dto);
      if (items.length > limit) break;
    }
    if (assets.length < LIST_LIMIT) break;
    const last = assets[assets.length - 1];
    anchor = { createdAt: last.createdAt, id: last.id };
  }
  const hasMore = items.length > limit;
  const page = items.slice(0, limit);
  const last = page[page.length - 1];
  return characterImageSourceListResponseSchema.parse({
    items: page,
    nextCursor: hasMore && last
      ? encodeAdminListCursor(scope, queryIdentity, [last.createdAt, last.id])
      : null,
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
  const assetId = input.form.purpose === CHARACTER_LIBRARY_PURPOSE
    ? `media_character_upload_${uploadId}`
    : `media_identity_source_${uploadId}`;
  const storageKey =
    `character-images/${input.characterId}/${uploadId}${input.form.image.extension}`;
  let preparedStored = false;
  let mutationCompleted = false;

  try {
    const result = await executeAtomicIdempotentMutation({
      environment: env.APP_ENV,
      actor: input.actor,
      idempotencyKey: input.idempotencyKey,
      requestId: input.requestId,
      commandType: input.form.purpose === CHARACTER_LIBRARY_PURPOSE
        ? "character.library_asset.upload"
        : "character.identity_experiment_source.upload",
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
              source: "admin_asset_upload",
              synthetic: false,
              filename: input.form.image.filename,
              sizeBytes: input.form.image.body.byteLength,
              sha256: input.form.image.sha256,
              uploadAuthority: {
                schemaVersion: OPERATOR_UPLOAD_AUTHORITY_SCHEMA,
                kind: "operator_upload",
                assetId,
                uploadedById: input.actor.id,
                sha256: input.form.image.sha256,
              },
              platformAsset: {
                purpose: input.form.purpose,
                status: "draft",
                tags: [],
                updatedAt: new Date().toISOString(),
              },
            }),
          },
        });
        await tx.adminAuditLog.create({
          data: {
            actorId: input.actor.id,
            actorRole: input.actor.role,
            action: input.form.purpose === CHARACTER_LIBRARY_PURPOSE
              ? "character.library_asset.uploaded"
              : "character.identity_experiment_source.uploaded",
            targetType: "media_asset",
            targetId: asset.id,
            reason: input.form.purpose === CHARACTER_LIBRARY_PURPOSE
              ? "Import an image into the Character library"
              : "Upload a private local source for an identity experiment",
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
        const qualification = input.form.purpose === CHARACTER_LIBRARY_PURPOSE
          ? (
              await characterImageQualifications(
                tx,
                input.characterId,
                [asset],
              )
            ).get(asset.id) ?? null
          : null;
        return {
          asset: characterImageSourceAssetDto(asset, qualification),
        };
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
  qualification: CharacterImageQualification | null,
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
    qualification,
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

function mediaViewUrl(assetId: string, extension: string) {
  const token = Buffer.from(assetId, "utf8").toString("base64url");
  return `/user-content/${token}/content${extension}`;
}

function jsonObject(value: Prisma.JsonValue): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
