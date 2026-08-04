import type { AdminV2RequestBody } from "@/server/modules/admin-v2/shared/authority";
import {
  getContentAssetV2,
  patchContentAssetV2,
} from "@/server/modules/admin/content/assets";
import { executeAdminMutation } from "@/server/modules/admin-v2/shared/admin-mutation";
import { actorWithPermission } from "@/server/modules/admin-v2/shared/authority";
import { adminV2Route } from "@/server/modules/admin-v2/shared/route-handler";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ id: string }> };
type AssetPatch = AdminV2RequestBody<
  "contentAssetPatchRequestSchema+idempotency-key"
>;

export async function GET(request: Request, context: Context) {
  const { id } = await context.params;
  return adminV2Route(request, async () => {
    await actorWithPermission(request, "creative.asset.read");
    return getContentAssetV2(id);
  });
}

export async function PATCH(request: Request, context: Context) {
  const { id } = await context.params;
  return adminV2Route(request, () =>
    executeAdminMutation<AssetPatch>(
      "PATCH /api/v2/admin/assets/:id",
      request,
      {
        params: { id },
        target: () => ({ type: "media_asset", id }),
        reason: (body) => body.reason,
        mutate: (tx, { actor, body, requestId }) => patchContentAssetV2({
          request,
          id,
          actor,
          body,
          tx,
          requestId,
        }),
      },
    )
  );
}
