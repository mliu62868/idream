import {
  adminGrantBundleKeySchema,
  adminGrantBundleMutationSchema,
} from "@idream/shared/admin";
import { revokeUserBundle } from "@/server/modules/admin-v2/permissions/grant-bundles";
import { adminV2Route } from "@/server/modules/admin-v2/shared/route-handler";
import { actorWithPermission, jsonBody } from "@/server/modules/admin-v2/shared/authority";
import { executeAtomicIdempotentMutation } from "@/server/modules/admin-v2/shared/atomic-mutation";
import { requireIdempotencyKey } from "@/server/modules/admin-v2/shared/idempotency";
import { env } from "@/server/lib/env";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
type Context = { params: Promise<{ id: string; bundleKey: string }> };

export async function DELETE(request: Request, context: Context) {
  const params = await context.params;
  return adminV2Route(request, async () => {
    const actor = await actorWithPermission(request, "user.role.write");
    const bundleKey = adminGrantBundleKeySchema.parse(params.bundleKey);
    const body = await jsonBody(request, "adminGrantBundleRevokeSchema+idempotency-key");
    const idempotencyKey = requireIdempotencyKey(request);
    const requestId = request.headers.get("x-request-id")?.trim() || crypto.randomUUID();
    return executeAtomicIdempotentMutation({
      environment: env.APP_ENV,
      actor,
      idempotencyKey,
      requestId,
      commandType: "admin.grant_bundle.revoke",
      target: { type: "admin_user_grant_bundle", id: `${params.id}:${bundleKey}` },
      payload: { userId: params.id, bundleKey, ...body },
      mutate: async (tx) => adminGrantBundleMutationSchema.parse(await revokeUserBundle({
        userId: params.id,
        bundleKey,
        actor,
        body,
        requestId,
      }, tx)),
    });
  });
}
