import {
  createCharacterVisualProfile,
  listCharacterVisualProfiles,
} from "@/server/modules/admin-v2/content/visual-profiles";
import { executeAdminMutation } from "@/server/modules/admin-v2/shared/admin-mutation";
import {
  actorWithPermission,
  type AdminV2RequestBody,
} from "@/server/modules/admin-v2/shared/authority";
import { adminV2Route } from "@/server/modules/admin-v2/shared/route-handler";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ id: string }> };
type Body = AdminV2RequestBody<
  "characterVisualProfileCreateRequestSchema+idempotency-key"
>;

export async function GET(request: Request, context: Context) {
  const { id } = await context.params;
  return adminV2Route(request, async () => {
    await actorWithPermission(request, "content.read");
    return listCharacterVisualProfiles(id);
  });
}

export async function POST(request: Request, context: Context) {
  const { id } = await context.params;
  return adminV2Route(request, () =>
    executeAdminMutation<Body>(
      "POST /api/v2/admin/content/characters/:id/visual-profiles",
      request,
      {
        params: { id },
        target: () => ({ type: "character", id }),
        reason: (body) => body.reason,
        mutate: (tx, { actor, body }) =>
          createCharacterVisualProfile({ tx, request, actor, characterId: id, body }),
        decorateResult: (result, replayed) => ({ ...(result as object), replayed }),
      },
    )
  );
}
