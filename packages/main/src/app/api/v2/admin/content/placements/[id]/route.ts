import {
  getPlacement,
  patchPlacement,
} from "@/server/modules/admin-v2/content/placements";
import { executeAdminMutation } from "@/server/modules/admin-v2/shared/admin-mutation";
import {
  actorWithPermission,
  type AdminV2RequestBody,
} from "@/server/modules/admin-v2/shared/authority";
import { adminV2Route } from "@/server/modules/admin-v2/shared/route-handler";
import { Errors } from "@/server/lib/errors";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ id: string }> };
type Body = AdminV2RequestBody<
  "contentPlacementPatchRequestSchema+idempotency-key+if-match"
>;

export async function GET(request: Request, context: Context) {
  const { id } = await context.params;
  return adminV2Route(request, async () => {
    await actorWithPermission(request, "creative.placement.read");
    return getPlacement(id);
  });
}

export async function PATCH(request: Request, context: Context) {
  const { id } = await context.params;
  return adminV2Route(request, () =>
    executeAdminMutation<Body>("PATCH /api/v2/admin/content/placements/:id", request, {
      params: { id },
      target: () => ({ type: "media_asset_placement", id }),
      reason: (body) => body.reason,
      mutate: (tx, { actor, body, expectedVersion }) => {
        if (expectedVersion === undefined) {
          throw Errors.badRequest("If-Match must contain the current Placement version");
        }
        return patchPlacement({ tx, request, actor, id, expectedVersion, body });
      },
      decorateResult: (result, replayed) => ({ ...(result as object), replayed }),
    })
  );
}
