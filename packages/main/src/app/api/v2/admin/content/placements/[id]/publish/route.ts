import { prepareUploadedPlacement, publishUploadedPlacement } from "@/server/modules/admin-v2/content/placements";
import { executeAdminMutation } from "@/server/modules/admin-v2/shared/admin-mutation";
import { adminV2Route } from "@/server/modules/admin-v2/shared/route-handler";
import { Errors } from "@/server/lib/errors";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return adminV2Route(request, () => executeAdminMutation(
    "POST /api/v2/admin/content/placements/:id/publish", request, {
      params: { id },
      target: () => ({ type: "media_asset_placement", id }),
      prepare: ({ body, expectedVersion }) => {
        if (body.confirmation !== id) throw Errors.badRequest("Confirmation did not match placement");
        return prepareUploadedPlacement(id, expectedVersion);
      },
      mutate: (tx, { actor, body, expectedVersion }, prepared) => {
        if (expectedVersion === undefined) throw Errors.badRequest("If-Match must contain the current Placement version");
        return publishUploadedPlacement({ tx, request, actor, id, expectedVersion, reason: body.reason, prepared });
      },
      decorateResult: (result, replayed) => ({ ...(result as object), replayed }),
    },
  ));
}
