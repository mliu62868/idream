import { createHash, randomUUID } from "node:crypto";
import {
  characterVideoSourceUploadRequestSchema,
  characterVideoSourceUploadResponseSchema,
  type CharacterVideoUploadAsset,
} from "@idream/shared/admin";
import type { MediaAsset, Prisma } from "@prisma/client";
import { prisma } from "@/server/lib/db";
import { env } from "@/server/lib/env";
import { Errors } from "@/server/lib/errors";
import { operationalCharacterWhere } from "@/server/modules/metric-data-scope";
import type { AdminActor } from "@/server/modules/admin-v2/shared/authority";
import { executeAtomicIdempotentMutation } from "@/server/modules/admin-v2/shared/atomic-mutation";
import { toInputJson } from "@/server/modules/admin-v2/shared/prisma-json";
import { providers } from "@/server/providers";

const MIN_VIDEO_BYTES = 1_024;
const MAX_VIDEO_BYTES = 100 * 1024 * 1024;

type SupportedVideo = {
  contentType: "video/mp4" | "video/webm";
  extension: ".mp4" | ".webm";
};

export type ParsedCharacterVideoSourceForm = {
  purpose: "character_video_library";
  video: SupportedVideo & {
    filename: string;
    body: Uint8Array;
    sha256: string;
  };
};

export async function parseCharacterVideoSourceForm(
  request: Request,
): Promise<ParsedCharacterVideoSourceForm> {
  const form = await request.formData();
  const fields = characterVideoSourceUploadRequestSchema.parse({
    purpose: stringField(form, "purpose"),
  });
  const video = form.get("video");
  if (!(video instanceof File)) throw Errors.badRequest("Video file is required");
  if (video.size < MIN_VIDEO_BYTES) throw Errors.badRequest("Video file is too small");
  if (video.size > MAX_VIDEO_BYTES) {
    throw Errors.badRequest("Video must be 100 MB or smaller");
  }
  const supported = supportedVideo(video);
  if (!supported) throw Errors.badRequest("Video must be MP4 or WebM");
  const body = new Uint8Array(await video.arrayBuffer());
  return {
    purpose: fields.purpose,
    video: {
      ...supported,
      filename: normalizedFilename(video.name, supported.extension),
      body,
      sha256: createHash("sha256").update(body).digest("hex"),
    },
  };
}

export async function createCharacterVideoSource(input: {
  characterId: string;
  actor: AdminActor;
  idempotencyKey: string;
  requestId: string;
  form: ParsedCharacterVideoSourceForm;
}) {
  await requireCharacter(input.characterId);
  const uploadId = randomUUID();
  const assetId = `media_character_video_${uploadId}`;
  const storageKey =
    `character-videos/${input.characterId}/${uploadId}${input.form.video.extension}`;
  let preparedStored = false;
  let mutationCompleted = false;

  try {
    const result = await executeAtomicIdempotentMutation({
      environment: env.APP_ENV,
      actor: input.actor,
      idempotencyKey: input.idempotencyKey,
      requestId: input.requestId,
      commandType: "character.library_video.upload",
      target: { type: "character", id: input.characterId },
      payload: {
        purpose: input.form.purpose,
        filename: input.form.video.filename,
        contentType: input.form.video.contentType,
        sizeBytes: input.form.video.body.byteLength,
        sha256: input.form.video.sha256,
      },
      prepare: async () => {
        const stored = await providers.blob.putPrivate({
          key: storageKey,
          body: input.form.video.body,
          contentType: input.form.video.contentType,
        });
        if (!stored.ok) {
          throw Errors.unavailable("Video storage failed", stored.error);
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
            type: "video",
            url: mediaViewUrl(assetId, input.form.video.extension),
            storageKey,
            contentType: input.form.video.contentType,
            visibility: "private",
            safetyStatus: "passed",
            metadata: toInputJson({
              purpose: input.form.purpose,
              source: "admin_local_upload",
              filename: input.form.video.filename,
              sizeBytes: input.form.video.body.byteLength,
              sha256: input.form.video.sha256,
              platformAsset: {
                purpose: input.form.purpose,
                status: "generated",
              },
            }),
          },
        });
        await tx.adminAuditLog.create({
          data: {
            actorId: input.actor.id,
            actorRole: input.actor.role,
            action: "character.library_video.uploaded",
            targetType: "media_asset",
            targetId: asset.id,
            reason: "Import a video into the Character library",
            after: toInputJson({
              characterId: input.characterId,
              assetId: asset.id,
              filename: input.form.video.filename,
              contentType: input.form.video.contentType,
              sizeBytes: input.form.video.body.byteLength,
            }),
            requestId: input.requestId,
          },
        });
        return { asset: characterVideoSourceAssetDto(asset) };
      },
      decorateResult: (value, replayed) => ({
        ...(value as Record<string, unknown>),
        replayed,
      }),
    });
    mutationCompleted = true;
    const parsed = characterVideoSourceUploadResponseSchema.parse(result);
    if (parsed.replayed && preparedStored) await deletePreparedBlob(storageKey);
    return parsed;
  } catch (cause) {
    if (!mutationCompleted && preparedStored) await deletePreparedBlob(storageKey);
    throw cause;
  }
}

function characterVideoSourceAssetDto(asset: MediaAsset): CharacterVideoUploadAsset {
  const metadata = jsonObject(asset.metadata);
  return {
    id: asset.id,
    url: asset.url,
    filename: typeof metadata.filename === "string"
      ? metadata.filename
      : `character-video${extensionForContentType(asset.contentType)}`,
    contentType: asset.contentType === "video/webm" ? "video/webm" : "video/mp4",
    sizeBytes: typeof metadata.sizeBytes === "number" && metadata.sizeBytes > 0
      ? Math.trunc(metadata.sizeBytes)
      : 1,
    createdAt: asset.createdAt.toISOString(),
  };
}

async function requireCharacter(characterId: string) {
  const character = await prisma.character.findFirst({
    where: operationalCharacterWhere({ id: characterId, deletedAt: null }),
    select: { id: true },
  });
  if (!character) throw Errors.notFound("Character not found");
}

function supportedVideo(file: File): SupportedVideo | null {
  const extension = file.name.toLowerCase().match(/\.(mp4|webm)$/)?.[1];
  if (file.type === "video/mp4" || (!file.type && extension === "mp4")) {
    return { contentType: "video/mp4", extension: ".mp4" };
  }
  if (file.type === "video/webm" || (!file.type && extension === "webm")) {
    return { contentType: "video/webm", extension: ".webm" };
  }
  return null;
}

function normalizedFilename(filename: string, extension: ".mp4" | ".webm") {
  const withoutExtension = filename.replace(/\.[^.]+$/, "");
  const normalized = withoutExtension
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 170);
  return `${normalized || "character-video"}${extension}`;
}

function extensionForContentType(contentType: string | null) {
  return contentType === "video/webm" ? ".webm" : ".mp4";
}

function mediaViewUrl(assetId: string, extension: string) {
  const token = Buffer.from(assetId, "utf8").toString("base64url");
  return `/user-content/${token}/content${extension}`;
}

async function deletePreparedBlob(storageKey: string) {
  await Promise.allSettled([providers.blob.delete({ key: storageKey })]);
}

function stringField(form: FormData, key: string) {
  const value = form.get(key);
  return typeof value === "string" ? value : "";
}

function jsonObject(value: Prisma.JsonValue): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
