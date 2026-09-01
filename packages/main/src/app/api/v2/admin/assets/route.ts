import { contentAssetUploadResponseSchema } from "@idream/shared/admin";
import {
  createContentAssetUpload,
  parseContentAssetUpload,
} from "@/server/modules/admin-v2/content/asset-upload";
import { listContentAssets } from "@/server/modules/admin-v2/content/assets";
import {
  actorWithPermission,
  multipartFields,
  queryParams,
} from "@/server/modules/admin-v2/shared/authority";
import { adminV2Route } from "@/server/modules/admin-v2/shared/route-handler";
import { requireIdempotencyKey } from "@/server/modules/admin-v2/shared/idempotency";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function GET(request: Request) {
  return adminV2Route(request, async () => {
    await actorWithPermission(request, "creative.asset.read");
    const query = queryParams(request, "GET /api/v2/admin/assets");
    return listContentAssets(query);
  });
}

export function POST(request: Request) {
  return adminV2Route(request, async () => {
    const actor = await actorWithPermission(request, "content.asset.review");
    const idempotencyKey = requireIdempotencyKey(request);
    const requestId =
      request.headers.get("x-request-id")?.trim() || crypto.randomUUID();
    const multipart = await request.formData();
    const fields = multipartFields(
      request,
      "POST /api/v2/admin/assets",
      {
      purpose: stringField(multipart, "purpose"),
      },
    );
    const form = await parseContentAssetUpload(multipart, fields);
    return contentAssetUploadResponseSchema.parse(
      await createContentAssetUpload({
        actor,
        idempotencyKey,
        requestId,
        form,
      }),
    );
  });
}

function stringField(form: FormData, key: string) {
  const value = form.get(key);
  return typeof value === "string" ? value : "";
}
