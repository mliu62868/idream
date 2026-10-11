import { setCharacterVisibility } from "@/server/modules/admin-v2/content/merchandising";
import { executeAdminMutation } from "@/server/modules/admin-v2/shared/admin-mutation";
import { adminV2Route } from "@/server/modules/admin-v2/shared/route-handler";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: Context) {
  const { id } = await context.params;
  return adminV2Route(request, () =>
    executeAdminMutation(
      "POST /api/v2/admin/content/characters/:id/visibility",
      request,
      {
        params: { id },
        target: () => ({ type: "character", id }),
        mutate: (tx, { actor, body, requestId }) =>
          setCharacterVisibility({ tx, request, actor, requestId, id, body }),
        decorateResult: (result, replayed) => ({ ...(result as object), replayed }),
      },
    )
  );
}
