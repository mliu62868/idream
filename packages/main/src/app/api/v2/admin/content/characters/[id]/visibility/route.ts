import { setCharacterVisibility } from "@/server/modules/admin-v2/content/merchandising";
import { executeAdminMutation } from "@/server/modules/admin-v2/shared/admin-mutation";
import type { AdminV2RequestBody } from "@/server/modules/admin-v2/shared/authority";
import { adminV2Route } from "@/server/modules/admin-v2/shared/route-handler";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Context = { params: Promise<{ id: string }> };
type Body = AdminV2RequestBody<
  "contentCharacterVisibilityRequestSchema+idempotency-key"
>;

export async function POST(request: Request, context: Context) {
  const { id } = await context.params;
  return adminV2Route(request, () =>
    executeAdminMutation<Body>(
      "POST /api/v2/admin/content/characters/:id/visibility",
      request,
      {
        params: { id },
        target: () => ({ type: "character", id }),
        reason: (body) => body.reason,
        mutate: (tx, { actor, body, requestId }) =>
          setCharacterVisibility({ tx, request, actor, requestId, id, body }),
        decorateResult: (result, replayed) => ({ ...(result as object), replayed }),
      },
    )
  );
}
