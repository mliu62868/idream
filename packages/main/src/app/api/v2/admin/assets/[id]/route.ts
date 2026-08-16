import type { AdminV2RequestBody } from "@/server/modules/admin-v2/shared/authority";
import {
  getContentAsset,
  patchContentAsset,
} from "@/server/modules/admin-v2/content/assets";
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
    return getContentAsset(id);
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
        mutate: (tx, { actor, body, requestId }) => patchContentAsset({
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
