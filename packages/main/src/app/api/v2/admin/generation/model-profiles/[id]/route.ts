import { patchGenerationModelProfile } from "@/server/modules/admin-v2/generation/model-profiles";
import { adminV2Route } from "@/server/modules/admin-v2/shared/route-handler";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return adminV2Route(request, () => patchGenerationModelProfile(request, id));
}
