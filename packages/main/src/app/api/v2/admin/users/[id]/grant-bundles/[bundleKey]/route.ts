import { revokeUserBundle } from "@/server/modules/admin-v2/permissions/grant-bundles";
import { adminV2Route } from "@/server/modules/admin-v2/shared/route-handler";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
type Context = { params: Promise<{ id: string; bundleKey: string }> };

export async function DELETE(request: Request, context: Context) {
  const { id, bundleKey } = await context.params;
  return adminV2Route(() => revokeUserBundle(request, id, bundleKey));
}
