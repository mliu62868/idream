import { bulkPatchContentAssets } from "@/server/modules/admin-v2/content/assets";
import { executeAdminMutation } from "@/server/modules/admin-v2/shared/admin-mutation";
import { adminV2Route } from "@/server/modules/admin-v2/shared/route-handler";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";


export function POST(request: Request) {
  return adminV2Route(request, () =>
    executeAdminMutation(
      "POST /api/v2/admin/assets/bulk",
      request,
      {
        params: {},
        target: ({ body }) => ({
          type: "media_asset_batch",
          id: body.assetIds.join(","),
        }),
        mutate: (tx, { actor, body, requestId }) => bulkPatchContentAssets({
          request,
          actor,
          body,
          tx,
          requestId,
        }),
      },
    )
  );
}
