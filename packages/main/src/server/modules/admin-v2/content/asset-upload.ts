import { randomUUID } from "node:crypto";
import {
  type ContentAssetUploadRequest,
} from "@idream/shared/admin";
import { env } from "@/server/lib/env";
import { Errors } from "@/server/lib/errors";
import { OPERATOR_UPLOAD_AUTHORITY_SCHEMA } from "@/server/lib/media-asset-authority";
import type { AdminActor } from "@/server/modules/admin-v2/shared/authority";
import { executeAtomicIdempotentMutation } from "@/server/modules/admin-v2/shared/atomic-mutation";
import {
  parseAdminImageUpload,
  type ParsedAdminImageUpload,
} from "@/server/modules/admin-v2/shared/image-upload";
import { toInputJson } from "@/server/modules/admin-v2/shared/prisma-json";
import { providers } from "@/server/providers";
import { getContentAsset } from "./assets";

export type ParsedContentAssetUpload = {
  fields: ContentAssetUploadRequest;
  image: ParsedAdminImageUpload;
};

export async function parseContentAssetUpload(
  form: FormData,
  fields: ContentAssetUploadRequest,
): Promise<ParsedContentAssetUpload> {
  return { fields, image: await parseAdminImageUpload(form) };
}

/**
 * SPEC: non-character operational artwork enters Admin as an already-created image and
 * becomes an approved standalone platform asset; no GenerationJob or Creative Run is invented.
 * INVARIANT: blob write, MediaAsset provenance, audit, and idempotency command converge on
 * one asset ID. A replay returns that same asset and never stores a second blob.
 */
export async function createContentAssetUpload(input: {
  actor: AdminActor;
  idempotencyKey: string;
  requestId: string;
  form: ParsedContentAssetUpload;
}) {
  const uploadId = randomUUID();
  const assetId = `media_platform_upload_${uploadId}`;
  const storageKey =
    `platform-assets/${input.form.fields.purpose}/${uploadId}${input.form.image.extension}`;
  let preparedStored = false;
  let mutationCompleted = false;

  try {
    const mutation = await executeAtomicIdempotentMutation({
      environment: env.APP_ENV,
      actor: input.actor,
      idempotencyKey: input.idempotencyKey,
      requestId: input.requestId,
      commandType: "content.asset.upload",
      target: { type: "content_asset_upload", id: input.idempotencyKey },
      payload: {
        purpose: input.form.fields.purpose,
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
          throw Errors.unavailable("Platform asset storage failed", stored.error);
        }
        preparedStored = true;
        return stored.data;
      },
      mutate: async (tx) => {
        const asset = await tx.mediaAsset.create({
          data: {
            id: assetId,
            ownerId: input.actor.id,
            type: "image",
            url: mediaViewUrl(assetId, input.form.image.extension),
            storageKey,
            contentType: input.form.image.contentType,
            width: input.form.image.width,
            height: input.form.image.height,
            visibility: "private",
            safetyStatus: "passed",
            metadata: toInputJson({
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
                purpose: input.form.fields.purpose,
                status: "approved",
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
            action: "content.asset.upload",
            targetType: "media_asset",
            targetId: asset.id,
            reason: "Import externally created operational artwork",
            after: toInputJson({
              assetId: asset.id,
              purpose: input.form.fields.purpose,
              filename: input.form.image.filename,
              contentType: input.form.image.contentType,
              sizeBytes: input.form.image.body.byteLength,
              sha256: input.form.image.sha256,
              width: input.form.image.width,
              height: input.form.image.height,
              sourceJobId: null,
            }),
            requestId: input.requestId,
          },
        });
        return { assetId: asset.id };
      },
      decorateResult: (value, replayed) => ({
        ...(value as Record<string, unknown>),
        replayed,
      }),
    }) as { assetId?: unknown; replayed?: unknown };
    mutationCompleted = true;
    if (mutation.replayed === true && preparedStored) {
      await deletePreparedBlob(storageKey);
    }
    if (typeof mutation.assetId !== "string") {
      throw Errors.internal("Platform asset upload did not return an asset ID");
    }
    return getContentAsset(mutation.assetId);
  } catch (cause) {
    if (!mutationCompleted && preparedStored) {
      await deletePreparedBlob(storageKey);
    }
    throw cause;
  }
}

async function deletePreparedBlob(storageKey: string) {
  await Promise.allSettled([providers.blob.delete({ key: storageKey })]);
}

function mediaViewUrl(assetId: string, extension: string) {
  const token = Buffer.from(assetId, "utf8").toString("base64url");
  return `/user-content/${token}/content${extension}`;
}
