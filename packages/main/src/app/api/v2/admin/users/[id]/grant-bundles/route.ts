import {
  adminGrantBundleListSchema,
  adminGrantBundleMutationSchema,
  adminGrantBundleWriteSchema,
} from "@idream/shared/admin";
import { grantUserBundle, listUserGrantBundles } from "@/server/modules/admin-v2/permissions/grant-bundles";
import { adminV2Route } from "@/server/modules/admin-v2/shared/route-handler";
import { actorWithPermission, jsonBody } from "@/server/modules/admin-v2/shared/authority";
import { executeAtomicIdempotentMutation } from "@/server/modules/admin-v2/shared/atomic-mutation";
import { requireIdempotencyKey } from "@/server/modules/admin-v2/shared/idempotency";
import { env } from "@/server/lib/env";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: Context) {
  const { id } = await context.params;
  return adminV2Route(async () => adminGrantBundleListSchema.parse(await listUserGrantBundles(request, id)));
}

export async function POST(request: Request, context: Context) {
  const { id } = await context.params;
  return adminV2Route(async () => {
    const actor = await actorWithPermission(request, "user.role.write");
    const body = adminGrantBundleWriteSchema.parse(await jsonBody(request));
    const idempotencyKey = requireIdempotencyKey(request);
    const requestId = request.headers.get("x-request-id")?.trim() || crypto.randomUUID();
    const result = await executeAtomicIdempotentMutation({
      environment: env.APP_ENV,
      actor,
      idempotencyKey,
      requestId,
      commandType: "admin.grant_bundle.grant",
      target: { type: "admin_user_grant_bundle", id: `${id}:${body.bundleKey}` },
      payload: { userId: id, ...body },
      mutate: async (tx) => adminGrantBundleMutationSchema.parse(await grantUserBundle({
        userId: id,
        actor,
        body,
        requestId,
      }, tx)),
    });
    return Response.json({ ok: true, data: result }, { status: 201 });
  });
}
