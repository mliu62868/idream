import { patchFeatureFlag } from "@/server/modules/admin-v2/config/feature-flags";
import { adminV2Route } from "@/server/modules/admin-v2/shared/route-handler";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function PATCH(request: Request, context: { params: Promise<{ key: string }> }) {
  const { key } = await context.params;
  return adminV2Route(request, () => patchFeatureFlag(request, key));
}
