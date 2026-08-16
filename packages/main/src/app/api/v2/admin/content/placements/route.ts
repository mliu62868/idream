import {
  createPlacement,
  listPlacements,
} from "@/server/modules/admin-v2/content/placements";
import { executeAdminMutation } from "@/server/modules/admin-v2/shared/admin-mutation";
import {
  actorWithPermission,
  queryParams,
  type AdminV2RequestBody,
} from "@/server/modules/admin-v2/shared/authority";
import { adminV2Route } from "@/server/modules/admin-v2/shared/route-handler";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Body = AdminV2RequestBody<
  "contentPlacementCreateRequestSchema+idempotency-key"
>;

export function GET(request: Request) {
  return adminV2Route(request, async () => {
    await actorWithPermission(request, "creative.placement.read");
    return listPlacements(queryParams(request, "GET /api/v2/admin/content/placements"));
  });
}

export function POST(request: Request) {
  return adminV2Route(request, () =>
    executeAdminMutation<Body>("POST /api/v2/admin/content/placements", request, {
      params: {},
      target: ({ body }) => ({ type: "media_asset", id: body.mediaAssetId }),
      reason: (body) => body.reason,
      mutate: (tx, { actor, body }) => createPlacement({ tx, request, actor, body }),
      decorateResult: (result, replayed) => ({ ...(result as object), replayed }),
    })
  );
}
